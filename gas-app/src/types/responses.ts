import { ResultStatus } from './enums';

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
