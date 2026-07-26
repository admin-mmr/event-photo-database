/**
 * dateRange.ts — inclusive upper bounds for the admin date filters.
 *
 * The admin Summary/Audit screens filter with `<input type="date">`, which
 * yields a bare `YYYY-MM-DD`. The stored values are full ISO timestamps
 * (`new Date().toISOString()`), and both filters compare them
 * lexicographically. That makes a date-only `since` naturally inclusive
 * ("2026-07-26" <= "2026-07-26T09:00:00.000Z") but a date-only `until`
 * EXCLUSIVE — "2026-07-26T09:00:00.000Z" > "2026-07-26" — so an admin asking
 * for "through July 26" silently loses every row from July 26.
 *
 * Widening a date-only bound to the end of that day restores the inclusive
 * range both call sites document. A bound that already carries a time is left
 * exactly as given.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Widen a date-only `until` to end-of-day so the final day is included. */
export function inclusiveUntil(until: string): string {
  return DATE_ONLY.test(until) ? `${until}T23:59:59.999Z` : until;
}
