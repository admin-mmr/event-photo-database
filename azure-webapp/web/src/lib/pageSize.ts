import { useCallback, useState } from 'react';

/**
 * Page-size preference shared by the gallery and Find Me results (M3.1).
 *
 * Most users are on phones, so we default low (50) for a fast first paint and
 * let them trade that for fewer "Load more" taps. The choice is persisted in
 * localStorage and shared across both views, so picking 100 in the gallery
 * carries over to Find Me.
 *
 * Keep PAGE_SIZE_OPTIONS in sync with MAX_PAGE in api/src/routes/gallery.ts
 * (the API caps `limit` at the largest option).
 */
export const PAGE_SIZE_OPTIONS = [50, 100, 500] as const;
export const DEFAULT_PAGE_SIZE = 50;

const STORAGE_KEY = 'gallery.pageSize';

function readSaved(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(n)) return n;
  } catch {
    /* storage unavailable (private mode) — use the default */
  }
  return DEFAULT_PAGE_SIZE;
}

export interface UsePageSize {
  pageSize: number;
  setPageSize: (n: number) => void;
}

/** Persisted page-size state. Returns the current size and a setter that also
 *  writes the choice to localStorage. */
export function usePageSize(): UsePageSize {
  const [pageSize, setPageSizeState] = useState<number>(() => readSaved());

  const setPageSize = useCallback((n: number) => {
    setPageSizeState(n);
    try {
      localStorage.setItem(STORAGE_KEY, String(n));
    } catch {
      /* storage unavailable — keep the in-memory value only */
    }
  }, []);

  return { pageSize, setPageSize };
}
