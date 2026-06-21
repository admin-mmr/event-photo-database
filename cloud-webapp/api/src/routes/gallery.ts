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
import {
  DeletePhotosRequestSchema,
  type ListPhotosResponse,
  type GalleryPhoto,
  type DeletePhotosResponse,
} from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { signThumbUrls, signPhotoUrl, deletePhotoDerivatives } from '../services/gcsService.js';
import { trashFile } from '../services/driveService.js';
import { triggerIndexJob } from '../services/indexerJob.js';

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

/**
 * Five gallery sort orders, `?sort=`, default `added_desc` (newest upload first):
 *
 * - `added_desc` (default): upload/added time newest first (`addedAt` =
 *   Drive createdTime). Surfaces freshly uploaded photos at the top.
 * - `added_asc`: upload time oldest first.
 * - `taken_desc`: capture time newest first (`takenAt`).
 * - `taken_asc`: capture time oldest first, CAPTURE_TIME_SORT_DESIGN §5.
 * - `name`: by filename.
 *
 * Legacy aliases (older clients / saved prefs): `recent` → `added_desc`,
 * `time` → `taken_asc`.
 *
 * Each mode maps to one Firestore field + direction. The id tiebreak
 * (`__name__`) is always ordered in the SAME direction as the primary field so
 * the composite index (whose implicit `__name__` matches its last field's
 * direction) serves the query — forward for the matching direction, reverse for
 * the opposite. This is the crux of the bug fix: a `desc` primary with an `asc`
 * id tiebreak is a mixed-direction order no existing index can serve, which is
 * what made `added_desc` ("Newest first") 500 while `taken_asc` ("Oldest
 * first") — both ascending, matching its index — kept working.
 */
type SortMode = 'added_desc' | 'added_asc' | 'taken_desc' | 'taken_asc' | 'name';

type SortField = 'addedAt' | 'takenAt' | 'name';
type SortDir = 'asc' | 'desc';
type CursorKey = 'a' | 't' | 'n';

interface SortSpec {
  field: SortField;
  dir: SortDir;
  cursorKey: CursorKey;
}

const SORT_SPECS: Record<SortMode, SortSpec> = {
  added_desc: { field: 'addedAt', dir: 'desc', cursorKey: 'a' },
  added_asc: { field: 'addedAt', dir: 'asc', cursorKey: 'a' },
  taken_desc: { field: 'takenAt', dir: 'desc', cursorKey: 't' },
  taken_asc: { field: 'takenAt', dir: 'asc', cursorKey: 't' },
  name: { field: 'name', dir: 'asc', cursorKey: 'n' },
};

function parseSort(raw: unknown): SortMode {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'recent') return 'added_desc';
  if (s === 'time') return 'taken_asc';
  if (s in SORT_SPECS) return s as SortMode;
  return 'added_desc';
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

    // Order by the chosen field then document id. The id tiebreak (Firestore's
    // implicit __name__) is ordered in the SAME direction as the field so the
    // composite index serves it (forward when directions match the index,
    // reverse otherwise) — see SORT_SPECS above. Needs the
    // photos(eventId, takenAt) / (eventId, name) / (eventId, addedAt desc)
    // composite indexes in firestore.indexes.json; each serves both directions
    // of its field via a reverse scan, so no per-direction index is required.
    // Firestore excludes docs that lack the orderBy field, so an event indexed
    // before `addedAt` existed returns nothing under an `added_*` sort; the
    // takenAt fallback below handles that.
    const base = (): Query => firestore().collection('photos').where('eventId', '==', eventId);

    const buildQuery = (spec: SortSpec): Query => {
      let q = base().orderBy(spec.field, spec.dir).orderBy(FieldPath.documentId(), spec.dir);
      if (cursor) {
        const startVal =
          spec.cursorKey === 'n'
            ? (cursor.n ?? '')
            : spec.cursorKey === 't'
              ? (cursor.t ?? null)
              : (cursor.a ?? null);
        q = q.startAfter(startVal, cursor.id ?? '');
      }
      return q.limit(limit);
    };

    const primary = SORT_SPECS[sort];
    // The takenAt fallback for `added_*` sorts (event not backfilled / addedAt
    // index missing) keeps the user's chosen direction, just on capture time.
    const fallbackSpec: SortSpec = { field: 'takenAt', dir: primary.dir, cursorKey: 't' };
    // `usedSpec` is whichever spec actually produced the results, so nextCursor
    // is tagged with the right key (it differs when the fallback kicks in).
    let usedSpec = primary;

    let snap;
    if (primary.field === 'addedAt' && cursor?.t !== undefined) {
      // Continuing the takenAt fallback across pages (a previous page was served
      // by the fallback and handed back a `t`-tagged cursor).
      usedSpec = fallbackSpec;
      snap = await buildQuery(fallbackSpec).get();
    } else {
      try {
        snap = await buildQuery(primary).get();
        // Recover an event that has photos but no `addedAt` yet (indexed before
        // the field existed): an empty FIRST page of an `added_*` request means
        // "not backfilled" → re-query by takenAt so the gallery is never blank.
        // Subsequent pages stay in fallback via the `t`-tagged cursor.
        if (primary.field === 'addedAt' && !cursor && snap.empty) {
          usedSpec = fallbackSpec;
          snap = await buildQuery(fallbackSpec).get();
        }
      } catch (err) {
        // The addedAt composite index may not exist yet (a deploy that shipped
        // this route before `firebase deploy --only firestore:indexes`, or the
        // index is still building → Firestore FAILED_PRECONDITION). Degrade to
        // capture time, which the existing (eventId, takenAt) index serves, so
        // the gallery keeps working until the index is live. The takenAt/name
        // sorts use already-built indexes, so their errors are real → rethrow.
        if (primary.field === 'addedAt') {
          logger.warn({ err, eventId }, 'gallery: addedAt query failed, falling back to takenAt');
          usedSpec = fallbackSpec;
          snap = await buildQuery(fallbackSpec).get();
        } else {
          throw err;
        }
      }
    }

    // A full page means there may be more; the cursor is the last doc we saw
    // (taken BEFORE de-dupe so we never skip a photo across the page boundary).
    const lastDoc = snap.docs[snap.docs.length - 1];
    let nextCursor: string | null = null;
    if (snap.size === limit && lastDoc) {
      const d = lastDoc.data();
      if (usedSpec.cursorKey === 'n') {
        nextCursor = encodeCursor({ n: String(d.name ?? ''), id: lastDoc.id });
      } else if (usedSpec.cursorKey === 't') {
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

/**
 * POST /events/:id/photos/delete — admin-only "remove these photos" (the
 * gallery's Select → Delete action). A photo lives in four places; this removes
 * the first three synchronously and refreshes the fourth via a re-index:
 *   1. Drive original → moved to Trash (recoverable ~30 days). photoId === fileId.
 *   2. GCS derivatives (orig/web/thumb) → deleted.
 *   3. Firestore `photos/<photoId>` doc → deleted (drops it from the gallery now).
 *   4. Matcher Find-Me vectors → refreshed by triggering a re-index, which lists
 *      Drive (the trashed originals are gone), drops their manifest rows, and
 *      rewrites the per-event vector store without them.
 *
 * Per-photo failures are collected (not fatal) so one bad id doesn't abort the
 * batch. The re-index is best-effort — the photos are already gone from the
 * gallery, and the scheduled change-scan would catch the Drive change anyway.
 */
galleryRouter.post('/events/:id/photos/delete', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);

    const parsed = DeletePhotosRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'photoIds is required (1..200)',
      });
      return;
    }

    const eventDoc = await firestore().collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }

    const uniqueIds = [...new Set(parsed.data.photoIds)];
    const deleted: string[] = [];
    const failed: { photoId: string; reason: string }[] = [];

    for (const photoId of uniqueIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const doc = await firestore().collection('photos').doc(photoId).get();
        if (!doc.exists || doc.data()?.eventId !== eventId) {
          failed.push({ photoId, reason: 'not_found' });
          continue;
        }
        const mimeType = doc.data()?.mimeType as string | undefined;
        // 1. Drive original → Trash (photoId is the Drive fileId).
        // eslint-disable-next-line no-await-in-loop
        await trashFile(photoId);
        // 2. GCS derivatives. 3. Firestore index doc.
        // eslint-disable-next-line no-await-in-loop
        await deletePhotoDerivatives(eventId, photoId, mimeType);
        // eslint-disable-next-line no-await-in-loop
        await firestore().collection('photos').doc(photoId).delete();
        deleted.push(photoId);
      } catch (err) {
        logger.warn({ err, eventId, photoId }, 'admin delete: photo removal failed');
        failed.push({ photoId, reason: err instanceof Error ? err.message : 'delete_failed' });
      }
    }

    // 4. Refresh Find Me by re-indexing (best-effort; non-fatal on error).
    let reindex: string | null = null;
    if (deleted.length > 0 && eventDoc.data()?.driveFolderId) {
      try {
        const { execution } = await triggerIndexJob(eventId);
        reindex = execution;
        await firestore()
          .collection('events')
          .doc(eventId)
          .set(
            { indexState: { status: 'queued', updatedAt: new Date().toISOString() } },
            { merge: true },
          );
      } catch (err) {
        logger.warn({ err, eventId }, 'admin delete: reindex trigger failed (non-fatal)');
      }
    }

    logger.info(
      { eventId, deleted: deleted.length, failed: failed.length, by: req.user?.email },
      'admin photo delete',
    );
    const body: DeletePhotosResponse = { ok: true, eventId, deleted, failed, reindex };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
