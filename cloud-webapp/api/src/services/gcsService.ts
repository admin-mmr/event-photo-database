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
