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

/** Signed URL for a single original (e.g. "download this one" on Results). */
export async function signOrigUrl(
  eventId: string,
  photoId: string,
  mimeType: string | undefined,
): Promise<string> {
  return signPhotoUrl(eventId, photoId, 'orig', origExtForMime(mimeType));
}

export async function signPhotoUrl(
  eventId: string,
  photoId: string,
  kind: DerivativeKind = 'thumb',
  ext = 'jpg',
): Promise<string> {
  const objectPath = `${eventId}/photos/${kind}/${photoId}.${ext}`;
  const [url] = await getStorage()
    .bucket(env.DERIVATIVES_BUCKET)
    .file(objectPath)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + env.SIGNED_URL_TTL_MINUTES * 60 * 1000,
    });
  return url;
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
