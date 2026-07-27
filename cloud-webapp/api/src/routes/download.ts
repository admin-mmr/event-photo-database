/**
 * download.ts — original-resolution photo delivery (dev plan §5A B1 / FR-12,
 * FR-14).
 *
 * COST: originals are the heavy bytes in this app. We never proxy them through
 * the service, because the web client reaches the api via the Firebase Hosting
 * `/api/**` rewrite — so any byte we stream is billed as Hosting egress
 * ($0.15/GB) on top of Cloud Run. A single live event day of attendees saving
 * full-res photos that way spiked the Hosting line. Both routes here therefore
 * hand the client short-lived SIGNED GCS URLs and let the bytes flow GCS →
 * browser directly (GCS egress only). See infra/scripts/provision-derivatives-cors.sh
 * — the browser reads those URLs cross-origin, so the bucket needs CORS.
 *
 *  - POST /events/:id/download — sign the whole selection in ONE call (keeps the
 *    dedicated bulk-download rate budget); the client zips them in the browser.
 *  - GET  /events/:id/photos/:photoId/original — 302 to a signed URL.
 *
 * Abuse controls: per-user download rate limit, a photo-count cap (shared
 * MAX_DOWNLOAD_PHOTOS), and a reCAPTCHA Enterprise gate on the sign call
 * (action 'download') so scripted bulk-signing is deterred alongside search
 * (M5.3). The reCAPTCHA gate no-ops when unconfigured (see middleware).
 */

import { Router } from 'express';
import { DownloadRequestSchema, type DownloadSignResponse } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { downloadRateLimit, originalFetchRateLimit } from '../middleware/rateLimit.js';
import { requireRecaptcha } from '../middleware/recaptcha.js';
import { origExtForMime, signOrigUrl } from '../services/gcsService.js';

export const downloadRouter = Router();

// Characters illegal in ZIP entry / cross-platform filenames.
const ILLEGAL_NAME_CHARS = /["*/:<>?\\|]/g;

/** Make a Drive filename safe as a ZIP entry: basename only, no separators. */
function safeEntryName(name: string, photoId: string, fallbackExt: string): string {
  const base = (name || '').split(/[/\\]/).pop()?.trim() ?? '';
  const cleaned = base.replace(ILLEGAL_NAME_CHARS, '_');
  return cleaned || `${photoId}.${fallbackExt}`;
}

downloadRouter.post(
  '/events/:id/download',
  requireAuth,
  downloadRateLimit(),
  requireRecaptcha('download'),
  async (req, res, next) => {
  try {
    const eventId = String(req.params.id);

    const parsed = DownloadRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'photoIds is required (1..200)',
      });
      return;
    }
    const { photoIds } = parsed.data;

    const eventDoc = await firestore().collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }

    // Resolve photo metadata (name + mimeType → orig ext). De-dupe ids and keep
    // only photos that actually belong to this event.
    const uniqueIds = [...new Set(photoIds)];
    const docs = await Promise.all(
      uniqueIds.map((id) => firestore().collection('photos').doc(id).get()),
    );
    const photos = docs
      .filter((d) => d.exists && d.data()?.eventId === eventId)
      .map((d) => ({
        photoId: d.id,
        name: String(d.data()?.name ?? ''),
        mimeType: d.data()?.mimeType as string | undefined,
      }));

    if (photos.length === 0) {
      res.status(404).json({
        ok: false,
        error: 'no_photos',
        message: 'None of the requested photos belong to this event',
      });
      return;
    }

    // Sign each original and hand back stable, de-duplicated ZIP entry names so
    // the client can assemble the archive without a second metadata round-trip.
    const usedNames = new Set<string>();
    const files = await Promise.all(
      photos.map(async (p) => {
        const ext = origExtForMime(p.mimeType);
        let filename = safeEntryName(p.name, p.photoId, ext);
        // Disambiguate duplicate filenames so no entry is silently overwritten.
        if (usedNames.has(filename)) {
          const dot = filename.lastIndexOf('.');
          const stem = dot > 0 ? filename.slice(0, dot) : filename;
          const tail = dot > 0 ? filename.slice(dot) : '';
          filename = `${stem}_${p.photoId.slice(0, 6)}${tail}`;
        }
        usedNames.add(filename);
        const url = await signOrigUrl(eventId, p.photoId, p.mimeType, {
          disposition: encodeURIComponent(filename),
        });
        return { photoId: p.photoId, url, filename };
      }),
    );

    logger.info(
      { eventId, requested: photoIds.length, included: files.length, by: req.user?.email },
      'zip download signed',
    );
    res.setHeader('Cache-Control', 'no-store');
    const body: DownloadSignResponse = { ok: true, files };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id/photos/:photoId/original — hand back a short-lived signed
 * GCS URL for the original (FR-12). Powers "save photos individually", which on
 * iOS feeds the share sheet ("Save N Images to Photos"), and the full-res
 * lightbox.
 *
 * TWO RESPONSE SHAPES:
 *   - `?format=json` → `{ ok, url, filename }`. Use this whenever the caller
 *     intends to read the BYTES (`fetch(url).blob()`).
 *   - default        → 302 to the signed URL. For plain navigation / `<img>`,
 *     where no CORS read is involved.
 *
 * Why the split: following a cross-origin redirect from `fetch()` is not
 * equivalent to fetching the signed URL directly. On the redirected hop the
 * browser taints the origin (`Origin: null`) and may still carry the
 * `Authorization` header from the first hop — the first makes GCS's CORS config
 * (which lists explicit web origins) not match, the second makes GCS reject a
 * signed URL that already carries its own auth. Behaviour varies by browser and
 * version, which is exactly what made "Save to Photos" fail on iOS Safari while
 * the ZIP path — which fetches signed URLs directly — kept working. Asking for
 * JSON and fetching the URL ourselves puts the byte read on the same proven
 * path as the ZIP.
 *
 * Cost: the original bytes are the heavy part of this app, and one user "Save
 * to Photos" fans out into N of these. We deliberately do NOT stream the bytes
 * through the service — that would proxy every byte through Cloud Run AND the
 * Firebase Hosting `/api/**` rewrite, billing them as Hosting egress ($0.15/GB)
 * on top of Cloud Run. Either shape keeps the heavy transfer GCS → browser, and
 * the JSON shape costs the same number of api round-trips as the redirect did.
 *
 * Requires browser CORS on the derivatives bucket so the blob is readable —
 * see infra/scripts/provision-derivatives-cors.sh.
 *
 * Same auth + event-ownership checks as the ZIP route, but its OWN rate-limit
 * bucket (§5B C1): one user save fans out into N of these, so it must not draw
 * down the bulk-ZIP `download` budget.
 */
downloadRouter.get(
  '/events/:id/photos/:photoId/original',
  requireAuth,
  originalFetchRateLimit(),
  async (req, res, next) => {
    try {
      const eventId = String(req.params.id);
      const photoId = String(req.params.photoId);

      const doc = await firestore().collection('photos').doc(photoId).get();
      if (!doc.exists || doc.data()?.eventId !== eventId) {
        res.status(404).json({ ok: false, error: 'not_found', message: 'Photo not found in this event' });
        return;
      }
      const mimeType = doc.data()?.mimeType as string | undefined;
      const name = String(doc.data()?.name ?? '');
      const filename = safeEntryName(name, photoId, origExtForMime(mimeType));

      const url = await signOrigUrl(eventId, photoId, mimeType, {
        disposition: encodeURIComponent(filename),
      });

      // Don't cache past the signed URL's TTL — re-signing returns no photo
      // bytes, so it's cheap. The image bytes themselves are cached by the
      // browser per the GCS object's response headers.
      res.setHeader('Cache-Control', 'no-store');

      if (String(req.query.format ?? '') === 'json') {
        logger.info({ eventId, photoId, by: req.user?.email }, 'single orig signed-url (json)');
        res.json({ ok: true, url, filename });
        return;
      }

      logger.info({ eventId, photoId, by: req.user?.email }, 'single orig signed-url redirect');
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  },
);
