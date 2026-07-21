/**
 * zipDownload.ts — bulk "download as ZIP", assembled in the browser.
 *
 * The api signs the selection in one call (POST /api/events/:id/download →
 * { files: [{ url, filename }] }); we then fetch each original straight from its
 * signed GCS URL and zip them client-side (see ./zip). This keeps the heavy
 * original bytes off the Firebase Hosting `/api/**` rewrite — only the small
 * JSON of signed URLs goes through the service. Requires bucket CORS
 * (infra/scripts/provision-derivatives-cors.sh) so the cross-origin GCS reads
 * are allowed.
 */

import { apiPost } from './api.js';
import { getRecaptchaToken } from './recaptcha.js';
import { downloadBlob } from './share.js';
import { reportClientError } from './reportError.js';
import { buildStoreZip, type ZipEntry } from './zip.js';
import type { DownloadRequest, DownloadSignResponse } from '@cloud-webapp/shared';

/** Fetch with a small concurrency cap so a big selection doesn't open 200 sockets. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ZipDownloadResult {
  /** Entries successfully fetched and included in the ZIP. */
  included: number;
  /** Entries whose original couldn't be fetched (skipped, not fatal). */
  failed: number;
}

/**
 * Download `photoIds` from `eventId` as a single ZIP named `zipName`.
 * A few unreadable originals are skipped rather than failing the whole archive,
 * mirroring the old server behaviour. Throws only if signing fails or every
 * original fails to fetch.
 */
export async function downloadOriginalsZip(
  eventId: string,
  photoIds: string[],
  zipName: string,
): Promise<ZipDownloadResult> {
  const body: DownloadRequest = { photoIds };
  const recaptchaToken = await getRecaptchaToken('download');
  const { files } = await apiPost<DownloadSignResponse, DownloadRequest>(
    `/api/events/${encodeURIComponent(eventId)}/download`,
    body,
    recaptchaToken ? { headers: { 'X-Recaptcha-Token': recaptchaToken } } : undefined,
  );

  let failed = 0;
  // Keep a few sample failure reasons so an alert can pinpoint the cause
  // (e.g. a CORS error vs. an HTTP 403 on the signed URL) without logging one
  // line per photo.
  const sampleErrors: string[] = [];
  const fetched = await mapLimit(files, 6, async (f): Promise<ZipEntry | null> => {
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      return { name: f.filename, data };
    } catch (e) {
      failed += 1;
      if (sampleErrors.length < 3) {
        sampleErrors.push(e instanceof Error ? e.message : String(e));
      }
      return null;
    }
  });

  const entries = fetched.filter((e): e is ZipEntry => e !== null);
  if (entries.length === 0) {
    // Every signed-URL fetch failed — a real outage (commonly the derivatives
    // bucket missing its CORS rule). Report it so ops gets an email alert; the
    // user only sees the thrown message.
    reportClientError('download_failed', 'ZIP download: every original failed to fetch', {
      context: {
        eventId,
        requested: photoIds.length,
        signed: files.length,
        failed,
        sampleErrors,
      },
    });
    throw new Error('None of the selected photos could be downloaded.');
  }

  downloadBlob(buildStoreZip(entries), zipName);
  return { included: entries.length, failed };
}
