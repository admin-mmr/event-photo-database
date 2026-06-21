/**
 * download.ts — POST /api/events/:id/download → streaming `application/zip`
 * of original-resolution photos (dev plan §5A B1 / FR-12, FR-14).
 *
 * Body: { photoIds: string[] }  (1..MAX_DOWNLOAD_PHOTOS)
 *
 * The ZIP streams the *originals* mirrored to the derivatives bucket
 * (`<eventId>/photos/orig/<photoId>.<ext>`), not the web/thumb serving copies,
 * so attendees get full-resolution files. Bytes flow GCS → archiver → response
 * without buffering whole files server-side.
 *
 * Scope notes (tracked in the dev plan):
 *  - Per-user rate limit + reCAPTCHA on this action land with M5.3; for now the
 *    photo-count cap (shared MAX_DOWNLOAD_PHOTOS) bounds abuse/cost.
 *  - The client holds the assembled ZIP in memory (blob download). Fine for the
 *    capped selection sizes; streaming-to-disk is a follow-up if users hit the
 *    cap routinely.
 */

import archiver from 'archiver';
import { Router } from 'express';
import { DownloadRequestSchema } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { downloadRateLimit, originalFetchRateLimit } from '../middleware/rateLimit.js';
import { origFile, origExtForMime } from '../services/gcsService.js';

export const downloadRouter = Router();

// Characters illegal in ZIP entry / cross-platform filenames.
const ILLEGAL_NAME_CHARS = /["*/:<>?\\|]/g;

/** Make a Drive filename safe as a ZIP entry: basename only, no separators. */
function safeEntryName(name: string, photoId: string, fallbackExt: string): string {
  const base = (name || '').split(/[/\\]/).pop()?.trim() ?? '';
  const cleaned = base.replace(ILLEGAL_NAME_CHARS, '_');
  return cleaned || `${photoId}.${fallbackExt}`;
}

/**
 * Build a header-safe `Content-Disposition` value. HTTP header values must be
 * Latin-1, but photo/event names are frequently Unicode (e.g. CJK), which makes
 * `res.setHeader` throw `ERR_INVALID_CHAR` and 500 the request. We emit an
 * ASCII-only `filename=` fallback for old clients plus an RFC 5987
 * `filename*=UTF-8''…` form so modern clients still get the original name.
 */
function contentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8}`;
}

downloadRouter.post('/events/:id/download', requireAuth, downloadRateLimit(), async (req, res, next) => {
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

    // Stream the ZIP. Once headers are sent we can no longer change the status,
    // so any archiver error past that point just tears down the connection.
    const zipName = `${(eventDoc.data()?.name as string) || eventId}-photos.zip`.replace(
      ILLEGAL_NAME_CHARS,
      '_',
    );
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(zipName));
    res.setHeader('Cache-Control', 'no-store');

    const archive = archiver('zip', { zlib: { level: 0 } }); // photos are already compressed
    let failed = 0;
    archive.on('warning', (err) => logger.warn({ err, eventId }, 'zip warning'));
    archive.on('error', (err) => {
      logger.error({ err, eventId }, 'zip stream error');
      res.destroy(err);
    });
    archive.pipe(res);

    const usedNames = new Set<string>();
    for (const p of photos) {
      const ext = (p.mimeType && p.mimeType.split('/')[1]) || 'jpg';
      let entry = safeEntryName(p.name, p.photoId, ext);
      // Disambiguate duplicate filenames so no entry is silently overwritten.
      if (usedNames.has(entry)) {
        const dot = entry.lastIndexOf('.');
        const stem = dot > 0 ? entry.slice(0, dot) : entry;
        const tail = dot > 0 ? entry.slice(dot) : '';
        entry = `${stem}_${p.photoId.slice(0, 6)}${tail}`;
      }
      usedNames.add(entry);

      // Per-file read stream; on error we log and continue rather than aborting
      // the whole ZIP (one missing original shouldn't lose the rest).
      const stream = origFile(eventId, p.photoId, p.mimeType).createReadStream();
      stream.on('error', (err) => {
        failed += 1;
        logger.warn({ err, eventId, photoId: p.photoId }, 'orig read failed, skipping entry');
      });
      archive.append(stream, { name: entry });
    }

    logger.info(
      { eventId, requested: photoIds.length, included: photos.length, by: req.user?.email },
      'zip download streaming',
    );
    await archive.finalize();
    if (failed) logger.warn({ eventId, failed }, 'zip finished with skipped entries');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id/photos/:photoId/original — stream a single original as an
 * attachment (FR-12). Powers the "save photos individually" option, which on
 * iOS hands the files to the share sheet ("Save N Images to Photos"). Same
 * auth + event-ownership checks as the ZIP route, but its OWN rate-limit bucket
 * (§5B C1): one user save fans out into N of these, so it must not draw down the
 * bulk-ZIP `download` budget.
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

      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(filename));
      res.setHeader('Cache-Control', 'no-store');

      const stream = origFile(eventId, photoId, mimeType).createReadStream();
      stream.on('error', (err) => {
        logger.warn({ err, eventId, photoId }, 'single orig read failed');
        if (!res.headersSent) {
          res.status(502).json({ ok: false, error: 'read_failed', message: 'Could not read photo' });
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);
