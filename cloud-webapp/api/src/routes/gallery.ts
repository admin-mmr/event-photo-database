/**
 * gallery.ts — event photo listing with signed thumb/web URLs (M3.1 backend,
 * pulled forward for the demo fast-path 2026-06-12).
 *
 * Photos metadata comes from the `photos` collection the indexer writes;
 * bytes are served straight from the derivatives bucket via signed URLs.
 *
 * Paginated (cursor) so large events (>500 photos) load page by page instead
 * of being truncated at a hard cap. The client requests `?cursor=<nextCursor>`
 * to walk subsequent pages; `nextCursor` is null on the final page.
 */

import { Router } from 'express';
import { FieldPath, type Query } from '@google-cloud/firestore';
import type { ListPhotosResponse, GalleryPhoto } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { requireAuth } from '../middleware/auth.js';
import { signThumbUrls, signPhotoUrl } from '../services/gcsService.js';

export const galleryRouter = Router();

// First paint should be fast: a page is signed (one IAM signBlob round-trip per
// URL) before the response is sent, so a huge page is what made the gallery
// stall on "Loading photos…". Default to 50 (fills a couple of mobile screens,
// signs in a fraction of a second) and let the cursor paging engage. The client
// offers 50/100/500 via `?limit=`; MAX_PAGE caps it (and any over-eager client).
const DEFAULT_PAGE = 50;
const MAX_PAGE = 500; // bounds per-request signing cost + client memory

/** Parse a positive integer query param, clamped to [1, max], else fallback. */
function pageSize(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

type SortMode = 'recent' | 'time' | 'name';
/**
 * `?sort=recent|time|name`, default `recent`.
 *
 * - `recent` (default): newest-first by `addedAt` (upload/added time = Drive
 *   createdTime). Surfaces freshly uploaded photos at the top so it's obvious
 *   when there are new photos to Find Me. Falls back to `takenAt` desc for
 *   events not yet reindexed (no `addedAt` written) — see the route below.
 * - `time`: oldest-first by capture time (`takenAt`), CAPTURE_TIME_SORT_DESIGN §5.
 * - `name`: by filename.
 */
function parseSort(raw: unknown): SortMode {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'time') return 'time';
  if (s === 'name') return 'name';
  return 'recent';
}

/** Opaque, base64url page cursor carrying the last doc's primary sort value
 *  plus its id (the implicit __name__ tiebreak), so paging is stable even
 *  across photos that share a value. The key identifies which sort produced it:
 *  `a` = addedAt (recent), `t` = takenAt (time / recent-fallback), `n` = name. */
function encodeCursor(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeCursor(
  raw: string,
): { a?: string | null; t?: string | null; n?: string; id?: string } | null {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      a?: string | null;
      t?: string | null;
      n?: string;
      id?: string;
    };
  } catch {
    return null;
  }
}

galleryRouter.get('/events/:id/photos', requireAuth, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const limit = pageSize(req.query.limit);
    const sort = parseSort(req.query.sort);
    const cursor = req.query.cursor ? decodeCursor(String(req.query.cursor)) : null;

    const eventDoc = await firestore().collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }

    // Order by the chosen key then document id (Firestore's implicit __name__
    // tiebreak, made explicit so the value-based cursor below is stable). Needs
    // the photos(eventId, takenAt) / (eventId, name) / (eventId, addedAt desc)
    // composite indexes in firestore.indexes.json. Firestore excludes docs that
    // lack the orderBy field, so an event reindexed before `addedAt` existed
    // returns nothing under `recent`; the fallback below handles that.
    const base = (): Query => firestore().collection('photos').where('eventId', '==', eventId);
    // `recentFallback` tracks when a `recent` request is actually being served
    // by the takenAt-desc fallback, so the cursor below is tagged correctly.
    let recentFallback = false;

    const buildQuery = (mode: SortMode, useFallback: boolean): Query => {
      let q = base();
      if (mode === 'name') {
        q = q.orderBy('name').orderBy(FieldPath.documentId());
        if (cursor) q = q.startAfter(cursor.n ?? '', cursor.id ?? '');
      } else if (mode === 'time') {
        q = q.orderBy('takenAt').orderBy(FieldPath.documentId());
        if (cursor) q = q.startAfter(cursor.t ?? null, cursor.id ?? '');
      } else if (useFallback || cursor?.t !== undefined) {
        // recent, served via takenAt-desc fallback (event not yet backfilled).
        // A `t`-tagged cursor means we're continuing that fallback across pages.
        q = q.orderBy('takenAt', 'desc').orderBy(FieldPath.documentId());
        if (cursor) q = q.startAfter(cursor.t ?? null, cursor.id ?? '');
      } else {
        // recent, normal path: newest-first by addedAt.
        q = q.orderBy('addedAt', 'desc').orderBy(FieldPath.documentId());
        if (cursor?.a !== undefined) q = q.startAfter(cursor.a ?? null, cursor.id ?? '');
      }
      return q.limit(limit);
    };

    let snap = await buildQuery(sort, false).get();
    // Recover an event that has photos but no `addedAt` yet (indexed before the
    // field existed): on the FIRST page of a `recent` request, an empty result
    // means "not backfilled" → re-query by takenAt desc so the gallery is never
    // blank. Subsequent pages stay in fallback via the `t`-tagged cursor.
    if (sort === 'recent' && !cursor && snap.empty) {
      recentFallback = true;
      snap = await buildQuery(sort, true).get();
    } else if (sort === 'recent' && cursor?.t !== undefined) {
      recentFallback = true;
    }

    // A full page means there may be more; the cursor is the last doc we saw
    // (taken BEFORE de-dupe so we never skip a photo across the page boundary).
    const lastDoc = snap.docs[snap.docs.length - 1];
    let nextCursor: string | null = null;
    if (snap.size === limit && lastDoc) {
      const d = lastDoc.data();
      if (sort === 'name') {
        nextCursor = encodeCursor({ n: String(d.name ?? ''), id: lastDoc.id });
      } else if (sort === 'time' || recentFallback) {
        nextCursor = encodeCursor({ t: (d.takenAt as string | null) ?? null, id: lastDoc.id });
      } else {
        nextCursor = encodeCursor({ a: (d.addedAt as string | null) ?? null, id: lastDoc.id });
      }
    }

    const allMetas = snap.docs.map((d) => ({
      photoId: d.id,
      name: String(d.data().name ?? ''),
      contentHash: String(d.data().contentHash ?? ''),
      takenAt: (d.data().takenAt as string | null) ?? null,
      takenAtSource: String(d.data().takenAtSource ?? ''),
      addedAt: (d.data().addedAt as string | null) ?? null,
    }));

    // Defensive de-dupe at list time (B6 / FR-2c): the indexer already collapses
    // byte-identical images, but events indexed before that logic (or with mixed
    // model versions) can still hold duplicates. Keep the first photo per
    // contentHash; photos with no hash are always kept (can't dedupe safely).
    // De-dupe is per-page (best-effort) — cross-page byte dupes are vanishingly
    // rare and not worth carrying state across requests for.
    const seenHashes = new Set<string>();
    const metas = allMetas.filter((m) => {
      if (!m.contentHash) return true;
      if (seenHashes.has(m.contentHash)) return false;
      seenHashes.add(m.contentHash);
      return true;
    });

    // Sign thumbnails only — the grid never shows the full-size `web`
    // derivative, so we defer that signing to the lightbox endpoint below.
    const signed = await signThumbUrls(eventId, metas.map((m) => m.photoId));
    const urlsById = new Map(signed.map((s) => [s.photoId, s.thumbUrl]));
    const photos: GalleryPhoto[] = metas.map((m) => ({
      photoId: m.photoId,
      name: m.name,
      thumbUrl: urlsById.get(m.photoId) ?? '',
      takenAt: m.takenAt,
      takenAtSource: m.takenAtSource,
      addedAt: m.addedAt,
    }));

    const eventName = String(eventDoc.data()?.name ?? '');
    const body: ListPhotosResponse = { ok: true, eventId, eventName, photos, nextCursor };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /events/:id/photos/:photoId/web — sign a single full-size `web` URL on
 * demand. The gallery list ships only thumbnails (fast first paint); when a
 * user opens a photo in the lightbox the client fetches its `web` URL here.
 */
galleryRouter.get('/events/:id/photos/:photoId/web', requireAuth, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const photoId = String(req.params.photoId);
    const webUrl = await signPhotoUrl(eventId, photoId, 'web');
    res.json({ ok: true, photoId, webUrl });
  } catch (err) {
    next(err);
  }
});
