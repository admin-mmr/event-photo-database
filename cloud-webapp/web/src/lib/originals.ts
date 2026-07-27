/**
 * originals.ts — read original photo bytes.
 *
 * Deliberately TWO hops: ask the api for a signed GCS URL (JSON), then
 * `fetch()` that URL directly. The api can also 302 straight to the signed URL,
 * and letting `fetch()` follow that redirect looks equivalent — it isn't.
 *
 * On a cross-origin redirect the browser taints the request origin (so GCS sees
 * `Origin: null`, which the bucket's CORS config — a list of explicit web
 * origins — does not match) and, depending on browser and version, may still
 * carry the `Authorization` header from the first hop (which GCS rejects on a
 * URL that already carries its own signed auth). Either one fails the read, and
 * the variation across browsers is what made "Save to Photos" fail on iOS
 * Safari while the ZIP download — which fetches signed URLs directly — worked
 * on the very same photo.
 *
 * Fetching the signed URL ourselves puts this on that same proven path, and one
 * signing call now covers a whole selection instead of one request per photo.
 *
 * Still requires bucket CORS for the web origin —
 * infra/scripts/provision-derivatives-cors.sh.
 *
 * {@link OriginalsFetcher} is how callers read bytes. Three paths want
 * the same originals — the mobile prefetch (so `navigator.share` can be called
 * synchronously inside the tap, which iOS requires), the save fallback, and the
 * ZIP — and each used to fetch independently. A phone routinely downloaded the
 * same multi-megabyte photo two or three times: the prefetch fired one request
 * per selected photo with no concurrency cap, the save fallback re-fetched every
 * id without consulting what the prefetch already had, and the ZIP signed and
 * pulled its own copies. That saturated the link, left "Preparing…" sitting for
 * minutes, and when the duplicated transfers failed the user was told none of
 * their photos could be loaded. One cache, one in-flight map and one signing
 * call per batch make that impossible by construction.
 */

import { apiPost } from './api.js';
import { getRecaptchaToken } from './recaptcha.js';
import {
  MAX_DOWNLOAD_PHOTOS,
  type DownloadRequest,
  type DownloadSignResponse,
} from '@cloud-webapp/shared';

export interface SignedOriginal {
  url: string;
  filename: string;
}

/** A fetched original: the bytes plus the server's de-duplicated entry name. */
export interface OriginalEntry {
  blob: Blob;
  filename: string;
}

export interface FetchOriginalsResult {
  /** Successfully fetched, in the order the ids were requested. */
  entries: OriginalEntry[];
  /** How many requested ids could not be fetched. */
  failed: number;
  /** A few distinct failure reasons for error reporting — never one per photo. */
  sampleErrors: string[];
}

export interface FetchOriginalsOptions {
  /** Called as each id settles, so callers can show real progress. */
  onSettled?: (photoId: string, entry: OriginalEntry | null) => void;
}

/**
 * Simultaneous byte transfers. Small on purpose: these are full-resolution
 * originals on a phone, and past ~3 the transfers mostly compete for the same
 * link while multiplying peak memory.
 */
const FETCH_CONCURRENCY = 3;

/**
 * Above this many selected photos the pages stop prefetching originals for the
 * synchronous share. The galleries page 50/100/200 at a time, so "Select page"
 * would otherwise buffer hundreds of megabytes of full-resolution photos a phone
 * has no reason to hold — and the user may only want the ZIP. Past the cap the
 * Save button stays live and fetches when tapped, with progress.
 */
export const PREFETCH_MAX_PHOTOS = 30;

/** Settle time before a selection change triggers a prefetch, so ticking boxes
 *  one by one produces a single batched signing call rather than one per tick. */
export const PREFETCH_DEBOUNCE_MS = 400;

/** An aborted transfer is a cancellation, not a failure to report. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One per event. Hold it in a ref; don't recreate it per render. */
export class OriginalsFetcher {
  private readonly cache = new Map<string, OriginalEntry>();
  private readonly inflight = new Map<string, Promise<OriginalEntry>>();
  private controller = new AbortController();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly eventId: string) {}

  /** The cached original for `photoId`, if it has already been fetched. */
  get(photoId: string): OriginalEntry | undefined {
    return this.cache.get(photoId);
  }

  /** How many of `photoIds` are already in hand (drives the progress label). */
  countCached(photoIds: Iterable<string>): number {
    let n = 0;
    for (const id of photoIds) if (this.cache.has(id)) n += 1;
    return n;
  }

  /**
   * Ensure every id in `photoIds` is fetched, and return them in that order.
   * Cached ids resolve immediately, ids already being fetched are JOINED, and
   * only the genuinely missing ones are signed and transferred — so calling
   * this from the prefetch, the save and the ZIP moves each photo's bytes once.
   */
  async fetch(photoIds: string[], opts: FetchOriginalsOptions = {}): Promise<FetchOriginalsResult> {
    const ids = [...new Set(photoIds)];
    const missing = ids.filter((id) => !this.cache.has(id) && !this.inflight.has(id));
    // Captured now so an abort() cancels this batch's transfers, including the
    // ones still queued behind the concurrency cap.
    const { signal } = this.controller;

    const sampleErrors: string[] = [];
    let failed = 0;

    if (missing.length > 0) {
      let signed: Array<{ photoId: string } & SignedOriginal>;
      try {
        signed = await this.sign(missing);
      } catch (err) {
        // Signing is all-or-nothing for this call: with no URLs there is nothing
        // to fetch, so every id we were asked to add counts as failed.
        for (const id of missing) opts.onSettled?.(id, null);
        return {
          entries: ids.map((id) => this.cache.get(id)).filter((e): e is OriginalEntry => Boolean(e)),
          failed: missing.length,
          sampleErrors: [err instanceof Error ? err.message : String(err)],
        };
      }

      const byId = new Map(signed.map((s) => [s.photoId, s]));
      for (const id of missing) {
        const file = byId.get(id);
        if (!file) {
          // The server didn't return this id — deleted, or not in this event.
          failed += 1;
          if (!sampleErrors.includes('not_available')) sampleErrors.push('not_available');
          opts.onSettled?.(id, null);
          continue;
        }
        this.inflight.set(id, this.transfer(id, file, signal));
      }
    }

    await Promise.all(
      ids.map(async (id) => {
        const cached = this.cache.get(id);
        if (cached) {
          opts.onSettled?.(id, cached);
          return;
        }
        const pending = this.inflight.get(id);
        // Neither cached nor in flight: already counted above as unsignable.
        if (!pending) return;
        try {
          // Await FIRST. `opts.onSettled?.(id, await pending)` would short-circuit
          // the whole call when no callback is supplied — optional-call syntax
          // skips evaluating its arguments — so the transfer would never be
          // awaited and fetch() would return before any bytes arrived.
          const entry = await pending;
          opts.onSettled?.(id, entry);
        } catch (err) {
          if (isAbort(err)) return;
          failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          if (sampleErrors.length < 3 && !sampleErrors.includes(message)) sampleErrors.push(message);
          opts.onSettled?.(id, null);
        }
      }),
    );

    const entries: OriginalEntry[] = [];
    for (const id of ids) {
      const entry = this.cache.get(id);
      if (entry) entries.push(entry);
    }
    return { entries, failed, sampleErrors };
  }

  /** Drop cached originals outside `keep`, bounding memory on a phone. */
  retain(keep: Iterable<string>): boolean {
    const keepSet = keep instanceof Set ? keep : new Set(keep);
    let changed = false;
    for (const id of [...this.cache.keys()]) {
      if (keepSet.has(id)) continue;
      this.cache.delete(id);
      changed = true;
    }
    return changed;
  }

  /** Cancel every transfer in flight (selection changed, or unmount). */
  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.inflight.clear();
  }

  /** One signing call per batch of ids, chunked to the server's id cap. */
  private async sign(photoIds: string[]): Promise<Array<{ photoId: string } & SignedOriginal>> {
    const recaptchaToken = await getRecaptchaToken('download');
    const out: Array<{ photoId: string } & SignedOriginal> = [];
    for (const group of chunk(photoIds, MAX_DOWNLOAD_PHOTOS)) {
      const body: DownloadRequest = { photoIds: group };
      // eslint-disable-next-line no-await-in-loop
      const res = await apiPost<DownloadSignResponse, DownloadRequest>(
        `/api/events/${encodeURIComponent(this.eventId)}/originals/sign`,
        body,
        recaptchaToken ? { headers: { 'X-Recaptcha-Token': recaptchaToken } } : undefined,
      );
      out.push(...res.files);
    }
    return out;
  }

  /** Transfer one original, respecting the concurrency cap. */
  private async transfer(
    photoId: string,
    file: SignedOriginal,
    signal: AbortSignal,
  ): Promise<OriginalEntry> {
    await this.acquire();
    try {
      // Queued behind the cap long enough for the selection to change.
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const res = await fetch(file.url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entry: OriginalEntry = { blob: await res.blob(), filename: file.filename };
      this.cache.set(photoId, entry);
      return entry;
    } finally {
      this.inflight.delete(photoId);
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < FETCH_CONCURRENCY) {
      this.active += 1;
      return;
    }
    // Resolved by release(), which hands its slot over rather than freeing it,
    // so the active count can never drift above the cap.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}
