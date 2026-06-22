/**
 * share.ts — "Save to phone" via the Web Share API Level 2 (FR-13 / M4.3).
 *
 * A web app cannot silently write to the OS photo library, so the UX hands the
 * file(s) to the native share sheet, which lets the user pick "Save to Photos /
 * Gallery". Where Web Share L2 (sharing files) isn't available — most desktop
 * browsers — we fall back to a normal download.
 *
 * These helpers are pure/DOM-light so they unit-test cleanly with a mocked
 * `navigator`; the React layer only decides which to call.
 */

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'error';

/** True when the browser can share these specific files (Web Share L2). */
export function canShareFiles(files: File[], nav: Navigator = navigator): boolean {
  if (files.length === 0) return false;
  const n = nav as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (typeof n.share !== 'function' || typeof n.canShare !== 'function') return false;
  try {
    return n.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * True when this browser can actually hand image files to the native share
 * sheet — i.e. when a "Save to Photos" action is meaningful. Probes with a tiny
 * representative JPEG so it matches exactly what {@link canShareFiles} will
 * accept at save time.
 *
 * The UI used to gate the button on `typeof navigator.share === 'function'`,
 * which is broader than file-sharing support: a browser can expose `share`
 * (Web Share L1 — text/URL only) without `canShare({files})`. That mismatch
 * either showed a "Save to Photos" button that silently degraded to downloads,
 * or hid it entirely on browsers without `canShare` while leaving no non-ZIP
 * save at all. Gate on this helper instead, and always keep a non-ZIP fallback.
 */
export function canShareImageFiles(nav: Navigator = typeof navigator !== 'undefined' ? navigator : ({} as Navigator)): boolean {
  try {
    const probe = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'probe.jpg', {
      type: 'image/jpeg',
    });
    return canShareFiles([probe], nav);
  } catch {
    return false;
  }
}

/**
 * Opens the native share sheet for the given files. Returns:
 *  - 'shared'      the share resolved (user picked a target)
 *  - 'cancelled'   the user dismissed the sheet (AbortError)
 *  - 'unsupported' this browser can't share files (caller should fall back)
 *  - 'error'       an unexpected failure (caller should fall back)
 * Never throws.
 */
export async function shareFiles(
  files: File[],
  opts: { title?: string; text?: string } = {},
  nav: Navigator = navigator,
): Promise<ShareOutcome> {
  if (!canShareFiles(files, nav)) return 'unsupported';
  try {
    await (nav as Navigator & { share: (d: ShareData) => Promise<void> }).share({
      files,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.text ? { text: opts.text } : {}),
    });
    return 'shared';
  } catch (err) {
    // The user dismissing the sheet rejects with AbortError — not a real error.
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    return 'error';
  }
}

/** Save a blob to disk via a transient object URL (download fallback). */
export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/**
 * Try the share sheet first; if files can't be shared (or sharing errors), save
 * the blob as a download instead. Returns the share outcome that was attempted
 * ('unsupported'/'error' mean the download fallback ran).
 */
export async function saveToPhone(
  blob: Blob,
  filename: string,
  opts: { title?: string } = {},
  deps: { nav?: Navigator; doc?: Document } = {},
): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  const doc = deps.doc ?? document;
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const outcome = await shareFiles([file], { title: opts.title ?? filename }, nav);
  if (outcome === 'unsupported' || outcome === 'error') {
    downloadBlob(blob, filename, doc);
  }
  return outcome;
}
