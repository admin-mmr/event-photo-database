import { useCallback, useState } from 'react';

/**
 * Page-size preference shared by the gallery and Find Me results (M3.1).
 *
 * Most users are on phones, so we default low (50) for a fast first paint and
 * let them trade that for fewer page taps. The choice is persisted in
 * localStorage.
 *
 * Keep PAGE_SIZE_OPTIONS in sync with MAX_PAGE in api/src/routes/gallery.ts
 * (the API caps `limit` at the largest option).
 */
export const PAGE_SIZE_OPTIONS = [50, 100, 500] as const;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Find Me pages differently from the gallery: results are one client-side
 * ranked list shown a page at a time, and "Select all" selects the CURRENT
 * page so each download is one batch. A full page must therefore stay within
 * MAX_DOWNLOAD_PHOTOS (200, see shared/schemas/findme.ts) — so the largest
 * option is 200, not 500.
 */
export const FINDME_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

const STORAGE_KEY = 'gallery.pageSize';
const FINDME_STORAGE_KEY = 'findme.pageSize';

function readSaved(
  storageKey: string,
  options: readonly number[],
  defaultSize: number,
): number {
  try {
    const n = Number(localStorage.getItem(storageKey));
    if (options.includes(n)) return n;
  } catch {
    /* storage unavailable (private mode) — use the default */
  }
  return defaultSize;
}

export interface UsePageSize {
  pageSize: number;
  setPageSize: (n: number) => void;
}

export interface PageSizeConfig {
  options?: readonly number[];
  storageKey?: string;
  defaultSize?: number;
}

/** Persisted page-size state. Returns the current size and a setter that also
 *  writes the choice to localStorage. Defaults to the gallery's options/key;
 *  Find Me passes its own (FINDME_PAGE_SIZE_OPTIONS + FINDME_STORAGE_KEY). */
export function usePageSize(config: PageSizeConfig = {}): UsePageSize {
  const {
    options = PAGE_SIZE_OPTIONS,
    storageKey = STORAGE_KEY,
    defaultSize = DEFAULT_PAGE_SIZE,
  } = config;

  const [pageSize, setPageSizeState] = useState<number>(() =>
    readSaved(storageKey, options, defaultSize),
  );

  const setPageSize = useCallback(
    (n: number) => {
      setPageSizeState(n);
      try {
        localStorage.setItem(storageKey, String(n));
      } catch {
        /* storage unavailable — keep the in-memory value only */
      }
    },
    [storageKey],
  );

  return { pageSize, setPageSize };
}

/** Convenience wrapper for the Find Me view's page-size preference. */
export function useFindMePageSize(): UsePageSize {
  return usePageSize({
    options: FINDME_PAGE_SIZE_OPTIONS,
    storageKey: FINDME_STORAGE_KEY,
    defaultSize: DEFAULT_PAGE_SIZE,
  });
}
