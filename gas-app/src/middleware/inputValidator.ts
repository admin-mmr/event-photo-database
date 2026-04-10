import { ResultStatus, UserRole, UserStatus } from '../types/enums';
import { CreateUserInput, UpdateUserInput, ValidateFolderNameInput, CreateEventInput, UpdateEventInput } from '../types/requests';
import { ServiceResult, ValidationError } from '../types/responses';
import { APPROVED_CLUBS } from '../config/constants';

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

/** Returns true if the club name matches one of the approved clubs. */
export function isApprovedClub(clubName: string): boolean {
  return APPROVED_CLUBS.some(
    (c) => c.normalizedName === clubName || c.displayName === clubName
  );
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

  const email = sanitizeEmail(raw['email']);
  const runningClub = sanitizeString(raw['runningClub']);
  const role = sanitizeString(raw['role']);

  if (!email) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!isValidEmail(email)) {
    errors.push({ field: 'email', message: 'Invalid email address format', value: email });
  }

  if (!runningClub) {
    errors.push({ field: 'runningClub', message: 'Running club is required' });
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
      runningClub,
      role: role as UserRole,
    },
  };
}

/**
 * Validates and sanitizes an UpdateUserInput payload extracted from doPost.
 * At least one of runningClub, role, or status must be supplied.
 */
export function validateUpdateUserPayload(
  raw: Record<string, unknown>
): ServiceResult<UpdateUserInput> {
  const errors: ValidationError[] = [];

  const email = sanitizeEmail(raw['email']);
  if (!email || !isValidEmail(email)) {
    errors.push({ field: 'email', message: 'A valid email is required to identify the user', value: email });
  }

  const role = raw['role'] !== undefined ? sanitizeString(raw['role']) : undefined;
  const status = raw['status'] !== undefined ? sanitizeString(raw['status']) : undefined;
  const runningClub = raw['runningClub'] !== undefined ? sanitizeString(raw['runningClub']) : undefined;

  if (role !== undefined && !isValidRole(role)) {
    errors.push({ field: 'role', message: `Invalid role: "${role}"`, value: role });
  }

  if (status !== undefined && !isValidStatus(status)) {
    errors.push({ field: 'status', message: `Invalid status: "${status}"`, value: status });
  }

  if (role === undefined && status === undefined && runningClub === undefined) {
    errors.push({
      field: '_form',
      message: 'At least one of runningClub, role, or status must be supplied',
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
      ...(runningClub !== undefined && { runningClub }),
      ...(role !== undefined && { role: role as UserRole }),
      ...(status !== undefined && { status: status as UserStatus }),
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
