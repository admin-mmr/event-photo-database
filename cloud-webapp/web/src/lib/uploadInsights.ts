/**
 * uploadInsights.ts — formatting and sorting for the admin upload-insights page
 * (`pages/AdminUploadInsights.tsx`). Pure, so the table's ordering is testable.
 */
import type { UploadInsightsRow } from '@cloud-webapp/shared';

/** Human byte size. */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** `95` → `1h 35m`; under an hour stays in minutes. */
export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtPct = (ratio: number | null): string => (ratio === null ? '—' : `${Math.round(ratio * 100)}%`);
export const fmtRate = (v: number | null, digits: number): string => (v === null ? '—' : v.toFixed(digits));
export const fmtTime = (iso: string): string => (iso ? new Date(iso).toLocaleString() : '—');

/** Total size of a row: what reached Drive plus what is still in staging. */
export const sizeOf = (r: UploadInsightsRow): number | null => (r.copiedBytes === null ? null : r.copiedBytes + r.stagedBytes);

export type SortKey =
  | 'clubName'
  | 'tag'
  | 'uploader'
  | 'sessions'
  | 'files'
  | 'copied'
  | 'untracked'
  | 'size'
  | 'minutes'
  | 'indexRatio'
  | 'firstSessionAt'
  | 'lastSessionAt'
  | 'staged'
  | 'skippedDuplicates'
  | 'mbPerSec'
  | 'filesPerMin'
  | 'attention';

/** Problems first when sorted by attention: stuck and errors outrank the rest. */
const attentionScore = (r: UploadInsightsRow): number =>
  r.stuck * 1000 + r.errors * 1000 + r.neverCompleted * 100 + (r.staged > 0 ? 10 : 0) + r.inProgress;

function sortValue(r: UploadInsightsRow, key: SortKey): string | number | null {
  if (key === 'size') return sizeOf(r);
  if (key === 'attention') return attentionScore(r);
  return r[key];
}

/** Sort rows; nulls (unknown) always last whichever the direction. */
export function sortRows<T extends UploadInsightsRow>(rows: ReadonlyArray<T>, key: SortKey, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    if (typeof va === 'string' || typeof vb === 'string') return sign * String(va).localeCompare(String(vb));
    return sign * (va - vb);
  });
}
