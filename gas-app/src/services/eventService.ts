import { ResultStatus } from '../types/enums';
import { EventRecord } from '../types/models';
import { CreateEventInput, UpdateEventInput } from '../types/requests';
import { ServiceResult, PaginatedResult, ValidationError } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, findRowIndex, updateRow } from './sheetService';
import { toEventRecord, fromEventRecord } from '../utils/sheetMapper';
import { generateUuid } from '../utils/uuid';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { validateFolderName } from '../utils/folderNameValidator';
import { validateEventName } from '../utils/userNameValidator';
import { createEventFolder } from './driveService';

/**
 * EventService — CRUD operations on the Events sheet.
 *
 * All public functions return ServiceResult<T> — never throw.
 * Callers (route handlers) check result.status to branch on success/error.
 *
 * Data access pattern:
 *   getAllRows() → map(toEventRecord) → filter(non-null) → business logic
 *
 * Write pattern:
 *   build EventRecord → fromEventRecord() → appendRow() or updateRow()
 *
 * Design decisions:
 *   - Folder names are immutable once created (renaming breaks upload logs)
 *   - Drive folder created before sheet write (fail-fast, no orphan records)
 *   - Duplicate detection uses folder name as the unique key
 *   - No delete operation — events may have upload logs referencing them
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns all valid EventRecords from the Events sheet.
 * Malformed rows are silently skipped.
 */
function loadAllEvents(): EventRecord[] {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.EVENTS);
  return rows
    .map(toEventRecord)
    .filter((r): r is EventRecord => r !== null);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Finds a single event by its UUID.
 * Returns null if not found.
 */
export function findById(eventId: string): EventRecord | null {
  return loadAllEvents().find((e) => e.eventId === eventId) ?? null;
}

/**
 * Finds an event by its folder name (YYYY-MM-DD_EventName).
 * Used to detect duplicates before creation.
 */
export function findByFolderName(folderName: string): EventRecord | null {
  return loadAllEvents().find((e) => e.folderName === folderName) ?? null;
}

/**
 * Returns a paginated, sorted list of all events.
 * Default sort: newest event_date first.
 */
export function listAll(
  page = 1,
  pageSize = 20,
  sortDirection: 'asc' | 'desc' = 'desc'
): PaginatedResult<EventRecord> {
  const all = loadAllEvents();
  all.sort((a, b) => {
    const cmp = a.eventDate.localeCompare(b.eventDate);
    return sortDirection === 'desc' ? -cmp : cmp;
  });
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, total, page, pageSize };
}

/**
 * Creates a new event: validates inputs, generates folder name,
 * creates the Drive folder, then writes the record to the Events sheet.
 *
 * This is a multi-step operation. If Drive folder creation fails,
 * no sheet record is written (atomic from the user's perspective).
 *
 * Steps:
 *   1. Validate inputs (name, date)
 *   2. Build folder name: YYYY-MM-DD_Event_Name
 *   3. Check for duplicate folder name in the Events sheet
 *   4. Validate folder name via FolderNameValidator
 *   5. Create folder in Google Drive
 *   6. Write record to Events sheet
 *   7. Return the new EventRecord
 */
export function createEvent(
  input: CreateEventInput,
  adminEmail: string
): ServiceResult<EventRecord> {
  // 1. Validate inputs
  const errors = validateCreateInput(input);
  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  // 2. Build folder name
  const normalizedName = input.eventName.trim().replace(/\s+/g, '_');
  const folderName = `${input.eventDate}_${normalizedName}`;

  // 3. Duplicate check
  const existing = findByFolderName(folderName);
  if (existing) {
    return {
      status: ResultStatus.ERROR,
      message: `An event with folder name "${folderName}" already exists (ID: ${existing.eventId})`,
    };
  }

  // 4. Validate folder name against Layer 1 rules
  const folderValidation = validateFolderName({
    folderName,
    layer: 1,
  });
  if (!folderValidation.isValid) {
    return {
      status: ResultStatus.ERROR,
      message: `Generated folder name "${folderName}" failed validation`,
      errors: folderValidation.violations.map((v) => ({
        field: 'folderName',
        message: v,
        value: folderName,
      })),
    };
  }

  // 5. Create Drive folder
  const driveResult = createEventFolder(folderName);
  if (driveResult.status !== ResultStatus.SUCCESS || !driveResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: driveResult.message,
    };
  }

  // 6. Build and write record
  const record: EventRecord = {
    eventId: generateUuid(),
    eventName: input.eventName.trim(),
    eventDate: input.eventDate,
    folderName,
    driveFolderId: driveResult.data.folderId,
    createdBy: adminEmail.trim().toLowerCase(),
    createdAt: nowIsoTimestamp(),
  };

  const config = getConfig();
  appendRow(config.SHEET_NAMES.EVENTS, fromEventRecord(record));

  return {
    status: ResultStatus.SUCCESS,
    message: `Event "${record.eventName}" created with folder "${folderName}"`,
    data: record,
  };
}

/**
 * Updates an existing event's metadata (name, date).
 * Does NOT rename the Drive folder — folder names are immutable.
 *
 * Returns ERROR if the event does not exist.
 */
export function updateEvent(
  input: UpdateEventInput,
  _adminEmail: string
): ServiceResult<EventRecord> {
  const existing = findById(input.eventId);
  if (!existing) {
    return {
      status: ResultStatus.ERROR,
      message: `Event "${input.eventId}" not found`,
    };
  }

  const errors: ValidationError[] = [];
  if (input.eventDate !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(input.eventDate)) {
      errors.push({
        field: 'eventDate',
        message: 'Date must be YYYY-MM-DD format',
        value: input.eventDate,
      });
    } else {
      // Calendar date validation (e.g. reject Feb 30)
      const [y, m, d] = input.eventDate.split('-').map(Number);
      const parsed = new Date(y, m - 1, d);
      if (
        parsed.getFullYear() !== y ||
        parsed.getMonth() !== m - 1 ||
        parsed.getDate() !== d
      ) {
        errors.push({
          field: 'eventDate',
          message: 'Event date is not a valid calendar date',
          value: input.eventDate,
        });
      }
    }
  }
  if (input.eventName !== undefined) {
    // Apply the same Unicode-aware character rules as event creation.
    const nameResult = validateEventName(input.eventName);
    if (!nameResult.isValid) {
      for (const message of nameResult.errors) {
        errors.push({ field: 'eventName', message, value: nameResult.trimmed });
      }
    }
  }
  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  const updated: EventRecord = {
    eventId: existing.eventId,
    eventName: input.eventName?.trim() ?? existing.eventName,
    eventDate: input.eventDate ?? existing.eventDate,
    folderName: existing.folderName,          // Immutable
    driveFolderId: existing.driveFolderId,    // Immutable
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
  };

  const config = getConfig();
  const rowIndex = findRowIndex(config.SHEET_NAMES.EVENTS, 0, existing.eventId);
  if (rowIndex < 0) {
    return {
      status: ResultStatus.ERROR,
      message: `Could not locate row for event "${existing.eventId}" in the Events sheet`,
    };
  }

  updateRow(config.SHEET_NAMES.EVENTS, rowIndex, fromEventRecord(updated));

  return {
    status: ResultStatus.SUCCESS,
    message: `Event "${updated.eventName}" updated`,
    data: updated,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates the fields for event creation.
 * Returns field-level errors (empty = valid).
 *
 * Event-name character rules are owned by validateEventName() in
 * userNameValidator.ts — that's the single source of truth so the UI, the
 * server-side handler, and the folder-name builder all enforce the same set.
 */
export function validateCreateInput(input: CreateEventInput): ValidationError[] {
  const errors: ValidationError[] = [];

  // Event name — delegated to the shared validator (Unicode-friendly).
  const nameResult = validateEventName(input.eventName);
  if (!nameResult.isValid) {
    for (const message of nameResult.errors) {
      errors.push({ field: 'eventName', message, value: nameResult.trimmed });
    }
  }

  // Event date
  const date = input.eventDate?.trim() ?? '';
  if (!date) {
    errors.push({ field: 'eventDate', message: 'Event date is required' });
  } else if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) {
    errors.push({
      field: 'eventDate',
      message: 'Event date must be a valid YYYY-MM-DD string',
      value: date,
    });
  } else {
    // Calendar date validation (e.g. reject Feb 30)
    const [y, m, d] = date.split('-').map(Number);
    const parsed = new Date(y, m - 1, d);
    if (
      parsed.getFullYear() !== y ||
      parsed.getMonth() !== m - 1 ||
      parsed.getDate() !== d
    ) {
      errors.push({
        field: 'eventDate',
        message: 'Event date is not a valid calendar date',
        value: date,
      });
    }
  }

  return errors;
}
