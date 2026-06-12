/**
 * gallery.ts — event photo listing with signed thumb/web URLs (M3.1 backend,
 * pulled forward for the demo fast-path 2026-06-12).
 *
 * Photos metadata comes from the `photos` collection the indexer writes;
 * bytes are served straight from the derivatives bucket via signed URLs.
 */

import { Router } from 'express';
import type { ListPhotosResponse, GalleryPhoto } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { requireAuth } from '../middleware/auth.js';
import { signPhotoUrls } from '../services/gcsService.js';

export const galleryRouter = Router();

const MAX_PHOTOS = 500; // demo cap; pagination lands with full M3

galleryRouter.get('/events/:id/photos', requireAuth, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);

    const eventDoc = await firestore().collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }

    const snap = await firestore()
      .collection('photos')
      .where('eventId', '==', eventId)
      .limit(MAX_PHOTOS)
      .get();

    const metas = snap.docs.map((d) => ({
      photoId: d.id,
      name: String(d.data().name ?? ''),
    }));

    const signed = await signPhotoUrls(eventId, metas.map((m) => m.photoId));
    const urlsById = new Map(signed.map((s) => [s.photoId, s]));
    const photos: GalleryPhoto[] = metas.map((m) => ({
      ...m,
      thumbUrl: urlsById.get(m.photoId)?.thumbUrl ?? '',
      webUrl: urlsById.get(m.photoId)?.webUrl ?? '',
    }));

    const body: ListPhotosResponse = { ok: true, eventId, photos };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
