/**
 * UUID generation utility.
 *
 * GAS runtime provides Utilities.getUuid() which returns a standard UUID v4.
 * This wrapper exists so tests can mock it without touching Utilities directly.
 */

/* global Utilities */

/**
 * Returns a new UUID v4 string.
 * Example: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
 */
export function generateUuid(): string {
  return Utilities.getUuid();
}

/**
 * Validates that a string matches UUID v4 format.
 * Used to type-check values read from Sheets before using them as IDs.
 */
export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}
