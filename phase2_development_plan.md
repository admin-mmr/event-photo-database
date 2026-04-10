# Phase 2 — Event Management: Detailed Development Plan

**Project**: 湘舍动公益文件系统 v1.0 (GAS)
**Phase**: 2 of 5 — Event Management
**Timeline**: Week 2–3
**Goal**: Admins can create, browse, and manage events. Each event creates a validated master folder in Google Drive and records metadata in the Events sheet. Exception detection scans the Drive hierarchy for naming violations on every operation.

---

## 1. Phase 1 Recap — What We're Building On

Phase 1 delivered the foundation. Phase 2 adds the first real domain feature on top of it. Here is what already exists that Phase 2 will consume directly:

### 1.1 Types Already Defined

| Type | File | Status |
|------|------|--------|
| `EventRecord` | `src/types/models.ts` | Complete — all 7 fields defined |
| `CreateEventInput` | `src/types/requests.ts` | Complete — `eventName` + `eventDate` |
| `RouteAction.ADMIN_EVENTS` | `src/types/enums.ts` | Defined but not wired to any handler |
| `COLUMNS.EVENTS` | `src/config/constants.ts` | Complete — all 7 column indices mapped |

### 1.2 Services Already Implemented

| Function | File | What It Does |
|----------|------|-------------|
| `createEventFolder(folderName)` | `driveService.ts` | Creates a Layer 1 folder in the root, returns `{ folderId, folderName }` |
| `listEventFolders()` | `driveService.ts` | Lists all Layer 1 folders sorted alphabetically |
| `getOrCreateClubFolder(eventFolderId, clubName)` | `driveService.ts` | Idempotent Layer 2 club folder creation |
| `createBatchFolder(clubFolderId, batchName)` | `driveService.ts` | Creates Layer 3 upload batch folder |
| `findSubfolder(parent, name)` | `driveService.ts` | Checks if a named subfolder exists |
| `validateFolderName(input)` | `folderNameValidator.ts` | Validates all 3 folder layers via regex + date check |

### 1.3 UI Already Stubbed

The dashboard (`dashboard.html`) already has an "Events" tile at line 67–73 that links to `?action=admin_events` (admin-only). The route action `ADMIN_EVENTS` exists in the enum but returns a 404 because no handler is registered.

### 1.4 What Phase 2 Must Add

```
New files:
  src/services/eventService.ts       — CRUD for Events sheet
  src/ui/templates/admin/events.html — Admin events page (list + create form)
  tests/unit/eventService.test.ts    — Unit tests for event CRUD

Modified files:
  src/types/enums.ts                 — Add CREATE_EVENT, UPDATE_EVENT, LIST_EVENTS route actions
  src/types/requests.ts              — Add UpdateEventInput
  src/types/responses.ts             — Add EventListResult
  src/utils/sheetMapper.ts           — Verify/extend existing toEventRecord / fromEventRecord
  src/middleware/inputValidator.ts    — Add event payload validators
  src/routes/router.ts               — Register event routes (GET + POST)
  src/routes/pageRoutes.ts           — Add adminEventsPage handler
  src/routes/apiRoutes.ts            — Add event API handlers
  src/main.ts                        — Add serverCreateEvent, serverListEvents
  src/config/constants.ts            — Add event-related config (max name length, etc.)
  src/services/driveService.ts       — Add scanFolderViolations (exception detection)
  tests/mocks/gasGlobals.ts          — Extend mocks for event sheet operations
  tests/unit/sheetMapper.test.ts     — Add EventRecord roundtrip tests
```

---

## 2. New & Modified Type Definitions

### 2.1 New Route Actions — src/types/enums.ts

Add these to the existing `RouteAction` enum:

```typescript
export enum RouteAction {
  // ... existing Phase 1 actions ...

  // Phase 2 — Event Management
  CREATE_EVENT = 'create_event',
  UPDATE_EVENT = 'update_event',
  LIST_EVENTS = 'list_events',
}
```

`ADMIN_EVENTS` (the page route) already exists. The three new entries are API actions for doPost.

### 2.2 New Request DTO — src/types/requests.ts

`CreateEventInput` already exists. Add `UpdateEventInput`:

```typescript
/**
 * Input DTO for updating an existing event (admin-only, Phase 2).
 * Only eventName and eventDate can be modified — the folder name
 * and Drive folder are immutable once created.
 */
export interface UpdateEventInput {
  readonly eventId: string;        // Lookup key — UUID from Events sheet
  readonly eventName?: string;     // New display name (does NOT rename Drive folder)
  readonly eventDate?: string;     // New date string "YYYY-MM-DD"
}
```

**Design decision**: Updating an event changes only the sheet metadata (display name, date). The Drive folder name is immutable — renaming folders in Google Drive would break existing upload logs and bookmarks. If an admin truly needs a different folder name, they must create a new event.

### 2.3 New Response Types — src/types/responses.ts

```typescript
/**
 * Extended event info returned in list views.
 * Combines EventRecord with derived data from Drive.
 */
export interface EventListItem {
  readonly event: EventRecord;
  readonly clubFolderCount: number;    // How many clubs have folders under this event
  readonly driveUrl: string;           // Direct link to the Drive folder
}

/**
 * Response shape for the list_events API.
 */
export interface EventListResult {
  readonly events: ReadonlyArray<EventListItem>;
  readonly total: number;
}
```

### 2.4 Exception Detection Types — src/types/responses.ts

```typescript
/**
 * A naming violation detected in the Drive folder hierarchy.
 * Stored in memory per scan — not persisted to a sheet in Phase 2.
 * Phase 4 will add a dedicated Violations sheet.
 */
export interface FolderViolation {
  readonly folderName: string;
  readonly folderId: string;
  readonly parentFolderName: string;
  readonly layer: 1 | 2;
  readonly violationType: string;    // Human-readable description
  readonly detectedAt: string;       // ISO 8601 timestamp
}
```

---

## 3. Event Service — src/services/eventService.ts

This is the core new module. It follows the same patterns established in `userService.ts`: all public functions return `ServiceResult<T>`, never throw, and validate before writing.

```typescript
import { ResultStatus } from '../types/enums';
import { EventRecord } from '../types/models';
import { CreateEventInput, UpdateEventInput } from '../types/requests';
import { ServiceResult, PaginatedResult, ValidationError } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, findRowIndex, updateRow } from './sheetService';
import { toEventRecord, fromEventRecord } from '../utils/sheetMapper';
import { generateUuid } from '../utils/uuid';
import { toIsoDate, nowIsoTimestamp } from '../utils/dateFormatter';
import { validateFolderName } from '../utils/folderNameValidator';
import { createEventFolder } from './driveService';

/* global Session */

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
    }
  }
  if (input.eventName !== undefined) {
    const trimmed = input.eventName.trim();
    if (!trimmed || trimmed.length > 100) {
      errors.push({
        field: 'eventName',
        message: 'Event name is required (max 100 characters)',
        value: input.eventName,
      });
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
 */
export function validateCreateInput(input: CreateEventInput): ValidationError[] {
  const errors: ValidationError[] = [];

  // Event name
  const name = input.eventName?.trim() ?? '';
  if (!name) {
    errors.push({ field: 'eventName', message: 'Event name is required' });
  } else if (name.length > 100) {
    errors.push({
      field: 'eventName',
      message: 'Event name must be 100 characters or fewer',
      value: name,
    });
  } else if (/[^A-Za-z0-9\s]/.test(name)) {
    errors.push({
      field: 'eventName',
      message: 'Event name may only contain letters, numbers, and spaces',
      value: name,
    });
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
```

### 3.1 Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Folder name is immutable** | Renaming Drive folders breaks existing Upload_Log records that reference the folder. If the display name needs updating, only the Events sheet changes. |
| **Duplicate detection by folder name** | Two events on the same date with the same name would collide in Drive. Checking the sheet is faster than scanning Drive (O(n) rows vs API call). |
| **Drive folder created before sheet write** | If the Drive API fails, we want zero side effects. If the sheet write fails after Drive creation, the orphan folder is harmless and discoverable by exception detection. |
| **Event name allows only letters, numbers, spaces** | Spaces are converted to underscores for the folder name. Special characters would break the Layer 1 regex or cause encoding issues in Drive. |
| **No delete operation** | Events are never deleted — they may have upload logs referencing them. Phase 4 may add an "archived" status. |

---

## 4. Sheet Mapper — src/utils/sheetMapper.ts (Already Exists)

Phase 1 already implemented `toEventRecord` and `fromEventRecord`. Phase 2 **consumes** these as-is. No changes needed to sheetMapper.ts unless testing reveals edge cases.

The existing implementation maps the 7-column Events sheet row to/from `EventRecord`:

```
Column order: event_id | event_name | event_date | folder_name | drive_folder_id | created_by | created_at
```

**Phase 2 action**: Write additional unit tests (Section 10.4) to verify roundtrip behavior and edge cases for event records specifically. The Phase 1 tests covered `toUserRecord` thoroughly but may not have covered `toEventRecord` with equal rigor.

---

## 5. Input Validation — src/middleware/inputValidator.ts

Add these validation functions alongside the existing user payload validators:

```typescript
import { CreateEventInput, UpdateEventInput } from '../types/requests';
import { ServiceResult, ValidationError } from '../types/responses';
import { ResultStatus } from '../types/enums';

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
```

---

## 6. Route Wiring

### 6.1 Router Changes — src/routes/router.ts

Add the event routes to both GET and POST route tables:

```typescript
// Add to GET_ROUTES
const GET_ROUTES: Readonly<Record<string, RouteConfig>> = {
  // ... existing routes ...
  [RouteAction.ADMIN_EVENTS]: { requiredRole: UserRole.ADMIN },
};

// Add to POST_ROUTES
const POST_ROUTES: Readonly<Record<string, RouteConfig>> = {
  // ... existing routes ...
  [RouteAction.CREATE_EVENT]:  { requiredRole: UserRole.ADMIN },
  [RouteAction.UPDATE_EVENT]:  { requiredRole: UserRole.ADMIN },
  [RouteAction.LIST_EVENTS]:   { requiredRole: null },  // All users can list events
};
```

Add to `dispatchGetHandler`:

```typescript
function dispatchGetHandler(action: RouteAction, user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  switch (action) {
    // ... existing cases ...
    case RouteAction.ADMIN_EVENTS:
      return adminEventsPage(user);
    default:
      return notFoundPage(action);
  }
}
```

Add to `dispatchPostHandler`:

```typescript
function dispatchPostHandler(
  action: RouteAction,
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  switch (action) {
    // ... existing cases ...
    case RouteAction.CREATE_EVENT:
      return handleCreateEvent(payload, user);
    case RouteAction.UPDATE_EVENT:
      return handleUpdateEvent(payload, user);
    case RouteAction.LIST_EVENTS:
      return handleListEvents(payload);
    default:
      return handleUnknownAction(action);
  }
}
```

### 6.2 API Route Handlers — src/routes/apiRoutes.ts

```typescript
import {
  validateCreateEventPayload,
  validateUpdateEventPayload,
} from '../middleware/inputValidator';
import {
  createEvent,
  updateEvent,
  listAll as listAllEvents,
} from '../services/eventService';

/**
 * POST action=create_event
 * Admin-only. Creates a new event with a Drive folder.
 */
export function handleCreateEvent(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateCreateEventPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = createEvent(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('already exists') ? 409 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=update_event
 * Admin-only. Updates event metadata (name, date).
 */
export function handleUpdateEvent(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateUpdateEventPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = updateEvent(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=list_events
 * Available to all authenticated users.
 * Accepts optional { page, pageSize, sort } parameters.
 */
export function handleListEvents(
  payload: Record<string, unknown>
): GoogleAppsScript.Content.TextOutput {
  const page = Number(payload['page']) || 1;
  const pageSize = Math.min(Number(payload['pageSize']) || 20, 100);
  const sort = (payload['sort'] === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

  const result = listAllEvents(page, pageSize, sort);
  return jsonOk(result, `Found ${result.total} event(s)`);
}
```

### 6.3 Page Route Handler — src/routes/pageRoutes.ts

```typescript
/**
 * Renders the Admin Events page.
 * Pre-loads the initial event list into the template for fast first paint.
 * Subsequent interactions (create, filter, paginate) use google.script.run.
 */
export function adminEventsPage(
  user: UserRecord
): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile('ui/templates/admin/events');
  template.userEmail = user.email;
  template.userRole = user.role;
  template.isAdmin = user.role === UserRole.ADMIN;

  // Pre-load first page of events for instant display
  const events = listAllEvents(1, 20, 'desc');
  template.events = JSON.stringify(events.items);
  template.totalEvents = events.total;

  return template.evaluate()
    .setTitle('Events — 湘舍动公益文件系统')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

### 6.4 Server Functions — src/main.ts

Add alongside the existing `serverCreateUser` / `serverUpdateUser` functions:

```typescript
import {
  createEvent,
  updateEvent,
  listAll as listAllEvents,
} from './services/eventService';

/**
 * google.script.run entry point for creating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateEvent(
  payload: { eventName: string; eventDate: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = createEvent(
      { eventName: payload.eventName, eventDate: payload.eventDate },
      auth.adminEmail
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverCreateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating event' };
  }
}

/**
 * google.script.run entry point for updating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateEvent(
  payload: { eventId: string; eventName?: string; eventDate?: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = updateEvent(
      {
        eventId: payload.eventId,
        ...(payload.eventName !== undefined && { eventName: payload.eventName }),
        ...(payload.eventDate !== undefined && { eventDate: payload.eventDate }),
      },
      auth.adminEmail
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverUpdateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating event' };
  }
}

/**
 * google.script.run entry point for listing events.
 * Available to all users (role check happens at route level, not here).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListEvents(
  payload: { page?: number; pageSize?: number; sort?: string; dateFrom?: string; dateTo?: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const page = payload.page ?? 1;
    const pageSize = Math.min(payload.pageSize ?? 20, 100);
    const sort = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

    const result = listAllEvents(page, pageSize, sort);

    // Optional client-side date range filter
    let filtered = result.items;
    if (payload.dateFrom) {
      filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    }
    if (payload.dateTo) {
      filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    }

    return {
      status: 'success',
      message: `Found ${filtered.length} event(s)`,
      data: { items: filtered, total: filtered.length, page, pageSize },
    };
  } catch (err) {
    Logger.log(`serverListEvents error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing events' };
  }
}
```

---

## 7. Exception Detection — src/services/driveService.ts

Exception detection scans Layer 1 and Layer 2 folders for naming convention violations. In Phase 2, this runs on-demand when an admin loads the events page or creates an event. Phase 4 will add scheduled scans and email alerts.

Add to the existing `driveService.ts`:

```typescript
import { FolderViolation } from '../types/responses';
import { validateFolderName } from '../utils/folderNameValidator';
import { APPROVED_CLUBS } from '../config/constants';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/**
 * Scans the root folder for Layer 1 naming violations.
 * Returns an array of violations (empty = all clean).
 *
 * Checks:
 *   - Folder name matches YYYY-MM-DD_Title_Case_Name pattern
 *   - Date portion is a valid calendar date
 *
 * Performance: This makes one Drive API call (list root's children).
 * For a system with <100 events, this completes well within the 6-minute limit.
 */
export function scanLayer1Violations(): ServiceResult<FolderViolation[]> {
  try {
    const root = getRootFolder();
    const iter = root.getFolders();
    const violations: FolderViolation[] = [];
    const now = nowIsoTimestamp();

    while (iter.hasNext()) {
      const folder = iter.next();
      const name = folder.getName();
      const result = validateFolderName({ folderName: name, layer: 1 });

      if (!result.isValid) {
        violations.push({
          folderName: name,
          folderId: folder.getId(),
          parentFolderName: root.getName(),
          layer: 1,
          violationType: result.violations.join('; '),
          detectedAt: now,
        });
      }
    }

    return {
      status: ResultStatus.SUCCESS,
      message: `Scanned Layer 1: ${violations.length} violation(s) found`,
      data: violations,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Layer 1 scan failed: ${String(err)}`,
    };
  }
}

/**
 * Scans all club subfolders within a specific event folder for Layer 2 violations.
 * Checks that each subfolder name matches an approved club name.
 *
 * @param eventFolderId  Drive ID of the Layer 1 event folder to scan
 */
export function scanLayer2Violations(
  eventFolderId: string
): ServiceResult<FolderViolation[]> {
  try {
    const parentResult = getFolderById(eventFolderId);
    if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
      return { status: ResultStatus.ERROR, message: parentResult.message };
    }

    const eventFolder = parentResult.data;
    const iter = eventFolder.getFolders();
    const violations: FolderViolation[] = [];
    const approvedNames = APPROVED_CLUBS.map((c) => c.normalizedName);
    const now = nowIsoTimestamp();

    while (iter.hasNext()) {
      const folder = iter.next();
      const name = folder.getName();

      // Layer 2 check: must be an approved club name
      const nameValid = validateFolderName({ folderName: name, layer: 2 });
      const isApproved = approvedNames.includes(name);

      if (!nameValid.isValid || !isApproved) {
        const reasons: string[] = [];
        if (!nameValid.isValid) {
          reasons.push(...nameValid.violations);
        }
        if (!isApproved) {
          reasons.push(`"${name}" is not in the approved clubs list`);
        }
        violations.push({
          folderName: name,
          folderId: folder.getId(),
          parentFolderName: eventFolder.getName(),
          layer: 2,
          violationType: reasons.join('; '),
          detectedAt: now,
        });
      }
    }

    return {
      status: ResultStatus.SUCCESS,
      message: `Scanned Layer 2 in "${eventFolder.getName()}": ${violations.length} violation(s)`,
      data: violations,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Layer 2 scan failed: ${String(err)}`,
    };
  }
}

/**
 * Runs a full scan of Layer 1 + Layer 2 across all event folders.
 * Combines results from scanLayer1Violations and scanLayer2Violations.
 *
 * WARNING: This makes N+1 Drive API calls (1 for root + 1 per event folder).
 * For large systems, consider caching or running this on a schedule.
 */
export function scanAllViolations(): ServiceResult<FolderViolation[]> {
  const allViolations: FolderViolation[] = [];

  // Layer 1 scan
  const layer1Result = scanLayer1Violations();
  if (layer1Result.status === ResultStatus.SUCCESS && layer1Result.data) {
    allViolations.push(...layer1Result.data);
  }

  // Layer 2 scan for each event folder
  const foldersResult = listEventFolders();
  if (foldersResult.status === ResultStatus.SUCCESS && foldersResult.data) {
    for (const folder of foldersResult.data) {
      const layer2Result = scanLayer2Violations(folder.id);
      if (layer2Result.status === ResultStatus.SUCCESS && layer2Result.data) {
        allViolations.push(...layer2Result.data);
      }
    }
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Full scan complete: ${allViolations.length} total violation(s)`,
    data: allViolations,
  };
}
```

---

## 8. Admin Events UI — src/ui/templates/admin/events.html

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Events — 湘舍动公益文件系统</title>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/icon?family=Material+Icons">
  <link rel="stylesheet"
    href="https://code.getmdl.io/1.3.0/material.indigo-pink.min.css">
  <?!= HtmlService.createHtmlOutputFromFile('ui/css/styles').getContent() ?>
</head>
<body>
  <div class="mdl-layout mdl-js-layout mdl-layout--fixed-header">
    <header class="mdl-layout__header">
      <div class="mdl-layout__header-row">
        <a href="?action=dashboard" class="mdl-layout-title"
           style="color:inherit;text-decoration:none;">
          湘舍动公益文件系统
        </a>
        <div class="mdl-layout-spacer"></div>
        <nav class="mdl-navigation">
          <a class="mdl-navigation__link" href="?action=admin_users">
            <i class="material-icons" style="vertical-align:middle;margin-right:4px;">group</i>
            Users
          </a>
          <a class="mdl-navigation__link mdl-navigation__link--current" href="?action=admin_events">
            <i class="material-icons" style="vertical-align:middle;margin-right:4px;">event</i>
            Events
          </a>
        </nav>
        <span class="mdl-chip" style="margin-left:12px;">
          <span class="mdl-chip__text"><?= userEmail ?></span>
        </span>
      </div>
    </header>

    <main class="mdl-layout__content">
      <div class="page-content">

        <!-- Page header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h4 style="margin:0;">Event Management</h4>
          <button class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored"
                  id="btn-toggle-create"
                  onclick="toggleCreateForm()">
            <i class="material-icons" style="vertical-align:middle;margin-right:4px;">add</i>
            New Event
          </button>
        </div>

        <!-- Create event form (collapsed by default) -->
        <div id="create-event-form" class="card" style="display:none;margin-bottom:24px;">
          <h5 style="margin:0 0 16px;">Create New Event</h5>
          <form onsubmit="handleCreateEvent(event)">
            <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label" style="width:100%;max-width:400px;">
              <input type="text" id="event-name" class="mdl-textfield__input"
                     pattern="[A-Za-z0-9\s]+" maxlength="100" required>
              <label class="mdl-textfield__label" for="event-name">Event Name</label>
              <span class="field-error" id="error-eventName"></span>
            </div>
            <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label" style="width:100%;max-width:200px;">
              <input type="date" id="event-date" class="mdl-textfield__input" required>
              <label class="mdl-textfield__label" for="event-date">Event Date</label>
              <span class="field-error" id="error-eventDate"></span>
            </div>
            <div id="folder-preview" class="folder-preview" style="display:none;margin:12px 0;">
              <i class="material-icons" style="vertical-align:middle;color:#666;">folder</i>
              <span id="folder-preview-text" style="font-family:monospace;margin-left:4px;"></span>
            </div>
            <div style="margin-top:16px;">
              <button type="submit" class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored"
                      id="btn-create-event">
                Create Event
              </button>
              <button type="button" class="mdl-button mdl-js-button"
                      onclick="toggleCreateForm()">
                Cancel
              </button>
              <div class="spinner hidden" id="create-event-spinner"></div>
            </div>
          </form>
        </div>

        <!-- Filter bar -->
        <div class="card" style="padding:12px 16px;margin-bottom:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
          <div class="mdl-textfield mdl-js-textfield" style="width:auto;padding:0;">
            <input type="date" id="filter-date-from" class="mdl-textfield__input"
                   onchange="filterEvents()" style="width:150px;">
            <label class="mdl-textfield__label" for="filter-date-from">From</label>
          </div>
          <span style="color:#999;">—</span>
          <div class="mdl-textfield mdl-js-textfield" style="width:auto;padding:0;">
            <input type="date" id="filter-date-to" class="mdl-textfield__input"
                   onchange="filterEvents()" style="width:150px;">
            <label class="mdl-textfield__label" for="filter-date-to">To</label>
          </div>
          <button class="mdl-button mdl-js-button mdl-button--icon"
                  onclick="clearFilters()" title="Clear filters">
            <i class="material-icons">clear</i>
          </button>
          <div class="mdl-layout-spacer"></div>
          <span id="event-count" class="mdl-color-text--grey-600" style="font-size:14px;">
            <?= totalEvents ?> event(s)
          </span>
        </div>

        <!-- Violations banner (hidden by default, shown if scan finds issues) -->
        <div id="violations-banner" class="card" style="display:none;background:#FFF3E0;border-left:4px solid #FF9800;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <i class="material-icons" style="color:#FF9800;">warning</i>
            <span id="violations-text" style="font-size:14px;"></span>
            <button class="mdl-button mdl-js-button mdl-button--accent" onclick="showViolationDetails()"
                    style="margin-left:auto;">
              View Details
            </button>
          </div>
        </div>

        <!-- Events table -->
        <table class="mdl-data-table mdl-js-data-table mdl-shadow--2dp full-width">
          <thead>
            <tr>
              <th class="mdl-data-table__cell--non-numeric sortable"
                  onclick="toggleSort('eventDate')">
                Date <i class="material-icons sort-icon" id="sort-icon-date">arrow_downward</i>
              </th>
              <th class="mdl-data-table__cell--non-numeric">Event Name</th>
              <th class="mdl-data-table__cell--non-numeric">Folder Name</th>
              <th class="mdl-data-table__cell--non-numeric">Created By</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="events-table-body">
            <!-- Populated by JavaScript from pre-loaded data -->
          </tbody>
        </table>
        <div class="pagination" id="events-pagination"></div>

      </div>
    </main>

    <div id="toast-container" aria-live="polite" aria-atomic="false"></div>
  </div>

  <script defer src="https://code.getmdl.io/1.3.0/material.min.js"></script>
  <?!= HtmlService.createHtmlOutputFromFile('ui/js/app').getContent() ?>

  <script>
    // ─── State ────────────────────────────────────────────────────────────────
    let events = JSON.parse('<?!= events ?>');
    let currentSort = 'desc';
    let currentPage = 1;
    const PAGE_SIZE = 20;

    // ─── Init ─────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function() {
      renderEvents(events);
      runViolationScan();
      setupFolderPreview();
    });

    // ─── Create form ──────────────────────────────────────────────────────────
    function toggleCreateForm() {
      const form = document.getElementById('create-event-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }

    function setupFolderPreview() {
      const nameInput = document.getElementById('event-name');
      const dateInput = document.getElementById('event-date');
      function update() {
        const name = nameInput.value.trim().replace(/\s+/g, '_');
        const date = dateInput.value;
        const preview = document.getElementById('folder-preview');
        const text = document.getElementById('folder-preview-text');
        if (name && date) {
          text.textContent = date + '_' + name;
          preview.style.display = 'block';
        } else {
          preview.style.display = 'none';
        }
      }
      nameInput.addEventListener('input', update);
      dateInput.addEventListener('input', update);
    }

    function handleCreateEvent(e) {
      e.preventDefault();
      clearErrors(document.getElementById('create-event-form'));

      const payload = {
        eventName: document.getElementById('event-name').value.trim(),
        eventDate: document.getElementById('event-date').value,
      };

      callServer('serverCreateEvent', [payload], 'btn-create-event', 'create-event-spinner')
        .then(function(result) {
          if (result.status === 'success') {
            showToast('Event created: ' + result.data.eventName, 'success');
            events.unshift(result.data);
            renderEvents(events);
            toggleCreateForm();
            document.getElementById('event-name').value = '';
            document.getElementById('event-date').value = '';
            document.getElementById('folder-preview').style.display = 'none';
          } else {
            showToast(result.message, 'error');
            if (result.errors) showFieldErrors(result.errors, 'create-event-form');
          }
        });
    }

    // ─── Table rendering ──────────────────────────────────────────────────────
    function renderEvents(list) {
      const tbody = document.getElementById('events-table-body');
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="mdl-data-table__cell--non-numeric" ' +
          'style="text-align:center;color:#999;padding:32px;">No events yet. ' +
          'Click "New Event" to create one.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(function(ev) {
        var driveUrl = 'https://drive.google.com/drive/folders/' + ev.driveFolderId;
        return '<tr>' +
          '<td class="mdl-data-table__cell--non-numeric">' + ev.eventDate + '</td>' +
          '<td class="mdl-data-table__cell--non-numeric"><strong>' + escHtml(ev.eventName) + '</strong></td>' +
          '<td class="mdl-data-table__cell--non-numeric"><code>' + escHtml(ev.folderName) + '</code></td>' +
          '<td class="mdl-data-table__cell--non-numeric">' + escHtml(ev.createdBy) + '</td>' +
          '<td>' +
            '<a href="' + driveUrl + '" target="_blank" rel="noopener" ' +
              'class="mdl-button mdl-js-button mdl-button--icon" title="Open in Drive">' +
              '<i class="material-icons">folder_open</i></a>' +
            '<button class="mdl-button mdl-js-button mdl-button--icon" title="Edit" ' +
              'onclick="editEvent(\'' + ev.eventId + '\')">' +
              '<i class="material-icons">edit</i></button>' +
          '</td></tr>';
      }).join('');
      document.getElementById('event-count').textContent = list.length + ' event(s)';
    }

    function escHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    // ─── Sorting ──────────────────────────────────────────────────────────────
    function toggleSort(field) {
      currentSort = currentSort === 'desc' ? 'asc' : 'desc';
      var icon = document.getElementById('sort-icon-date');
      icon.textContent = currentSort === 'desc' ? 'arrow_downward' : 'arrow_upward';
      events.sort(function(a, b) {
        var cmp = a[field].localeCompare(b[field]);
        return currentSort === 'desc' ? -cmp : cmp;
      });
      renderEvents(events);
    }

    // ─── Filtering ────────────────────────────────────────────────────────────
    function filterEvents() {
      var from = document.getElementById('filter-date-from').value;
      var to = document.getElementById('filter-date-to').value;
      var filtered = events.filter(function(ev) {
        if (from && ev.eventDate < from) return false;
        if (to && ev.eventDate > to) return false;
        return true;
      });
      renderEvents(filtered);
    }

    function clearFilters() {
      document.getElementById('filter-date-from').value = '';
      document.getElementById('filter-date-to').value = '';
      renderEvents(events);
    }

    // ─── Edit (inline) ───────────────────────────────────────────────────────
    function editEvent(eventId) {
      var ev = events.find(function(e) { return e.eventId === eventId; });
      if (!ev) return;
      var newName = prompt('Edit event name:', ev.eventName);
      if (newName === null || newName.trim() === ev.eventName) return;

      callServer('serverUpdateEvent', [{ eventId: eventId, eventName: newName.trim() }])
        .then(function(result) {
          if (result.status === 'success') {
            var idx = events.findIndex(function(e) { return e.eventId === eventId; });
            if (idx >= 0) events[idx] = result.data;
            renderEvents(events);
            showToast('Event updated', 'success');
          } else {
            showToast(result.message, 'error');
          }
        });
    }

    // ─── Violation scan ───────────────────────────────────────────────────────
    function runViolationScan() {
      google.script.run
        .withSuccessHandler(function(result) {
          if (result.status === 'success' && result.data && result.data.length > 0) {
            var banner = document.getElementById('violations-banner');
            var text = document.getElementById('violations-text');
            text.textContent = result.data.length + ' naming violation(s) detected in the Drive folder hierarchy.';
            banner.style.display = 'block';
            window._violations = result.data;
          }
        })
        .withFailureHandler(function() { /* Silently ignore scan errors */ })
        .serverScanViolations();
    }

    function showViolationDetails() {
      if (!window._violations) return;
      var msg = window._violations.map(function(v) {
        return 'Layer ' + v.layer + ': "' + v.folderName + '" — ' + v.violationType;
      }).join('\n');
      alert('Naming Violations:\n\n' + msg);
    }
  </script>
</body>
</html>
```

### 8.1 UI Design Principles

Following Phase 1's design patterns:

| Principle | Implementation |
|-----------|---------------|
| **Progressive disclosure** | Create form starts collapsed. Click "New Event" to expand. |
| **Folder name preview** | As the admin types name + date, the generated folder name appears in real time — no surprises. |
| **Inline validation** | Field errors appear below each input, not in modal alerts. |
| **Loading states** | Spinner + disabled button during `serverCreateEvent` call. |
| **Sort & filter** | Date column is sortable (click header). Date range filter for large event lists. |
| **Direct Drive access** | Each event row has a folder icon that opens the Drive folder in a new tab. |
| **Exception alerts** | Violations banner appears at the top if the background scan finds issues. |
| **No destructive actions** | Events cannot be deleted (by design). Edit only changes the display name. |

---

## 9. Configuration Additions — src/config/constants.ts

```typescript
/**
 * Phase 2 additions to the config.
 */

/** Maximum characters for an event name before folder name generation */
export const MAX_EVENT_NAME_LENGTH = 100;

/** Characters allowed in event names (pre-underscore conversion) */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9\s]+$/;

/** Default page size for event listing */
export const DEFAULT_EVENT_PAGE_SIZE = 20;

/** Maximum page size to prevent abuse */
export const MAX_EVENT_PAGE_SIZE = 100;
```

---

## 10. Test Architecture

### 10.1 New Test Files

```
tests/
├── unit/
│   ├── eventService.test.ts         — Event CRUD, validation, folder name generation
│   └── sheetMapper.test.ts          — Add EventRecord section (extends existing file)
├── integration/
│   └── eventCreation.test.ts        — End-to-end: validate → create folder → write sheet
└── mocks/
    └── gasGlobals.ts                — Extend with Events sheet mock data
```

### 10.2 Mock Data Extensions — tests/mocks/gasGlobals.ts

```typescript
// Add to existing mock setup:

const mockEventsSheetData = [
  [
    'evt-001', 'NYC Marathon', '2025-11-03', '2025-11-03_NYC_Marathon',
    'folder-id-001', 'admin@mmrunners.org', '2025-10-15T10:00:00Z',
  ],
  [
    'evt-002', 'Boston Marathon', '2025-04-21', '2025-04-21_Boston_Marathon',
    'folder-id-002', 'admin@mmrunners.org', '2025-03-01T09:00:00Z',
  ],
  [
    'evt-003', 'Christmas Fun Run', '2025-12-25', '2025-12-25_Christmas_Fun_Run',
    'folder-id-003', 'admin@mmrunners.org', '2025-12-01T14:00:00Z',
  ],
];

// Update mockSpreadsheet.getSheetByName to return different sheets:
mockSpreadsheet.getSheetByName.mockImplementation((name: string) => {
  if (name === 'Events') {
    return {
      ...mockSheet,
      getDataRange: jest.fn().mockReturnValue({
        getValues: jest.fn().mockReturnValue(mockEventsSheetData),
      }),
      getLastRow: jest.fn().mockReturnValue(mockEventsSheetData.length + 1), // +1 for header
    };
  }
  return mockSheet; // Default to Users sheet mock
});

// Add mock for event folder creation
mockFolder.createFolder.mockImplementation((name: string) => ({
  getId: jest.fn().mockReturnValue('new-folder-' + name),
  getName: jest.fn().mockReturnValue(name),
}));
```

### 10.3 Unit Tests — tests/unit/eventService.test.ts

```typescript
import { mockSheet, mockSpreadsheet, mockFolder, mockDriveApp } from '../mocks/gasGlobals';
import { ResultStatus, UserRole } from '../../src/types/enums';

// Import from eventService (adjust path based on module setup)

describe('EventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-establish mock data
    // ... (see mock setup in 10.2)
  });

  // ─── findById ──────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the event record for a known UUID', () => {
      const event = EventService.findById('evt-001');
      expect(event).not.toBeNull();
      expect(event!.eventName).toBe('NYC Marathon');
    });

    it('returns null for an unknown UUID', () => {
      expect(EventService.findById('evt-999')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(EventService.findById('')).toBeNull();
    });
  });

  // ─── findByFolderName ──────────────────────────────────────────────────────

  describe('findByFolderName', () => {
    it('returns the event for a known folder name', () => {
      const event = EventService.findByFolderName('2025-11-03_NYC_Marathon');
      expect(event).not.toBeNull();
      expect(event!.eventId).toBe('evt-001');
    });

    it('returns null for a non-existent folder name', () => {
      expect(EventService.findByFolderName('2025-01-01_No_Such_Event')).toBeNull();
    });
  });

  // ─── listAll ───────────────────────────────────────────────────────────────

  describe('listAll', () => {
    it('returns all events sorted by date descending (default)', () => {
      const result = EventService.listAll();
      expect(result.total).toBe(3);
      expect(result.items[0].eventDate).toBe('2025-12-25'); // Most recent first
      expect(result.items[2].eventDate).toBe('2025-04-21'); // Oldest last
    });

    it('sorts ascending when requested', () => {
      const result = EventService.listAll(1, 20, 'asc');
      expect(result.items[0].eventDate).toBe('2025-04-21');
    });

    it('paginates correctly', () => {
      const result = EventService.listAll(1, 2);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.pageSize).toBe(2);
    });

    it('returns empty items for out-of-range page', () => {
      const result = EventService.listAll(99, 20);
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(3);
    });
  });

  // ─── createEvent ───────────────────────────────────────────────────────────

  describe('createEvent', () => {
    it('creates event with valid inputs', () => {
      const result = EventService.createEvent(
        { eventName: 'Spring Relay', eventDate: '2026-03-15' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(result.data!.folderName).toBe('2026-03-15_Spring_Relay');
      expect(result.data!.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it('converts spaces to underscores in folder name', () => {
      const result = EventService.createEvent(
        { eventName: 'NYC Half Marathon', eventDate: '2026-03-15' },
        'admin@mmrunners.org'
      );
      expect(result.data!.folderName).toBe('2026-03-15_NYC_Half_Marathon');
    });

    it('rejects empty event name', () => {
      const result = EventService.createEvent(
        { eventName: '', eventDate: '2026-03-15' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].field).toBe('eventName');
    });

    it('rejects empty event date', () => {
      const result = EventService.createEvent(
        { eventName: 'Test', eventDate: '' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventDate');
    });

    it('rejects invalid date format', () => {
      const result = EventService.createEvent(
        { eventName: 'Test', eventDate: '15-03-2026' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('rejects impossible date (Feb 30)', () => {
      const result = EventService.createEvent(
        { eventName: 'Test', eventDate: '2026-02-30' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].message).toContain('valid calendar date');
    });

    it('rejects special characters in event name', () => {
      const result = EventService.createEvent(
        { eventName: 'NYC Marathon!', eventDate: '2026-03-15' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventName');
    });

    it('rejects event name over 100 characters', () => {
      const longName = 'A'.repeat(101);
      const result = EventService.createEvent(
        { eventName: longName, eventDate: '2026-03-15' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('rejects duplicate folder name', () => {
      const result = EventService.createEvent(
        { eventName: 'NYC Marathon', eventDate: '2025-11-03' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
    });

    it('normalizes admin email to lowercase', () => {
      const result = EventService.createEvent(
        { eventName: 'Test', eventDate: '2026-06-01' },
        'Admin@MMRunners.org'
      );
      expect(result.data!.createdBy).toBe('admin@mmrunners.org');
    });

    it('writes to the Events sheet on success', () => {
      EventService.createEvent(
        { eventName: 'Test Event', eventDate: '2026-06-01' },
        'admin@mmrunners.org'
      );
      expect(mockSheet.appendRow).toHaveBeenCalledTimes(1);
    });

    it('does NOT write to sheet if Drive folder creation fails', () => {
      mockFolder.createFolder.mockImplementationOnce(() => {
        throw new Error('Drive quota exceeded');
      });
      const result = EventService.createEvent(
        { eventName: 'Test', eventDate: '2026-06-01' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(mockSheet.appendRow).not.toHaveBeenCalled();
    });
  });

  // ─── updateEvent ───────────────────────────────────────────────────────────

  describe('updateEvent', () => {
    it('updates event name for existing event', () => {
      jest.spyOn(SheetService, 'findRowIndex').mockReturnValue(1);
      const result = EventService.updateEvent(
        { eventId: 'evt-001', eventName: 'NYC Marathon 2025' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventName).toBe('NYC Marathon 2025');
      expect(result.data!.folderName).toBe('2025-11-03_NYC_Marathon'); // Unchanged!
    });

    it('returns ERROR for non-existent event', () => {
      const result = EventService.updateEvent(
        { eventId: 'evt-999', eventName: 'Nope' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('rejects invalid date on update', () => {
      const result = EventService.updateEvent(
        { eventId: 'evt-001', eventDate: 'not-a-date' },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventDate');
    });

    it('preserves unchanged fields', () => {
      jest.spyOn(SheetService, 'findRowIndex').mockReturnValue(1);
      const result = EventService.updateEvent(
        { eventId: 'evt-001', eventName: 'Updated Name' },
        'admin@mmrunners.org'
      );
      expect(result.data!.eventDate).toBe('2025-11-03');   // Preserved
      expect(result.data!.createdBy).toBe('admin@mmrunners.org'); // Preserved
    });
  });

  // ─── validateCreateInput ───────────────────────────────────────────────────

  describe('validateCreateInput', () => {
    it('returns empty errors for valid input', () => {
      const errors = EventService.validateCreateInput({
        eventName: 'Good Name',
        eventDate: '2026-03-15',
      });
      expect(errors).toHaveLength(0);
    });

    it('returns multiple errors when both fields are invalid', () => {
      const errors = EventService.validateCreateInput({
        eventName: '',
        eventDate: '',
      });
      expect(errors).toHaveLength(2);
      expect(errors.map((e) => e.field)).toContain('eventName');
      expect(errors.map((e) => e.field)).toContain('eventDate');
    });

    it('accepts single-word event name', () => {
      const errors = EventService.validateCreateInput({
        eventName: 'Christmas',
        eventDate: '2026-12-25',
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts event name with numbers', () => {
      const errors = EventService.validateCreateInput({
        eventName: 'Run4Fun 2026',
        eventDate: '2026-06-01',
      });
      expect(errors).toHaveLength(0);
    });
  });
});
```

### 10.4 Sheet Mapper Tests — tests/unit/sheetMapper.test.ts (additions)

```typescript
describe('SheetMapper — EventRecord', () => {
  describe('toEventRecord', () => {
    it('maps a complete row to EventRecord', () => {
      const row = [
        'evt-001', 'NYC Marathon', '2025-11-03', '2025-11-03_NYC_Marathon',
        'folder-id', 'admin@mmrunners.org', '2025-10-15T10:00:00Z',
      ];
      const record = SheetMapper.toEventRecord(row);
      expect(record).not.toBeNull();
      expect(record!.eventId).toBe('evt-001');
      expect(record!.eventName).toBe('NYC Marathon');
      expect(record!.folderName).toBe('2025-11-03_NYC_Marathon');
    });

    it('returns null for row with fewer than 7 columns', () => {
      expect(SheetMapper.toEventRecord(['evt-001', 'Name'])).toBeNull();
    });

    it('returns null for empty eventId', () => {
      expect(SheetMapper.toEventRecord(['', 'Name', '2025-01-01', 'folder', 'id', 'by', 'at'])).toBeNull();
    });

    it('returns null for empty eventName', () => {
      expect(SheetMapper.toEventRecord(['id', '', '2025-01-01', 'folder', 'id', 'by', 'at'])).toBeNull();
    });

    it('trims whitespace from all fields', () => {
      const row = [
        '  evt-001  ', '  NYC Marathon  ', '2025-11-03', '  2025-11-03_NYC_Marathon  ',
        '  folder-id  ', '  admin@mmrunners.org  ', '  2025-10-15T10:00:00Z  ',
      ];
      const record = SheetMapper.toEventRecord(row);
      expect(record!.eventId).toBe('evt-001');
      expect(record!.eventName).toBe('NYC Marathon');
    });

    it('roundtrips through fromEventRecord', () => {
      const original = {
        eventId: 'evt-001',
        eventName: 'NYC Marathon',
        eventDate: '2025-11-03',
        folderName: '2025-11-03_NYC_Marathon',
        driveFolderId: 'folder-id',
        createdBy: 'admin@mmrunners.org',
        createdAt: '2025-10-15T10:00:00Z',
      };
      const row = SheetMapper.fromEventRecord(original);
      const restored = SheetMapper.toEventRecord(row);
      expect(restored).toEqual(original);
    });
  });
});
```

### 10.5 Integration Test — tests/integration/eventCreation.test.ts

```typescript
describe('Event Creation Pipeline (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up fresh mock state for each test
  });

  it('validates → creates Drive folder → writes to Events sheet', () => {
    const result = EventService.createEvent(
      { eventName: 'Integration Test Run', eventDate: '2026-07-04' },
      'admin@mmrunners.org'
    );

    // 1. Verify validation passed
    expect(result.status).toBe(ResultStatus.SUCCESS);

    // 2. Verify Drive folder was created
    expect(mockFolder.createFolder).toHaveBeenCalledWith('2026-07-04_Integration_Test_Run');

    // 3. Verify sheet row was written
    expect(mockSheet.appendRow).toHaveBeenCalledTimes(1);
    const appendedRow = mockSheet.appendRow.mock.calls[0][0];
    expect(appendedRow[1]).toBe('Integration Test Run');  // eventName
    expect(appendedRow[3]).toBe('2026-07-04_Integration_Test_Run'); // folderName
  });

  it('aborts sheet write when Drive creation fails', () => {
    mockFolder.createFolder.mockImplementationOnce(() => {
      throw new Error('Simulated Drive failure');
    });

    const result = EventService.createEvent(
      { eventName: 'Will Fail', eventDate: '2026-01-01' },
      'admin@mmrunners.org'
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(mockSheet.appendRow).not.toHaveBeenCalled();
  });

  it('prevents creating events with duplicate folder names', () => {
    // First creation succeeds
    EventService.createEvent(
      { eventName: 'Unique Event', eventDate: '2026-08-01' },
      'admin@mmrunners.org'
    );

    // Second creation with same name + date fails
    const result = EventService.createEvent(
      { eventName: 'Unique Event', eventDate: '2026-08-01' },
      'admin@mmrunners.org'
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('already exists');
  });
});
```

### 10.6 Test Coverage Targets

| Module | Min Branch % | Min Line % | Key Test Scenarios |
|--------|-------------|------------|---------------------|
| eventService | 90% | 95% | CRUD happy paths, duplicates, validation errors, Drive failures |
| sheetMapper (event) | 95% | 100% | Roundtrip, malformed rows, empty fields, whitespace |
| inputValidator (event) | 90% | 95% | Missing fields, invalid date, special chars, edge cases |
| driveService (scans) | 80% | 85% | Layer 1 violations, Layer 2 violations, approved club check |
| router (event routes) | 85% | 90% | Route dispatch, role check, unknown actions |

### 10.7 Contract Tests (Run in GAS)

```typescript
/**
 * Contract test: verify EventService can read the Events sheet.
 * Run via: clasp run contractTestReadEvents
 */
function contractTestReadEvents(): void {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.EVENTS);
  Logger.log(`Events sheet has ${rows.length} rows`);
  if (rows.length > 0) {
    const firstRecord = toEventRecord(rows[0]);
    if (!firstRecord) {
      throw new Error('CONTRACT FAIL: First event row failed to map');
    }
    Logger.log(`First event: ${firstRecord.eventName} (${firstRecord.eventDate})`);
  }
  Logger.log('CONTRACT PASS: EventService sheet access');
}

/**
 * Contract test: verify event folder creation in Drive.
 * Creates a test folder, verifies it exists, then removes it.
 */
function contractTestCreateEventFolder(): void {
  const testName = '9999-12-31_Contract_Test_Delete_Me';
  const result = createEventFolder(testName);
  if (result.status !== ResultStatus.SUCCESS) {
    throw new Error(`CONTRACT FAIL: Could not create folder — ${result.message}`);
  }
  Logger.log(`Created test folder: ${result.data!.folderId}`);

  // Clean up: move test folder to trash
  const folder = DriveApp.getFolderById(result.data!.folderId);
  folder.setTrashed(true);
  Logger.log('CONTRACT PASS: createEventFolder + cleanup');
}

/**
 * Contract test: verify exception scan runs without error.
 */
function contractTestScanViolations(): void {
  const result = scanLayer1Violations();
  Logger.log(`Layer 1 scan: ${result.message}`);
  if (result.status !== ResultStatus.SUCCESS) {
    throw new Error(`CONTRACT FAIL: Layer 1 scan error — ${result.message}`);
  }
  Logger.log(`Found ${result.data!.length} violation(s)`);
  Logger.log('CONTRACT PASS: scanLayer1Violations');
}
```

---

## 11. Phase 2 Task Breakdown

### Sprint 1 (Week 2, Days 1–3): Event Service + Types + Tests

| # | Task | Outputs | Tests Required |
|---|------|---------|----------------|
| 2.1 | Add `CREATE_EVENT`, `UPDATE_EVENT`, `LIST_EVENTS` to `RouteAction` enum | `src/types/enums.ts` | TypeScript compiles clean |
| 2.2 | Add `UpdateEventInput` to `src/types/requests.ts` | `src/types/requests.ts` | TypeScript compiles clean |
| 2.3 | Add `EventListItem`, `EventListResult`, `FolderViolation` to responses | `src/types/responses.ts` | TypeScript compiles clean |
| 2.4 | Verify existing `toEventRecord` / `fromEventRecord` in sheetMapper.ts; add comprehensive unit tests | `tests/unit/sheetMapper.test.ts` | Roundtrip + malformed row tests |
| 2.5 | Implement `eventService.ts` (findById, findByFolderName, listAll, createEvent, updateEvent, validateCreateInput) | `src/services/eventService.ts` | Full unit test suite (Section 10.3) |
| 2.6 | Extend mock data in `gasGlobals.ts` for Events sheet | `tests/mocks/gasGlobals.ts` | All event tests pass with mocks |
| 2.7 | Add `validateCreateEventPayload` / `validateUpdateEventPayload` to inputValidator | `src/middleware/inputValidator.ts` | Payload validation tests |
| 2.8 | Run full local test suite: existing + new tests all green | Coverage report | All Phase 1 + Phase 2 thresholds met |

### Sprint 2 (Week 2, Days 4–5 + Week 3, Days 1–2): Routes + UI + Exception Detection

| # | Task | Outputs | Tests Required |
|---|------|---------|----------------|
| 2.9 | Add event API handlers to `apiRoutes.ts` (handleCreateEvent, handleUpdateEvent, handleListEvents) | `src/routes/apiRoutes.ts` | Route handler unit tests |
| 2.10 | Register event routes in `router.ts` (GET + POST) | `src/routes/router.ts` | Route dispatch tests |
| 2.11 | Add `adminEventsPage` to `pageRoutes.ts` | `src/routes/pageRoutes.ts` | Manual: page renders |
| 2.12 | Add `serverCreateEvent`, `serverUpdateEvent`, `serverListEvents` to `main.ts` | `src/main.ts` | Manual: google.script.run calls work |
| 2.13 | Build `admin/events.html` (table, create form, filter, sort, folder preview) | `src/ui/templates/admin/events.html` | Manual: full UI checklist |
| 2.14 | Implement `scanLayer1Violations`, `scanLayer2Violations`, `scanAllViolations` in driveService | `src/services/driveService.ts` | Unit tests with mock folders |
| 2.15 | Add `serverScanViolations` to `main.ts` (calls `scanAllViolations`) | `src/main.ts` | Manual: violations banner appears |
| 2.16 | Update dashboard nav: add "Events" link for admins (already linked via tile, add to top nav) | `src/ui/templates/dashboard.html` | Manual: nav link works |
| 2.17 | Add event-related config constants | `src/config/constants.ts` | — |
| 2.18 | Write integration tests for event creation pipeline | `tests/integration/eventCreation.test.ts` | Integration tests pass |
| 2.19 | Run full test suite + coverage check | Coverage report | All thresholds met |
| 2.20 | `clasp push` + run contract tests against live environment | — | All contract tests pass |

---

## 12. Definition of Done — Phase 2

Phase 2 is complete when all of the following are true:

1. **TypeScript compiles clean**: `npm run typecheck` reports zero errors after all additions.
2. **All unit + integration tests pass**: `npm test` green, coverage meets thresholds for all new modules.
3. **Contract tests pass**: `clasp run contractTestReadEvents`, `contractTestCreateEventFolder`, and `contractTestScanViolations` all succeed against the live environment.
4. **Admin can create an event**: Fill in the form → folder appears in Drive → record in Events sheet → event shows in the table.
5. **Folder name preview works**: Typing name + date shows the generated folder name in real time.
6. **Duplicate detection works**: Attempting to create an event with the same date + name returns an error with a clear message.
7. **Event list renders correctly**: Events are displayed in a sortable table with newest first. Date range filters work.
8. **Edit works**: Admin can click edit on an event, change the display name, and see the table update without a full page reload.
9. **Drive links work**: Clicking the folder icon on each event row opens the correct Google Drive folder.
10. **Exception detection works**: Loading the events page triggers a background scan. If violations exist, the warning banner appears with the count and details.
11. **All authenticated users can list events**: A user with role `USER` can call `serverListEvents` (needed in Phase 3 for the upload flow event picker).
12. **No Phase 1 regressions**: All existing Phase 1 tests still pass. User management, auth flow, and dashboard all work as before.

---

## 13. Risk Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Drive API quota on exception scan | Scan fails for large event counts | Scan is async (background on page load). Cap at 50 events per scan in Phase 2. Phase 4 adds scheduled scans. |
| Sheet write fails after Drive folder creation | Orphan folder in Drive | Exception scan will detect orphan folders. Admin can manually delete. Event creation returns a clear error if sheet write fails. |
| Event name produces invalid folder name | Folder creation fails | Real-time preview + FolderNameValidator check before any Drive API call. |
| Multiple admins create same event concurrently | Duplicate folders | Duplicate check in both Events sheet (by folder name) and Drive (createSubfolder checks existence). Second attempt gets a 409 error. |
| Users see stale event list | Confusion after another admin creates event | List is refreshed on page load. Create/edit operations update the local state immediately. |
| GAS 6-minute timeout on large scan | Scan times out | scanAllViolations iterates sequentially. For >50 events, truncate and show "N more..." message. |

---

## 14. Relationship to Phase 3

Phase 2 delivers the event infrastructure that Phase 3's upload flow consumes directly:

| Phase 2 Output | Phase 3 Consumer |
|---------------|------------------|
| `serverListEvents()` | Upload page: event picker dropdown with date filter |
| `EventRecord.driveFolderId` | Upload page: target folder for club subfolder creation |
| `getOrCreateClubFolder()` | Upload service: auto-create club folder under selected event |
| `createBatchFolder()` | Upload service: create unique batch folder per upload session |
| `scanLayer2Violations()` | Upload flow: validate club folder naming before upload |
| Admin events page | Admin can verify event folders exist before directing users to upload |

Phase 3 should not need to modify any Phase 2 code — only consume its public API. The event service, Drive folder helpers, and exception detection are stable contracts that Phase 3 builds upon.
