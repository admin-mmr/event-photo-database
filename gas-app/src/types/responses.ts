import { ResultStatus } from './enums';

// ─── google.script.run shared types ──────────────────────────────────────────

/**
 * Composite result returned by all google.script.run server functions.
 * `warnings` carries non-fatal side-effect failures (e.g. email not sent,
 * album creation failed) so the UI can show a non-blocking banner without
 * rolling back the primary operation.
 */
export type ServerResponse = {
  status:    string;
  message:   string;
  data?:     unknown;
  errors?:   unknown;
  /** Non-fatal side-effect failures the UI may surface as warnings. */
  warnings?: string[];
};

/**
 * Every google.script.run payload carries an optional sessionToken so the
 * server can authenticate the caller.
 */
export type WithSession<T = Record<string, unknown>> = T & { sessionToken?: string };

/**
 * Standardized result envelope returned by every service method.
 *
 * Usage patterns:
 *   const result = UserService.create(input, adminEmail);
 *   if (result.status !== ResultStatus.SUCCESS) {
 *     // handle error — result.message describes what went wrong
 *   }
 *   const user = result.data; // typed as T
 *
 * Never throw across service boundaries. Always return ServiceResult.
 */
export interface ServiceResult<T = undefined> {
  readonly status: ResultStatus;
  readonly message: string;
  readonly data?: T;
  readonly errors?: ReadonlyArray<ValidationError>;
}

/**
 * Field-level validation error attached to ServiceResult.errors.
 * Used when multiple fields fail validation simultaneously.
 */
export interface ValidationError {
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
}

/**
 * Payload returned by the folder name validator.
 */
export interface FolderValidationResult {
  readonly isValid: boolean;
  readonly normalizedName: string;
  readonly violations: ReadonlyArray<string>;
}

/**
 * Generic paginated list response used in admin views.
 */
export interface PaginatedResult<T> {
  readonly items: ReadonlyArray<T>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * JSON payload structure for all API responses (doPost).
 * Clients (browser JS or partner GAS) parse this shape.
 */
export interface ApiResponse<T = undefined> {
  readonly status: ResultStatus;
  readonly code: number;   // HTTP-style status code: 200, 400, 403, 409, 500
  readonly message: string;
  readonly data?: T;
  readonly errors?: ReadonlyArray<ValidationError>;
}

/**
 * Extended event info returned in list views.
 * Combines EventRecord with derived data from Drive.
 */
export interface EventListItem {
  readonly event: import('./models').EventRecord;
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

/** Convenience constructors for ApiResponse */
export const ApiResponse = {
  ok<T>(data: T, message = 'OK'): ApiResponse<T> {
    return { status: ResultStatus.SUCCESS, code: 200, message, data };
  },
  badRequest(message: string, errors?: ReadonlyArray<ValidationError>): ApiResponse {
    return { status: ResultStatus.ERROR, code: 400, message, errors };
  },
  forbidden(message = 'Forbidden'): ApiResponse {
    return { status: ResultStatus.ERROR, code: 403, message };
  },
  notFound(message = 'Not found'): ApiResponse {
    return { status: ResultStatus.ERROR, code: 404, message };
  },
  conflict(message: string): ApiResponse {
    return { status: ResultStatus.ERROR, code: 409, message };
  },
  serverError(message = 'Internal server error'): ApiResponse {
    return { status: ResultStatus.ERROR, code: 500, message };
  },
};
