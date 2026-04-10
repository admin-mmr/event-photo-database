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
 * All public functions return ServiceResult<T> — never throw.
 * Callers (route handlers) check result.status to branch on success/error.
 *
 * Data access pattern:
 *   getAllRows() → map(toUserRecord) → filter(non-null) → business logic
 *
 * Write pattern:
 *   build UserRecord → fromUserRecord() → appendRow() or updateRow()
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns all valid UserRecords from the Users sheet.
 * Malformed rows are silently skipped (logged in sheetMapper).
 */
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
 * Creates a new user record in the Users sheet.
 *
 * Validation checks:
 *   - Valid email format
 *   - Running club provided
 *   - Role is a known UserRole
 *   - No duplicate email already in the sheet
 *
 * The admin email is pulled from the active GAS session.
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

  const record: UserRecord = {
    email: normalizedEmail,
    runningClub: input.runningClub.trim(),
    role: input.role,
    status: UserStatus.ACTIVE,
    addedDate: toIsoDate(new Date()),
    addedBy: adminEmail.trim().toLowerCase(),
  };

  const config = getConfig();
  appendRow(config.SHEET_NAMES.USERS, fromUserRecord(record));

  return { status: ResultStatus.SUCCESS, message: 'User created successfully', data: record };
}

/**
 * Updates an existing user's club, role, or status.
 * Only supplied fields are changed; omitted fields retain their current value.
 *
 * Returns ERROR if the user does not exist or the sheet row cannot be located.
 */
export function updateUser(
  input: UpdateUserInput,
  _adminEmail: string
): ServiceResult<UserRecord> {
  const existing = findByEmail(input.email);
  if (!existing) {
    return { status: ResultStatus.ERROR, message: `User "${input.email}" not found` };
  }

  // Validate any new values
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

  const updated: UserRecord = {
    email: existing.email,
    runningClub: input.runningClub?.trim() ?? existing.runningClub,
    role: input.role ?? existing.role,
    status: input.status ?? existing.status,
    addedDate: existing.addedDate,
    addedBy: existing.addedBy,
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

/**
 * Validates the fields for a new user creation.
 * Returns a list of field-level ValidationError objects (empty = valid).
 */
export function validateCreateInput(input: CreateUserInput): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    errors.push({
      field: 'email',
      message: 'Invalid email address format',
      value: input.email,
    });
  }

  if (!input.runningClub || !input.runningClub.trim()) {
    errors.push({
      field: 'runningClub',
      message: 'Running club is required',
    });
  }

  if (!input.role || !Object.values(UserRole).includes(input.role)) {
    errors.push({
      field: 'role',
      message: `Role must be one of: ${Object.values(UserRole).join(', ')}`,
      value: input.role,
    });
  }

  return errors;
}
