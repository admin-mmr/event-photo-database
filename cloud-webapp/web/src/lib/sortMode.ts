import { useCallback, useState } from 'react';

/**
 * Gallery sort-order preference (matches the API's `?sort=` values in
 * api/src/routes/gallery.ts).
 *
 * - `added_desc` (default): upload time, newest first (addedAt / Drive
 *   createdTime).
 * - `added_asc`: upload time, oldest first.
 * - `taken_desc`: capture time, newest first.
 * - `taken_asc`: capture time, oldest first.
 * - `name`: by filename.
 *
 * Persisted in localStorage so the choice sticks across visits. Default is
 * `added_desc` so freshly uploaded photos appear at the top.
 */
export type GallerySort = 'added_desc' | 'added_asc' | 'taken_desc' | 'taken_asc' | 'name';

export const SORT_OPTIONS: ReadonlyArray<{ value: GallerySort; label: string }> = [
  { value: 'added_desc', label: 'Upload time — newest first' },
  { value: 'added_asc', label: 'Upload time — oldest first' },
  { value: 'taken_desc', label: 'Time taken — newest first' },
  { value: 'taken_asc', label: 'Time taken — oldest first' },
  { value: 'name', label: 'By name' },
];
export const DEFAULT_SORT: GallerySort = 'added_desc';

const STORAGE_KEY = 'gallery.sort';
const VALID = new Set<GallerySort>(['added_desc', 'added_asc', 'taken_desc', 'taken_asc', 'name']);

/** Map a stored value to a current sort, migrating the pre-5-option aliases
 *  (`recent` → newest upload, `time` → oldest capture) so saved prefs survive. */
function migrate(raw: string | null): GallerySort | null {
  if (!raw) return null;
  if (raw === 'recent') return 'added_desc';
  if (raw === 'time') return 'taken_asc';
  return VALID.has(raw as GallerySort) ? (raw as GallerySort) : null;
}

function readSaved(): GallerySort {
  try {
    return migrate(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_SORT;
  } catch {
    /* storage unavailable (private mode) — use the default */
  }
  return DEFAULT_SORT;
}

export interface UseSortMode {
  sort: GallerySort;
  setSort: (s: GallerySort) => void;
}

/** Persisted gallery sort state. Returns the current sort and a setter that
 *  also writes the choice to localStorage. */
export function useSortMode(): UseSortMode {
  const [sort, setSortState] = useState<GallerySort>(() => readSaved());

  const setSort = useCallback((s: GallerySort) => {
    setSortState(s);
    try {
      localStorage.setItem(STORAGE_KEY, s);
    } catch {
      /* storage unavailable — keep the in-memory value only */
    }
  }, []);

  return { sort, setSort };
}
