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
import { signPhotoUrls } from '../services/gcsService.js';

export const galleryRouter = Router();

const DEFAULT_PAGE = 500;
const MAX_PAGE = 500; // bounds per-request signing cost + client memory

/** Parse a positive integer query param, clamped to [1, max], else fallback. */
function pageSize(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

galleryRouter.get('/events/:id/photos', requireAuth, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const limit = pageSize(req.query.limit);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    const eventDoc = await firestore().collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }

    // Order by document id so paging is stable and deterministic. Equality
    // filter + key order needs no composite index. The cursor is the last
    // photoId of the previous page.
    let query: Query = firestore()
      .collection('photos')
      .where('eventId', '==', eventId)
      .orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.limit(limit).get();

    // A full page means there may be more; the cursor is the last doc we saw
    // (taken BEFORE de-dupe so we never skip a photo across the page boundary).
    const nextCursor =
      snap.size === limit && snap.docs.length > 0 ? snap.docs[snap.docs.length - 1].id : null;

    const allMetas = snap.docs.map((d) => ({
      photoId: d.id,
      name: String(d.data().name ?? ''),
      contentHash: String(d.data().contentHash ?? ''),
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

    const signed = await signPhotoUrls(eventId, metas.map((m) => m.photoId));
    const urlsById = new Map(signed.map((s) => [s.photoId, s]));
    const photos: GalleryPhoto[] = metas.map((m) => ({
      photoId: m.photoId,
      name: m.name,
      thumbUrl: urlsById.get(m.photoId)?.thumbUrl ?? '',
      webUrl: urlsById.get(m.photoId)?.webUrl ?? '',
    }));

    const eventName = String(eventDoc.data()?.name ?? '');
    const body: ListPhotosResponse = { ok: true, eventId, eventName, photos, nextCursor };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
