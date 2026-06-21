/**
 * findmeCache.ts — persist Find Me results across a reload (dev plan §5B C6).
 *
 * Results live only in React state, so a refresh — or the bounce back from the
 * iOS share/download sheet — wipes the match set and forces a re-search, which
 * needlessly burns the search + download rate limits. We cache the result set
 * in `sessionStorage` (tab-scoped, cleared when the tab closes — appropriate
 * for face-match output) keyed by eventId.
 *
 * TTL: the result thumbnails are short-lived V4 signed URLs (api caps them at
 * `SIGNED_URL_TTL_MINUTES`, default 60). We treat the cache as stale a little
 * under that so we never restore dead image links — past the window the user
 * just re-searches. Best-effort throughout: any storage error is swallowed.
 *
 * Pure-ish: storage is injectable so this unit-tests without a real DOM.
 */

import type { MatchResult } from '@cloud-webapp/shared';

/** Slightly under the api's 60-min signed-URL TTL so restored thumbs still load. */
export const FINDME_CACHE_TTL_MS = 50 * 60 * 1000;

const KEY_PREFIX = 'findme:results:';

/** In-memory shape the FindMe page works with (mirrors its `Reference`). */
export interface CachedReference {
  id: string;
  previewUrl: string;
  label: string;
  runId?: string;
  mode: string;
  results: MatchResult[];
  hidden: Set<string>;
}

export interface CachedFindMe {
  references: CachedReference[];
  activeId: string;
  confirmed: Set<string>;
}

interface PersistedReference {
  id: string;
  previewUrl: string;
  label: string;
  runId?: string;
  mode: string;
  results: MatchResult[];
  hidden: string[];
}

interface PersistedFindMe {
  savedAt: number;
  references: PersistedReference[];
  activeId: string;
  confirmed: string[];
}

function key(eventId: string): string {
  return `${KEY_PREFIX}${eventId}`;
}

function store(injected?: Storage): Storage | null {
  if (injected) return injected;
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null; // storage disabled (e.g. Safari private mode quirks)
  }
}

/**
 * Blob object URLs (`URL.createObjectURL(file)`) are dead after a reload, so we
 * don't persist them — the matches still restore, just without the tiny
 * reference-selfie thumbnail (the FindMe render falls back gracefully). Durable
 * http(s) signed URLs (reused past uploads) are kept.
 */
function durablePreview(url: string): string {
  return url.startsWith('blob:') ? '' : url;
}

export function saveResults(eventId: string, state: CachedFindMe, injected?: Storage): void {
  const s = store(injected);
  if (!s) return;
  const payload: PersistedFindMe = {
    savedAt: Date.now(),
    activeId: state.activeId,
    confirmed: [...state.confirmed],
    references: state.references.map((r) => ({
      id: r.id,
      previewUrl: durablePreview(r.previewUrl),
      label: r.label,
      ...(r.runId !== undefined ? { runId: r.runId } : {}),
      mode: r.mode,
      results: r.results,
      hidden: [...r.hidden],
    })),
  };
  try {
    s.setItem(key(eventId), JSON.stringify(payload));
  } catch {
    // Quota / serialization failure is non-fatal — caching is an optimisation.
  }
}

export function loadResults(
  eventId: string,
  injected?: Storage,
  now: number = Date.now(),
): CachedFindMe | null {
  const s = store(injected);
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(key(eventId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PersistedFindMe;
    if (!p || typeof p.savedAt !== 'number' || !Array.isArray(p.references)) return null;
    if (now - p.savedAt > FINDME_CACHE_TTL_MS) {
      clearResults(eventId, injected); // expired → drop it
      return null;
    }
    return {
      activeId: p.activeId,
      confirmed: new Set(p.confirmed ?? []),
      references: p.references.map((r) => ({
        id: r.id,
        previewUrl: r.previewUrl ?? '',
        label: r.label,
        ...(r.runId !== undefined ? { runId: r.runId } : {}),
        mode: r.mode,
        results: r.results ?? [],
        hidden: new Set(r.hidden ?? []),
      })),
    };
  } catch {
    return null;
  }
}

export function clearResults(eventId: string, injected?: Storage): void {
  const s = store(injected);
  if (!s) return;
  try {
    s.removeItem(key(eventId));
  } catch {
    // ignore
  }
}
