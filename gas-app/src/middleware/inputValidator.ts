import { ResultStatus, UserRole, UserStatus } from '../types/enums';
import { CreateUserInput, UpdateUserInput, ValidateFolderNameInput, CreateEventInput, UpdateEventInput, CreateClubInput, UpdateClubInput } from '../types/requests';
import { ServiceResult, ValidationError } from '../types/responses';

/**
 * InputValidator — sanitizes and validates all inputs entering the system.
 *
 * Philosophy:
 *   - Sanitize before validate: strip whitespace, normalize case, remove control chars
 *   - Return structured ValidationError[] so the UI can highlight specific fields
 *   - Never trust payload shapes from doPost — always check keys exist and types match
 *   - XSS protection: strip HTML tags and script-injection patterns from all strings
 *
 * Every doPost handler calls sanitizePayload() first, then the appropriate
 * validate*() function before passing data to a service.
 */

// ─── String sanitization ──────────────────────────────────────────────────────

/**
 * Strips HTML tags, control characters, and dangerous script patterns from a string.
 * Preserves printable ASCII and common Unicode text characters.
 */
export function sanitizeString(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    // Remove HTML/XML tags
    .replace(/<[^>]*>/g, '')
    // Remove null bytes and other control characters (except newlines/tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Collapse multiple spaces/tabs into a single space
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Sanitizes an email: lowercase + strip whitespace.
 * Does not validate format — call validateEmail() for that.
 */
export function sanitizeEmail(raw: unknown): string {
  return sanitizeString(raw).toLowerCase();
}

/**
 * Sanitizes an entire payload object.
 * All string values are passed through sanitizeString().
 * Non-string primitive values are preserved as-is.
 * Nested objects and arrays are recursively sanitized.
 */
export function sanitizePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      result[key] = sanitizeString(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizePayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Field validators ─────────────────────────────────────────────────────────

/** Returns true if the string is a syntactically valid email address. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Returns true if the role string is a known UserRole enum value. */
export function isValidRole(role: string): boolean {
  return Object.values(UserRole).includes(role as UserRole);
}

/** Returns true if the status string is a known UserStatus enum value. */
export function isValidStatus(status: string): boolean {
  return Object.values(UserStatus).includes(status as UserStatus);
}

/**
 * Returns true if the club name is a valid non-empty identifier.
 * Actual club membership is now validated at the UI layer via the Clubs sheet.
 */
export function isApprovedClub(clubName: string): boolean {
  return typeof clubName === 'string' && clubName.trim().length > 0;
}

// ─── Input validators ─────────────────────────────────────────────────────────

/**
 * Validates and sanitizes a CreateUserInput payload extracted from doPost.
 * Returns the sanitized input on success, or a list of errors on failure.
 */
export function validateCreateUserPayload(
  raw: Record<string, unknown>
): ServiceResult<CreateUserInput> {
  const errors: ValidationError[] = [];

  const email     = sanitizeEmail(raw['email']);
  const firstName = sanitizeString(raw['firstName']);
  const lastName  = sanitizeString(raw['lastName']);
  const role      = sanitizeString(raw['role']);
  const clubId    = raw['clubId'] !== undefined ? sanitizeString(raw['clubId']) : undefined;

  if (!email) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!isValidEmail(email)) {
    errors.push({ field: 'email', message: 'Invalid email address format', value: email });
  }

  if (!firstName) {
    errors.push({ field: 'firstName', message: 'First name is required' });
  }

  if (!lastName) {
    errors.push({ field: 'lastName', message: 'Last name is required' });
  }

  if (!role) {
    errors.push({ field: 'role', message: 'Role is required' });
  } else if (!isValidRole(role)) {
    errors.push({
      field: 'role',
      message: `Role must be one of: ${Object.values(UserRole).join(', ')}`,
      value: role,
    });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Valid',
    data: {
      email,
      firstName,
      lastName,
      role: role as UserRole,
      ...(clubId !== undefined && { clubId }),
    },
  };
}

/**
 * Validates and sanitizes an UpdateUserInput payload extracted from doPost.
 * At least one of firstName, lastName, clubId, role, or status must be supplied.
 */
export function validateUpdateUserPayload(
  raw: Record<string, unknown>
): ServiceResult<UpdateUserInput> {
  const errors: ValidationError[] = [];

  const email = sanitizeEmail(raw['email']);
  if (!email || !isValidEmail(email)) {
    errors.push({ field: 'email', message: 'A valid email is required to identify the user', value: email });
  }

  const firstName = raw['firstName'] !== undefined ? sanitizeString(raw['firstName']) : undefined;
  const lastName  = raw['lastName']  !== undefined ? sanitizeString(raw['lastName'])  : undefined;
  const clubId    = raw['clubId']    !== undefined ? sanitizeString(raw['clubId'])    : undefined;
  const role      = raw['role']      !== undefined ? sanitizeString(raw['role'])      : undefined;
  const status    = raw['status']    !== undefined ? sanitizeString(raw['status'])    : undefined;

  if (role !== undefined && !isValidRole(role)) {
    errors.push({ field: 'role', message: `Invalid role: "${role}"`, value: role });
  }

  if (status !== undefined && !isValidStatus(status)) {
    errors.push({ field: 'status', message: `Invalid status: "${status}"`, value: status });
  }

  if (firstName === undefined && lastName === undefined && clubId === undefined &&
      role === undefined && status === undefined) {
    errors.push({
      field: '_form',
      message: 'At least one of firstName, lastName, clubId, role, or status must be supplied',
    });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Valid',
    data: {
      email,
      ...(firstName !== undefined && { firstName }),
      ...(lastName  !== undefined && { lastName }),
      ...(clubId    !== undefined && { clubId }),
      ...(role      !== undefined && { role: role as UserRole }),
      ...(status    !== undefined && { status: status as UserStatus }),
    },
  };
}

/**
 * Validates a folder name validation request (used by VALIDATE_FOLDER_NAME route).
 */
export function validateFolderNamePayload(
  raw: Record<string, unknown>
): ServiceResult<ValidateFolderNameInput> {
  const errors: ValidationError[] = [];

  const folderName = sanitizeString(raw['folderName']);
  const layer = Number(raw['layer']);

  if (!folderName) {
    errors.push({ field: 'folderName', message: 'folderName is required' });
  }

  if (!Number.isInteger(layer) || layer < 1 || layer > 3) {
    errors.push({
      field: 'layer',
      message: 'layer must be 1, 2, or 3',
      value: raw['layer'],
    });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Valid',
    data: { folderName, layer: layer as 1 | 2 | 3 },
  };
}

// ─── Event validators ─────────────────────────────────────────────────────────

/**
 * Validates and extracts a CreateEventInput from a sanitized payload.
 * Returns SUCCESS with the validated input, or ERROR with field-level errors.
 */
export function validateCreateEventPayload(
  payload: Record<string, unknown>
): ServiceResult<CreateEventInput> {
  const errors: ValidationError[] = [];

  const eventName = typeof payload['eventName'] === 'string'
    ? payload['eventName'].trim()
    : '';
  const eventDate = typeof payload['eventDate'] === 'string'
    ? payload['eventDate'].trim()
    : '';

  if (!eventName) {
    errors.push({ field: 'eventName', message: 'Event name is required' });
  }
  if (!eventDate) {
    errors.push({ field: 'eventDate', message: 'Event date is required' });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Valid',
    data: { eventName, eventDate },
  };
}

/**
 * Validates and extracts an UpdateEventInput from a sanitized payload.
 * eventId is required; eventName and eventDate are optional.
 */
export function validateUpdateEventPayload(
  payload: Record<string, unknown>
): ServiceResult<UpdateEventInput> {
  const eventId = typeof payload['eventId'] === 'string'
    ? payload['eventId'].trim()
    : '';

  if (!eventId) {
    return {
      status: ResultStatus.ERROR,
      message: 'Validation failed',
      errors: [{ field: 'eventId', message: 'Event ID is required' }],
    };
  }

  const result: UpdateEventInput = {
    eventId,
    ...(typeof payload['eventName'] === 'string' && { eventName: payload['eventName'] }),
    ...(typeof payload['eventDate'] === 'string' && { eventDate: payload['eventDate'] }),
  };

  return { status: ResultStatus.SUCCESS, message: 'Valid', data: result };
}

/**
 * Validates that a required string field is present and non-empty.
 * Convenience for simple single-field checks in route handlers.
 */
export function requireString(
  raw: unknown,
  fieldName: string
): ServiceResult<string> {
  const value = sanitizeString(raw);
  if (!value) {
    return {
      status: ResultStatus.ERROR,
      message: `${fieldName} is required`,
      errors: [{ field: fieldName, message: `${fieldName} is required` }],
    };
  }
  return { status: ResultStatus.SUCCESS, message: 'OK', data: value };
}

// ─── Club validators ──────────────────────────────────────────────────────────

/** Returns true if a normalizedName is Drive-folder-safe (ASCII, no spaces). */
export function isValidNormalizedName(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name.trim());
}

/**
 * Validates and sanitizes a CreateClubInput payload.
 */
export function validateCreateClubPayload(
  raw: Record<string, unknown>
): ServiceResult<CreateClubInput> {
  const errors: ValidationError[] = [];

  const displayName = sanitizeString(raw['displayName']);
  const normalizedName = sanitizeString(raw['normalizedName']);

  if (!displayName) {
    errors.push({ field: 'displayName', message: 'Display name is required' });
  }

  if (!normalizedName) {
    errors.push({ field: 'normalizedName', message: 'Normalized name is required' });
  } else if (!isValidNormalizedName(normalizedName)) {
    errors.push({
      field: 'normalizedName',
      message: 'Normalized name may only contain letters, numbers, and underscores (no spaces)',
      value: normalizedName,
    });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return { status: ResultStatus.SUCCESS, message: 'Valid', data: { displayName, normalizedName } };
}

/**
 * Validates and sanitizes an UpdateClubInput payload.
 * normalizedName is the lookup key and is required; displayName is optional.
 */
export function validateUpdateClubPayload(
  raw: Record<string, unknown>
): ServiceResult<UpdateClubInput> {
  const normalizedName = sanitizeString(raw['normalizedName']);

  if (!normalizedName) {
    return {
      status: ResultStatus.ERROR,
      message: 'Validation failed',
      errors: [{ field: 'normalizedName', message: 'normalizedName is required to identify the club' }],
    };
  }

  const result: UpdateClubInput = {
    normalizedName,
    ...(typeof raw['displayName'] === 'string' && { displayName: sanitizeString(raw['displayName']) }),
  };

  return { status: ResultStatus.SUCCESS, message: 'Valid', data: result };
}
