import { ResultStatus, UserRole, UserStatus } from '../types/enums';
import { UserRecord } from '../types/models';
import { CreateUserInput, UpdateUserInput } from '../types/requests';
import { ServiceResult, PaginatedResult, ValidationError } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, findRowIndex, updateRow } from './sheetService';
import { toUserRecord, fromUserRecord } from '../utils/sheetMapper';
import { toIsoDate } from '../utils/dateFormatter';

/* global Session */

/**
 * UserService — CRUD operations on the Users sheet.
 *
 * Only admins (super_admin / club_admin) are stored here.
 * Volunteers (uploaders) access the system via upload links and are never
 * pre-registered — their Google identity is captured per-session by the upload flow.
 *
 * All public functions return ServiceResult<T> — never throw.
 * Callers (route handlers) check result.status to branch on success/error.
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

function loadAllUsers(): UserRecord[] {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.USERS);
  return rows
    .map(toUserRecord)
    .filter((r): r is UserRecord => r !== null);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Finds a single user by email (case-insensitive).
 * Returns null if not found.
 */
export function findByEmail(email: string): UserRecord | null {
  const normalized = email.trim().toLowerCase();
  return loadAllUsers().find((u) => u.email === normalized) ?? null;
}

/**
 * Returns a paginated list of all users (both active and inactive).
 * Page and pageSize are 1-based.
 */
export function listAll(page = 1, pageSize = 50): PaginatedResult<UserRecord> {
  const all = loadAllUsers();
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, total, page, pageSize };
}

/**
 * Returns all active admin emails (used by emailService for CC lists, etc.)
 */
export function listAllAdminEmails(): string[] {
  return loadAllUsers()
    .filter((u) => u.status === UserStatus.ACTIVE)
    .map((u) => u.email);
}

/**
 * Creates a new user record in the Users sheet.
 *
 * Validation checks:
 *   - Valid email format
 *   - First/last name provided
 *   - Role is a known UserRole (SUPER_ADMIN or CLUB_ADMIN)
 *   - CLUB_ADMIN must have a non-empty clubId
 *   - SUPER_ADMIN must have an empty clubId
 *   - No duplicate email already in the sheet
 *   - A club cannot have two different club admins (one-club-per-admin)
 */
export function createUser(
  input: CreateUserInput,
  adminEmail: string
): ServiceResult<UserRecord> {
  const errors = validateCreateInput(input);
  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  if (findByEmail(normalizedEmail)) {
    return {
      status: ResultStatus.ERROR,
      message: `User "${normalizedEmail}" already exists`,
    };
  }

  const clubId = (input.clubId ?? '').trim();

  // Enforce one-club-per-club-admin
  if (input.role === UserRole.CLUB_ADMIN && clubId) {
    const conflict = loadAllUsers().find(
      (u) =>
        u.role === UserRole.CLUB_ADMIN &&
        u.clubId === clubId &&
        u.status === UserStatus.ACTIVE
    );
    if (conflict) {
      return {
        status: ResultStatus.ERROR,
        message:
          `Club "${clubId}" already has an active club admin (${conflict.email}). ` +
          'Deactivate the existing admin first, or promote this person to super admin.',
      };
    }
  }

  const record: UserRecord = {
    email:       normalizedEmail,
    firstName:   input.firstName.trim(),
    lastName:    input.lastName.trim(),
    role:        input.role,
    status:      UserStatus.ACTIVE,
    clubId,
    addedDate:   toIsoDate(new Date()),
    addedBy:     adminEmail.trim().toLowerCase(),
    lastLoginAt: '',
  };

  const config = getConfig();
  appendRow(config.SHEET_NAMES.USERS, fromUserRecord(record));

  return { status: ResultStatus.SUCCESS, message: 'User created successfully', data: record };
}

/**
 * Updates an existing user's name, role, status, or club.
 * Only supplied fields are changed; omitted fields retain their current value.
 *
 * Returns ERROR if the user does not exist or validation fails.
 */
export function updateUser(
  input: UpdateUserInput,
  _adminEmail: string
): ServiceResult<UserRecord> {
  const existing = findByEmail(input.email);
  if (!existing) {
    return { status: ResultStatus.ERROR, message: `User "${input.email}" not found` };
  }

  const errors: ValidationError[] = [];
  if (input.role !== undefined && !Object.values(UserRole).includes(input.role)) {
    errors.push({ field: 'role', message: 'Invalid role', value: input.role });
  }
  if (input.status !== undefined && !Object.values(UserStatus).includes(input.status)) {
    errors.push({ field: 'status', message: 'Invalid status', value: input.status });
  }
  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  const newRole  = input.role   ?? existing.role;
  const newClubId = input.clubId !== undefined ? input.clubId.trim() : existing.clubId;

  // Enforce one-club-per-club-admin when club is being set/changed
  if (newRole === UserRole.CLUB_ADMIN && newClubId && newClubId !== existing.clubId) {
    const conflict = loadAllUsers().find(
      (u) =>
        u.email  !== existing.email &&
        u.role   === UserRole.CLUB_ADMIN &&
        u.clubId === newClubId &&
        u.status === UserStatus.ACTIVE
    );
    if (conflict) {
      return {
        status: ResultStatus.ERROR,
        message:
          `Club "${newClubId}" already has an active club admin (${conflict.email}). ` +
          'A person cannot be club admin for more than one club.',
      };
    }
  }

  const updated: UserRecord = {
    email:       existing.email,
    firstName:   input.firstName?.trim()  ?? existing.firstName,
    lastName:    input.lastName?.trim()   ?? existing.lastName,
    role:        newRole,
    status:      input.status ?? existing.status,
    clubId:      newRole === UserRole.SUPER_ADMIN ? '' : newClubId,
    addedDate:   existing.addedDate,
    addedBy:     existing.addedBy,
    lastLoginAt: existing.lastLoginAt,
  };

  const config = getConfig();
  const rowIndex = findRowIndex(config.SHEET_NAMES.USERS, 0, existing.email);
  if (rowIndex < 0) {
    return {
      status: ResultStatus.ERROR,
      message: `Could not locate row for "${existing.email}" in the Users sheet`,
    };
  }

  updateRow(config.SHEET_NAMES.USERS, rowIndex, fromUserRecord(updated));

  return { status: ResultStatus.SUCCESS, message: 'User updated successfully', data: updated };
}

/**
 * Records the user's most recent login timestamp.
 * Called on each successful authentication. Non-fatal — update failure is logged
 * but does not block the login.
 */
export function recordLogin(email: string): void {
  const existing = findByEmail(email);
  if (!existing) return;

  const config = getConfig();
  const rowIndex = findRowIndex(config.SHEET_NAMES.USERS, 0, email.trim().toLowerCase());
  if (rowIndex < 0) return;

  const updated: UserRecord = { ...existing, lastLoginAt: new Date().toISOString() };
  updateRow(config.SHEET_NAMES.USERS, rowIndex, fromUserRecord(updated));
}

/**
 * Deactivates a user by setting their status to INACTIVE.
 * The user remains in the sheet for audit purposes.
 *
 * Returns ERROR if the user does not exist or is already inactive.
 */
export function deactivateUser(email: string): ServiceResult<UserRecord> {
  const existing = findByEmail(email);
  if (!existing) {
    return { status: ResultStatus.ERROR, message: `User "${email}" not found` };
  }
  if (existing.status === UserStatus.INACTIVE) {
    return {
      status: ResultStatus.ERROR,
      message: `User "${email}" is already inactive`,
    };
  }

  const adminEmail = Session.getActiveUser().getEmail();
  return updateUser(
    { email: existing.email, status: UserStatus.INACTIVE },
    adminEmail
  );
}

/**
 * Reactivates a previously deactivated user.
 */
export function reactivateUser(email: string): ServiceResult<UserRecord> {
  const existing = findByEmail(email);
  if (!existing) {
    return { status: ResultStatus.ERROR, message: `User "${email}" not found` };
  }
  if (existing.status === UserStatus.ACTIVE) {
    return {
      status: ResultStatus.ERROR,
      message: `User "${email}" is already active`,
    };
  }

  const adminEmail = Session.getActiveUser().getEmail();
  return updateUser(
    { email: existing.email, status: UserStatus.ACTIVE },
    adminEmail
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateCreateInput(input: CreateUserInput): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    errors.push({
      field: 'email',
      message: 'Invalid email address format',
      value: input.email,
    });
  }

  if (!input.firstName || !input.firstName.trim()) {
    errors.push({ field: 'firstName', message: 'First name is required' });
  }

  if (!input.lastName || !input.lastName.trim()) {
    errors.push({ field: 'lastName', message: 'Last name is required' });
  }

  if (!input.role || !Object.values(UserRole).includes(input.role)) {
    errors.push({
      field: 'role',
      message: `Role must be one of: ${Object.values(UserRole).join(', ')}`,
      value: input.role,
    });
  }

  // Club admin must have a clubId; super admin must not
  if (input.role === UserRole.CLUB_ADMIN && !input.clubId?.trim()) {
    errors.push({
      field: 'clubId',
      message: 'clubId is required for club_admin role',
    });
  }
  if (input.role === UserRole.SUPER_ADMIN && input.clubId?.trim()) {
    errors.push({
      field: 'clubId',
      message: 'super_admin cannot be scoped to a club — leave clubId empty',
    });
  }

  return errors;
}
