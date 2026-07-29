/**
 * gcsService.ts — short-lived read URLs and object lifecycle for the buckets
 * (dev plan §4.2).
 *
 * Bucket layout (indexer/blobs.py):
 *   <eventId>/photos/orig/<photoId>.<ext>
 *   <eventId>/photos/web/<photoId>.jpg
 *   <eventId>/photos/thumb/<photoId>.jpg
 *
 * No public objects; everything is served via these short-lived URLs (≤60 min).
 *
 * Every byte goes through `lib/storage.ts`'s provider-neutral `ObjectStore`
 * (AZ2) — this module holds the app's *key layout and policy*, the adapter holds
 * the provider. The name is kept as `gcsService` so the ~14 importing modules
 * were untouched by the port; read it as "the object service", not "the GCS
 * client". Signing prerequisites (IAM signBlob on GCP, Storage Blob Delegator on
 * Azure) live in `lib/storage/gcsStore.ts` / `blobStore.ts`.
 */

import { env } from '../lib/config.js';
import { objectStore } from '../lib/storage.js';

/** Signed-URL lifetime, capped at 60 minutes by the config schema (PRD §4.2). */
function ttlMs(): number {
  return env.SIGNED_URL_TTL_MINUTES * 60 * 1000;
}

export type DerivativeKind = 'thumb' | 'web' | 'orig';

/**
 * MIME → original file extension. Mirrors `ORIG_EXT_BY_MIME` in
 * `indexer/job.py` so we reconstruct the exact `orig/<photoId>.<ext>` key the
 * indexer wrote. Keep the two in sync. Unknown types fall back to `bin`, which
 * is what the indexer stores them under too.
 */
export const ORIG_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export function origExtForMime(mimeType: string | undefined): string {
  return (mimeType && ORIG_EXT_BY_MIME[mimeType]) || 'bin';
}

/** Object key for a derivative/original of a photo. */
export function objectPath(
  eventId: string,
  photoId: string,
  kind: DerivativeKind,
  ext = 'jpg',
): string {
  return `${eventId}/photos/${kind}/${photoId}.${ext}`;
}

/**
 * Signed URL for a single original (e.g. "download this one" on Results, or the
 * gallery "Save to Photos" / full-res lightbox). Bytes flow from the bucket to
 * the browser directly, so they bill as storage egress instead of being proxied
 * through Cloud Run + the Firebase Hosting `/api/**` rewrite (which is what made
 * a single live event day spike the Hosting line). `filename`, when set,
 * attaches a `Content-Disposition` so a direct browser navigation saves under
 * the original name; the blob-fetch path names the File itself, so it's optional
 * there. Pass the RAW filename — the adapter does the RFC-5987 encoding.
 */
export async function signOrigUrl(
  eventId: string,
  photoId: string,
  mimeType: string | undefined,
  opts?: { filename?: string },
): Promise<string> {
  return signPhotoUrl(eventId, photoId, 'orig', origExtForMime(mimeType), opts);
}

export async function signPhotoUrl(
  eventId: string,
  photoId: string,
  kind: DerivativeKind = 'thumb',
  ext = 'jpg',
  opts?: { filename?: string },
): Promise<string> {
  return objectStore().signReadUrl(env.DERIVATIVES_BUCKET, objectPath(eventId, photoId, kind, ext), {
    ttlMs: ttlMs(),
    ...(opts?.filename ? { filename: opts.filename } : {}),
  });
}

/**
 * Delete every stored byte for a photo (admin delete): the original plus the
 * `web` and `thumb` derivatives. A partially-indexed photo or a re-delete is a
 * no-op, because a missing object never errors. `mimeType` reconstructs the orig
 * extension the indexer wrote (`origExtForMime`); web/thumb are always `.jpg`.
 */
export async function deletePhotoDerivatives(
  eventId: string,
  photoId: string,
  mimeType: string | undefined,
): Promise<void> {
  const store = objectStore();
  const bucket = env.DERIVATIVES_BUCKET;
  await Promise.all([
    store.remove(bucket, objectPath(eventId, photoId, 'orig', origExtForMime(mimeType))),
    store.remove(bucket, objectPath(eventId, photoId, 'web')),
    store.remove(bucket, objectPath(eventId, photoId, 'thumb')),
  ]);
}

// ── Whole-event sweeps (event deletion) ──────────────────────────────────────

/** Cap on a counting scan, so an inventory of a huge event stays cheap. */
const COUNT_SCAN_CAP = 5000;

/** Objects under a prefix, counted up to `cap`. `capped` means "at least this many". */
async function countUnderPrefix(
  bucketName: string,
  prefix: string,
  cap = COUNT_SCAN_CAP,
): Promise<{ count: number; capped: boolean }> {
  const objects = await objectStore().list(bucketName, { prefix, limit: cap + 1 });
  return { count: Math.min(objects.length, cap), capped: objects.length > cap };
}

/** Objects under `<eventId>/` in the derivatives bucket (originals + web/thumb + vectors). */
export function countEventDerivatives(eventId: string): Promise<{ count: number; capped: boolean }> {
  return countUnderPrefix(env.DERIVATIVES_BUCKET, `${eventId}/`);
}

/**
 * Staged volunteer uploads still sitting in the staging bucket for this event
 * (`<prefix>/<eventId>/…`, written by createResumableSession).
 *
 * COUNTED, NEVER DELETED. A staged object can be the only copy of a photo that
 * never made it to Drive — deleting one is the mistake that destroyed volunteer
 * photos on 2026-07-27/28. The staging bucket's lifecycle rule reclaims them, and
 * until it does `recover-staged-uploads.sh` can still rescue them.
 */
export function countStagedObjectsForEvent(eventId: string): Promise<{ count: number; capped: boolean }> {
  return countUnderPrefix(env.VOLUNTEER_STAGING_BUCKET, `${env.VOLUNTEER_STAGING_PREFIX}/${eventId}/`);
}

/**
 * Delete every object under `<eventId>/` in the derivatives bucket — the mirrored
 * originals, the web/thumb derivatives and the embedding `.npy`s + manifest.
 *
 * Bounded by `deadlineMs` (an absolute epoch ms) and reports `remaining: true`
 * when it stopped early, because a big event has thousands of objects and this
 * runs inside a request that Firebase Hosting kills at 60s. Deleting is
 * idempotent, so the caller just runs it again.
 *
 * These bytes are regenerable: a re-index rebuilds them from the Drive original.
 */
export async function deleteEventDerivatives(
  eventId: string,
  opts?: { deadlineMs?: number; pageSize?: number; concurrency?: number },
): Promise<{ deleted: number; remaining: boolean }> {
  const store = objectStore();
  const bucket = env.DERIVATIVES_BUCKET;
  const pageSize = opts?.pageSize ?? 500;
  const concurrency = opts?.concurrency ?? 25;
  const deadlineMs = opts?.deadlineMs ?? Number.POSITIVE_INFINITY;
  let deleted = 0;

  for (;;) {
    if (Date.now() >= deadlineMs) return { deleted, remaining: true };
    // Always re-query from the start of the prefix: the objects we just deleted
    // are gone, so page tokens would only skip work we still have to do.
    // eslint-disable-next-line no-await-in-loop
    const objects = await store.list(bucket, { prefix: `${eventId}/`, limit: pageSize });
    if (objects.length === 0) return { deleted, remaining: false };

    for (let i = 0; i < objects.length; i += concurrency) {
      const slice = objects.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(slice.map((o) => store.remove(bucket, o.key)));
      deleted += slice.length;
      if (Date.now() >= deadlineMs) return { deleted, remaining: true };
    }
    // A short page means we saw the whole prefix and just emptied it.
    if (objects.length < pageSize) return { deleted, remaining: false };
  }
}

// ── Reference selfies (uploads bucket; PRD §6.1, D7 reuse) ───────────────────

/** MIME → extension for stored reference selfies (uploads bucket). */
const REF_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
};

export function referenceExtForMime(mimeType: string | undefined): string {
  return (mimeType && REF_EXT_BY_MIME[mimeType]) || 'jpg';
}

/** Object key for a user's reference selfie. */
export function referencePath(uid: string, uploadId: string, mimeType: string | undefined): string {
  return `find_me_references/${uid}/${uploadId}.${referenceExtForMime(mimeType)}`;
}

/** Store a reference selfie in the uploads bucket. Returns the object path. */
export async function uploadReference(
  uid: string,
  uploadId: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const path = referencePath(uid, uploadId, contentType);
  await objectStore().write(env.UPLOADS_BUCKET, path, buffer, { contentType });
  return path;
}

/** Download a stored reference selfie's bytes (for re-running a search). */
export async function readReference(gcsPath: string): Promise<Buffer> {
  return objectStore().read(env.UPLOADS_BUCKET, gcsPath);
}

/** Delete a stored reference selfie's object (My Data delete, M3.4). A re-delete
 *  or an already-expired object is a no-op. */
export async function deleteReferenceObject(gcsPath: string): Promise<void> {
  await objectStore().remove(env.UPLOADS_BUCKET, gcsPath);
}

/** Short-lived signed read URL for displaying a stored reference in the picker. */
export async function signReferenceUrl(gcsPath: string): Promise<string> {
  return objectStore().signReadUrl(env.UPLOADS_BUCKET, gcsPath, { ttlMs: ttlMs() });
}

/** Sign thumb + web for a batch of photos. Order preserved. */
export async function signPhotoUrls(
  eventId: string,
  photoIds: string[],
): Promise<Array<{ photoId: string; thumbUrl: string; webUrl: string }>> {
  return Promise.all(
    photoIds.map(async (photoId) => {
      const [thumbUrl, webUrl] = await Promise.all([
        signPhotoUrl(eventId, photoId, 'thumb'),
        signPhotoUrl(eventId, photoId, 'web'),
      ]);
      return { photoId, thumbUrl, webUrl };
    }),
  );
}

/**
 * Sign ONLY the thumbnail for a batch of photos. Order preserved.
 *
 * The gallery grid shows thumbnails; the full-size `web` derivative is only
 * needed when a photo is opened in the lightbox. Signing thumbs alone halves
 * the per-page signing round-trips (V4 signing under ADC on Cloud Run is one IAM
 * call per signature), so the first page of photos paints noticeably faster. The
 * `web` URL is signed on demand via `signPhotoUrl(..., 'web')`.
 */
export async function signThumbUrls(
  eventId: string,
  photoIds: string[],
): Promise<Array<{ photoId: string; thumbUrl: string }>> {
  return Promise.all(
    photoIds.map(async (photoId) => ({
      photoId,
      thumbUrl: await signPhotoUrl(eventId, photoId, 'thumb'),
    })),
  );
}
