import { ResultStatus } from '../types/enums';
import { ClubRecord } from '../types/models';
import { CreateClubInput, UpdateClubInput } from '../types/requests';
import { ServiceResult, PaginatedResult, ValidationError } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, findRowIndex, updateRow, ensureHeaders } from './sheetService';
import { toClubRecord, fromClubRecord } from '../utils/sheetMapper';
import { toIsoDate } from '../utils/dateFormatter';

/**
 * ClubService — CRUD operations on the Clubs sheet.
 *
 * Clubs are the authoritative source for which running clubs exist in the system.
 * Admins manage clubs from the admin UI; changes take effect immediately without
 * a code deploy (unlike the old static APPROVED_CLUBS constant).
 *
 * Sheet headers: displayName | normalizedName | status | addedDate | addedBy
 *
 * Design decisions:
 *   - normalizedName is immutable once created (Drive club folders depend on it)
 *   - Clubs are deactivated, not deleted (referential integrity with Upload_Log)
 *   - Clubs are managed entirely via the admin UI; no static seed list
 */

const CLUB_HEADERS = ['displayName', 'normalizedName', 'status', 'addedDate', 'addedBy'];

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sheetName(): string {
  return getConfig().SHEET_NAMES.CLUBS;
}

/**
 * Returns all valid ClubRecords from the Clubs sheet.
 * If the sheet is empty, seeds it from the legacy static APPROVED_CLUBS list.
 */
function loadAllClubs(): ClubRecord[] {
  const name = sheetName();
  ensureHeaders(name, CLUB_HEADERS);
  const rows = getAllRows(name);
  return rows
    .map(toClubRecord)
    .filter((r): r is ClubRecord => r !== null);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns all clubs (active and inactive), paginated.
 */
export function listAll(page = 1, pageSize = 50): PaginatedResult<ClubRecord> {
  const all = loadAllClubs();
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, total, page, pageSize };
}

/**
 * Returns only active clubs, suitable for populating dropdowns.
 */
export function listActive(): ClubRecord[] {
  return loadAllClubs().filter((c) => c.status === 'active');
}

/**
 * Finds a club by its normalizedName (case-sensitive).
 */
export function findByNormalizedName(normalizedName: string): ClubRecord | null {
  return loadAllClubs().find((c) => c.normalizedName === normalizedName) ?? null;
}

/**
 * Creates a new club record in the Clubs sheet.
 *
 * Validation:
 *   - displayName and normalizedName must be non-empty
 *   - normalizedName must be unique (no duplicate club identifiers)
 */
export function createClub(
  input: CreateClubInput,
  adminEmail: string
): ServiceResult<ClubRecord> {
  const errors = validateCreateInput(input);
  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  // Duplicate normalizedName check
  const existing = findByNormalizedName(input.normalizedName);
  if (existing) {
    return {
      status: ResultStatus.ERROR,
      message: `A club with normalizedName "${input.normalizedName}" already exists`,
    };
  }

  const record: ClubRecord = {
    displayName: input.displayName.trim(),
    normalizedName: input.normalizedName.trim(),
    status: 'active',
    addedDate: toIsoDate(new Date()),
    addedBy: adminEmail.trim().toLowerCase(),
  };

  appendRow(sheetName(), fromClubRecord(record));

  return {
    status: ResultStatus.SUCCESS,
    message: `Club "${record.displayName}" (${record.normalizedName}) created`,
    data: record,
  };
}

/**
 * Updates the displayName of an existing club.
 * normalizedName is immutable — changing it would break Drive folder links.
 */
export function updateClub(
  input: UpdateClubInput,
  _adminEmail: string
): ServiceResult<ClubRecord> {
  const existing = findByNormalizedName(input.normalizedName);
  if (!existing) {
    return {
      status: ResultStatus.ERROR,
      message: `Club "${input.normalizedName}" not found`,
    };
  }

  const errors: ValidationError[] = [];
  if (input.displayName !== undefined && !input.displayName.trim()) {
    errors.push({ field: 'displayName', message: 'Display name cannot be empty' });
  }
  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  const updated: ClubRecord = {
    displayName: input.displayName?.trim() ?? existing.displayName,
    normalizedName: existing.normalizedName, // immutable
    status: existing.status,
    addedDate: existing.addedDate,
    addedBy: existing.addedBy,
  };

  const name = sheetName();
  const rowIndex = findRowIndex(name, 1 /* NORMALIZED_NAME col */, existing.normalizedName);
  if (rowIndex < 0) {
    return {
      status: ResultStatus.ERROR,
      message: `Could not locate row for club "${existing.normalizedName}" in the Clubs sheet`,
    };
  }

  updateRow(name, rowIndex, fromClubRecord(updated));

  return {
    status: ResultStatus.SUCCESS,
    message: `Club "${updated.displayName}" updated`,
    data: updated,
  };
}

/**
 * Deactivates a club — sets status to "inactive".
 * The club remains in the sheet for audit purposes.
 */
export function deactivateClub(normalizedName: string): ServiceResult<ClubRecord> {
  const existing = findByNormalizedName(normalizedName);
  if (!existing) {
    return {
      status: ResultStatus.ERROR,
      message: `Club "${normalizedName}" not found`,
    };
  }

  if (existing.status === 'inactive') {
    return {
      status: ResultStatus.ERROR,
      message: `Club "${normalizedName}" is already inactive`,
    };
  }

  const updated: ClubRecord = { ...existing, status: 'inactive' };
  const name = sheetName();
  const rowIndex = findRowIndex(name, 1, normalizedName);
  if (rowIndex < 0) {
    return {
      status: ResultStatus.ERROR,
      message: `Could not locate row for club "${normalizedName}" in the Clubs sheet`,
    };
  }

  updateRow(name, rowIndex, fromClubRecord(updated));

  return {
    status: ResultStatus.SUCCESS,
    message: `Club "${existing.displayName}" deactivated`,
    data: updated,
  };
}

/**
 * Reactivates a previously deactivated club.
 */
export function reactivateClub(normalizedName: string): ServiceResult<ClubRecord> {
  const existing = findByNormalizedName(normalizedName);
  if (!existing) {
    return {
      status: ResultStatus.ERROR,
      message: `Club "${normalizedName}" not found`,
    };
  }

  if (existing.status === 'active') {
    return {
      status: ResultStatus.ERROR,
      message: `Club "${normalizedName}" is already active`,
    };
  }

  const updated: ClubRecord = { ...existing, status: 'active' };
  const name = sheetName();
  const rowIndex = findRowIndex(name, 1, normalizedName);
  if (rowIndex < 0) {
    return {
      status: ResultStatus.ERROR,
      message: `Could not locate row for club "${normalizedName}" in the Clubs sheet`,
    };
  }

  updateRow(name, rowIndex, fromClubRecord(updated));

  return {
    status: ResultStatus.SUCCESS,
    message: `Club "${existing.displayName}" reactivated`,
    data: updated,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateCreateInput(input: CreateClubInput): ValidationError[] {
  const errors: ValidationError[] = [];

  const displayName = input.displayName?.trim() ?? '';
  const normalizedName = input.normalizedName?.trim() ?? '';

  if (!displayName) {
    errors.push({ field: 'displayName', message: 'Display name is required' });
  }

  if (!normalizedName) {
    errors.push({ field: 'normalizedName', message: 'Normalized name is required' });
  } else if (!/^[A-Za-z0-9_]+$/.test(normalizedName)) {
    errors.push({
      field: 'normalizedName',
      message: 'Normalized name may only contain letters, numbers, and underscores',
      value: normalizedName,
    });
  }

  return errors;
}
