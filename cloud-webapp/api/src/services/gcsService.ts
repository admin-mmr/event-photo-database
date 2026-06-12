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
