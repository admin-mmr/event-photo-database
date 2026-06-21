import { useCallback, useState } from 'react';

/**
 * Gallery sort-order preference (matches the API's `?sort=` values in
 * api/src/routes/gallery.ts).
 *
 * - `recent` (default): newest upload first (by addedAt / Drive createdTime).
 * - `time`: oldest capture-time first.
 * - `name`: by filename.
 *
 * Persisted in localStorage so the choice sticks across visits. Default is
 * `recent` so freshly uploaded photos appear at the top.
 */
export type GallerySort = 'recent' | 'time' | 'name';

export const SORT_OPTIONS: ReadonlyArray<{ value: GallerySort; label: string }> = [
  { value: 'recent', label: 'Newest first' },
  { value: 'time', label: 'Oldest first' },
  { value: 'name', label: 'By name' },
];
export const DEFAULT_SORT: GallerySort = 'recent';

const STORAGE_KEY = 'gallery.sort';
const VALID = new Set<GallerySort>(['recent', 'time', 'name']);

function readSaved(): GallerySort {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s && VALID.has(s as GallerySort)) return s as GallerySort;
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
