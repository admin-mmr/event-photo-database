/**
 * zipDownload.ts — bulk "download as ZIP", assembled in the browser.
 *
 * Originals come from the shared {@link OriginalsFetcher}, so a ZIP reuses
 * whatever the mobile "Save to Photos" prefetch already pulled down instead of
 * transferring the same photos again — on a phone those two paths used to race
 * each other for the same bytes over the same connection, which is a large part
 * of why "Preparing…" took minutes. The fetcher signs the selection in one call
 * and reads the signed GCS URLs directly, keeping the heavy bytes off the
 * Firebase Hosting `/api/**` rewrite. Requires bucket CORS
 * (infra/scripts/provision-derivatives-cors.sh) for the cross-origin reads.
 */

import { downloadBlob } from './share.js';
import { reportClientError } from './reportError.js';
import { buildStoreZip, type ZipEntry } from './zip.js';
import type { OriginalsFetcher } from './originals.js';

export interface ZipDownloadResult {
  /** Entries successfully fetched and included in the ZIP. */
  included: number;
  /** Entries whose original couldn't be fetched (skipped, not fatal). */
  failed: number;
}

export interface ZipDownloadOptions {
  /** Reports transfer progress so the button counts up instead of just hanging. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Download `photoIds` from `eventId` as a single ZIP named `zipName`.
 * A few unreadable originals are skipped rather than failing the whole archive,
 * mirroring the old server behaviour. Throws only if every original fails.
 */
export async function downloadOriginalsZip(
  fetcher: OriginalsFetcher,
  eventId: string,
  photoIds: string[],
  zipName: string,
  opts: ZipDownloadOptions = {},
): Promise<ZipDownloadResult> {
  let done = 0;
  const { entries, failed, sampleErrors } = await fetcher.fetch(photoIds, {
    onSettled: () => {
      done += 1;
      opts.onProgress?.(done, photoIds.length);
    },
  });

  if (entries.length === 0) {
    // Every original failed — a real outage (commonly the derivatives bucket
    // missing its CORS rule). Report it so ops gets an email alert; the user
    // only sees the thrown message.
    reportClientError('download_failed', 'ZIP download: every original failed to fetch', {
      context: { eventId, requested: photoIds.length, failed, sampleErrors },
    });
    throw new Error('None of the selected photos could be downloaded.');
  }

  const zipEntries: ZipEntry[] = await Promise.all(
    entries.map(async (e) => ({
      name: e.filename,
      data: new Uint8Array(await e.blob.arrayBuffer()),
    })),
  );

  downloadBlob(buildStoreZip(zipEntries), zipName);
  return { included: zipEntries.length, failed };
}
