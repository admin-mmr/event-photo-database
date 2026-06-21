/**
 * downloads.ts — "save photos individually" (vs the single-ZIP download).
 *
 * Individual files are the iPhone-friendly path: on a browser that can share
 * files (mobile Web Share L2) we open the native sheet with every image at once
 * so iOS offers "Save N Images to Photos". Everywhere else (most desktops) we
 * fall back to downloading each file separately.
 *
 * Pure/DOM-light so it unit-tests with a mocked `navigator`/`document`; the
 * React layer only fetches the blobs and calls in.
 */

import { canShareFiles, shareFiles, downloadBlob, type ShareOutcome } from './share.js';

export interface NamedBlob {
  blob: Blob;
  filename: string;
}

function toFiles(items: NamedBlob[]): File[] {
  return items.map(
    (i) => new File([i.blob], i.filename, { type: i.blob.type || 'application/octet-stream' }),
  );
}

/**
 * Save photos as separate files. Returns:
 *  - 'shared'      the share sheet resolved (user saved/sent them)
 *  - 'cancelled'   the user dismissed the sheet
 *  - 'unsupported' files can't be shared here → each was downloaded instead
 *  - 'error'       sharing failed → each was downloaded instead
 * Never throws (a failed share always degrades to per-file downloads).
 */
export async function savePhotosIndividually(
  items: NamedBlob[],
  opts: { title?: string } = {},
  deps: { nav?: Navigator; doc?: Document } = {},
): Promise<ShareOutcome> {
  if (items.length === 0) return 'unsupported';
  const nav = deps.nav ?? navigator;
  const doc = deps.doc ?? document;
  const files = toFiles(items);

  if (canShareFiles(files, nav)) {
    const outcome = await shareFiles(files, opts.title ? { title: opts.title } : {}, nav);
    if (outcome === 'shared' || outcome === 'cancelled') return outcome;
  }

  for (const item of items) downloadBlob(item.blob, item.filename, doc);
  return 'unsupported';
}
