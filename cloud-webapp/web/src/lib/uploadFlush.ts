/**
 * uploadFlush.ts — hand finished uploads to the server as the session goes,
 * not only at the very end.
 *
 * The page used to call /complete once, after EVERY selected file had
 * uploaded. A volunteer who closed the tab, let the laptop sleep, or quit the
 * browser part-way left everything sent so far stranded in staging, with no
 * error anywhere: on NYC Marathon night (2026-11-02) a 1,087-file session
 * stopped dead at 03:44 and none of its 748 photos reached the gallery until an
 * admin recovered them. Flushing every FLUSH_EVERY files bounds what an
 * abandoned session can strand, and starts the Drive copy while the rest is
 * still uploading.
 *
 * Re-sending a flush is safe: the server derives each copy chunk's id from the
 * object names it holds, so the same items map to the same Cloud Tasks names.
 */

import type { CompleteUploadRequest } from '@cloud-webapp/shared';

import type { UploadResult } from './resumableUpload.js';

/** Files per incremental /complete. Keeps a page-hide beacon under its 64 KB cap. */
export const FLUSH_EVERY = 100;

/** Identity of a picked file, for spotting the same photo added twice. */
export function fileKey(f: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

/**
 * The files in `incoming` that are not already in the list (or repeated within
 * `incoming` itself). Picking the same folder twice used to queue every photo
 * twice: one 1,087-file session held only 748 distinct photos.
 */
export function newFilesOnly<F extends Pick<File, 'name' | 'size' | 'lastModified'>>(
  existing: ReadonlyArray<F>,
  incoming: ReadonlyArray<F>,
): F[] {
  const seen = new Set(existing.map(fileKey));
  const out: F[] = [];
  for (const f of incoming) {
    const k = fileKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Results not yet handed to the server. */
export function unflushed(results: ReadonlyArray<UploadResult>, flushed: ReadonlySet<string>): UploadResult[] {
  return results.filter((r) => !flushed.has(r.uploadId));
}

/** The /complete body for one flush. `sessionTotal` lets the receipt count the session. */
export function completeBody(
  token: string,
  batchId: string,
  batch: ReadonlyArray<UploadResult>,
  sessionTotal: number,
  fileNameOf: (r: UploadResult) => string,
): CompleteUploadRequest {
  return {
    token,
    batchId,
    items: batch.map((r) => ({
      uploadId: r.uploadId,
      objectName: r.objectName,
      fileName: fileNameOf(r),
      bytes: r.bytes,
    })),
    sessionTotal,
  };
}
