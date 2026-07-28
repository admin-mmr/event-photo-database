/**
 * gcsService.ts — V4 signed URLs into the derivatives bucket (dev plan §4.2).
 *
 * Bucket layout (indexer/blobs.py):
 *   <eventId>/photos/orig/<photoId>.<ext>
 *   <eventId>/photos/web/<photoId>.jpg
 *   <eventId>/photos/thumb/<photoId>.jpg
 *
 * No public objects; everything is served via these short-lived URLs (≤60 min).
 *
 * IAM prerequisite (one-time, in the demo checklist): V4 signing with ADC on
 * Cloud Run uses the IAM signBlob API, so api-runtime@ needs
 * roles/iam.serviceAccountTokenCreator **on itself**:
 *
 *   gcloud iam service-accounts add-iam-policy-binding \
 *     api-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
 *     --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
 *     --role="roles/iam.serviceAccountTokenCreator"
 */

import type { File } from '@google-cloud/storage';
import { Storage } from '@google-cloud/storage';
import { env } from '../lib/config.js';

let storage: Storage | null = null;

function getStorage(): Storage {
  if (storage === null) {
    storage = new Storage(env.GCP_PROJECT_ID ? { projectId: env.GCP_PROJECT_ID } : {});
  }
  return storage;
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

/** GCS object key for a derivative/original of a photo. */
export function objectPath(
  eventId: string,
  photoId: string,
  kind: DerivativeKind,
  ext = 'jpg',
): string {
  return `${eventId}/photos/${kind}/${photoId}.${ext}`;
}

/** Bucket file handle for an original — used to stream bytes into a ZIP. */
export function origFile(eventId: string, photoId: string, mimeType: string | undefined): File {
  return getStorage()
    .bucket(env.DERIVATIVES_BUCKET)
    .file(objectPath(eventId, photoId, 'orig', origExtForMime(mimeType)));
}

/**
 * Signed URL for a single original (e.g. "download this one" on Results, or the
 * gallery "Save to Photos" / full-res lightbox). Bytes flow GCS → browser
 * directly, so they bill as GCS egress instead of being proxied through Cloud
 * Run + the Firebase Hosting `/api/**` rewrite (which is what made a single
 * live event day spike the Hosting line). `disposition`, when set, attaches an
 * RFC-5987 `Content-Disposition` so a direct browser navigation saves with the
 * original filename; the blob-fetch path names the File itself, so it's
 * optional there.
 */
export async function signOrigUrl(
  eventId: string,
  photoId: string,
  mimeType: string | undefined,
  opts?: { disposition?: string },
): Promise<string> {
  return signPhotoUrl(eventId, photoId, 'orig', origExtForMime(mimeType), opts);
}

export async function signPhotoUrl(
  eventId: string,
  photoId: string,
  kind: DerivativeKind = 'thumb',
  ext = 'jpg',
  opts?: { disposition?: string },
): Promise<string> {
  const objectPath = `${eventId}/photos/${kind}/${photoId}.${ext}`;
  const [url] = await getStorage()
    .bucket(env.DERIVATIVES_BUCKET)
    .file(objectPath)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + env.SIGNED_URL_TTL_MINUTES * 60 * 1000,
      ...(opts?.disposition
        ? { responseDisposition: `attachment; filename*=UTF-8''${opts.disposition}` }
        : {}),
    });
  return url;
}

/**
 * Delete every stored byte for a photo (admin delete): the original plus the
 * `web` and `thumb` derivatives. `ignoreNotFound` makes a partially-indexed
 * photo or a re-delete a no-op. `mimeType` reconstructs the orig extension the
 * indexer wrote (`origExtForMime`); web/thumb are always `.jpg`.
 */
export async function deletePhotoDerivatives(
  eventId: string,
  photoId: string,
  mimeType: string | undefined,
): Promise<void> {
  const bucket = getStorage().bucket(env.DERIVATIVES_BUCKET);
  await Promise.all([
    bucket
      .file(objectPath(eventId, photoId, 'orig', origExtForMime(mimeType)))
      .delete({ ignoreNotFound: true }),
    bucket.file(objectPath(eventId, photoId, 'web')).delete({ ignoreNotFound: true }),
    bucket.file(objectPath(eventId, photoId, 'thumb')).delete({ ignoreNotFound: true }),
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
  const [files] = await getStorage().bucket(bucketName).getFiles({ prefix, maxResults: cap + 1 });
  return { count: Math.min(files.length, cap), capped: files.length > cap };
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
  const bucket = getStorage().bucket(env.DERIVATIVES_BUCKET);
  const pageSize = opts?.pageSize ?? 500;
  const concurrency = opts?.concurrency ?? 25;
  const deadlineMs = opts?.deadlineMs ?? Number.POSITIVE_INFINITY;
  let deleted = 0;

  for (;;) {
    if (Date.now() >= deadlineMs) return { deleted, remaining: true };
    // Always re-query from the start of the prefix: the objects we just deleted
    // are gone, so page tokens would only skip work we still have to do.
    const [files] = await bucket.getFiles({ prefix: `${eventId}/`, maxResults: pageSize });
    if (files.length === 0) return { deleted, remaining: false };

    for (let i = 0; i < files.length; i += concurrency) {
      const slice = files.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(slice.map((f) => f.delete({ ignoreNotFound: true })));
      deleted += slice.length;
      if (Date.now() >= deadlineMs) return { deleted, remaining: true };
    }
    // A short page means we saw the whole prefix and just emptied it.
    if (files.length < pageSize) return { deleted, remaining: false };
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

/** GCS object key for a user's reference selfie. */
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
  await getStorage()
    .bucket(env.UPLOADS_BUCKET)
    .file(path)
    .save(buffer, { contentType, resumable: false });
  return path;
}

/** Download a stored reference selfie's bytes (for re-running a search). */
export async function readReference(gcsPath: string): Promise<Buffer> {
  const [buf] = await getStorage().bucket(env.UPLOADS_BUCKET).file(gcsPath).download();
  return buf;
}

/** Delete a stored reference selfie's object (My Data delete, M3.4). Uses
 *  `ignoreNotFound` so a re-delete or an already-expired object is a no-op. */
export async function deleteReferenceObject(gcsPath: string): Promise<void> {
  await getStorage().bucket(env.UPLOADS_BUCKET).file(gcsPath).delete({ ignoreNotFound: true });
}

/** Short-lived signed read URL for displaying a stored reference in the picker. */
export async function signReferenceUrl(gcsPath: string): Promise<string> {
  const [url] = await getStorage()
    .bucket(env.UPLOADS_BUCKET)
    .file(gcsPath)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + env.SIGNED_URL_TTL_MINUTES * 60 * 1000,
    });
  return url;
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
 * the per-page IAM signBlob round-trips (V4 signing under ADC on Cloud Run is
 * one IAM call per signature), so the first page of photos paints noticeably
 * faster. The `web` URL is signed on demand via `signPhotoUrl(..., 'web')`.
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
