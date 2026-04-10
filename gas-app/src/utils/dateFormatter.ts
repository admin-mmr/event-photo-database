/**
 * Date and timestamp utilities.
 *
 * All dates stored in Sheets use ISO 8601 strings:
 *   - Date only:   "YYYY-MM-DD"
 *   - Timestamp:   "YYYY-MM-DDTHH:MM:SS.sssZ"
 *
 * GAS returns Date objects from Sheets cells of type DATE.
 * These helpers normalize everything to strings for consistent storage.
 */

/**
 * Returns today's date as "YYYY-MM-DD" in the system's local timezone.
 */
export function todayIsoDate(): string {
  return toIsoDate(new Date());
}

/**
 * Returns the current UTC timestamp as an ISO 8601 string.
 */
export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Converts a Date to "YYYY-MM-DD".
 */
export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Converts a Date to a compact timestamp string used in batch folder names.
 * Format: "YYYYMMDD-HHMMSS"
 * Always uses UTC to ensure uniqueness across time zones.
 *
 * Example: new Date("2025-11-03T09:35:00Z") → "20251103-093500"
 */
export function toBatchTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Parses a "YYYY-MM-DD" string into a Date at midnight UTC.
 * Returns null if the string is not a valid date.
 */
export function parseIsoDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  // Verify the parsed date matches the input (catches Feb 30, etc.)
  if (toIsoDate(new Date(d.getTime() + d.getTimezoneOffset() * 60000)) !== dateStr) {
    // Cross-check using UTC components
    const [y, m, day] = dateStr.split('-').map(Number);
    if (
      d.getUTCFullYear() !== y ||
      d.getUTCMonth() + 1 !== m ||
      d.getUTCDate() !== day
    ) {
      return null;
    }
  }
  return d;
}

/**
 * Returns true if a "YYYY-MM-DD" string represents a real calendar date.
 */
export function isValidIsoDate(dateStr: string): boolean {
  return parseIsoDate(dateStr) !== null;
}

/**
 * Builds the Layer 1 folder name date prefix from an ISO date string.
 * "2025-11-03" → "2025-11-03" (same, but validated)
 * Returns null for invalid dates.
 */
export function folderDatePrefix(isoDate: string): string | null {
  if (!isValidIsoDate(isoDate)) return null;
  return isoDate;
}
