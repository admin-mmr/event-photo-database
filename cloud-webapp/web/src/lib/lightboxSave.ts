/**
 * lightboxSave.ts — which originals the gallery downloads, and what the
 * lightbox's single-photo "Save to Photos" button does.
 *
 * Originals average ~6 MB against ~350 KB for the `web` derivative, and every
 * byte leaves the derivatives bucket as billed storage egress, which was the
 * largest line on the August 2026 bill. The lightbox used to prefetch the
 * original of whatever photo it was showing, so on mobile merely *browsing*
 * downloaded full-resolution files.
 *
 * Now an original is only downloaded on intent:
 *   - it is selected (the batch "Save N to Photos" must share synchronously), or
 *   - the user tapped "Save to Photos" on it in the lightbox.
 *
 * The lightbox save is therefore two taps on mobile: the first downloads the
 * original ("Preparing…"), the second opens the share sheet. It cannot be one
 * tap without the prefetch: iOS only honours `navigator.share()` inside the
 * tap's user activation, and awaiting a multi-megabyte fetch burns it.
 */

/** Originals to keep downloaded: the selection plus an explicit lightbox save. */
export function originalsNeeded(
  selected: Iterable<string>,
  requested: string | null,
): Set<string> {
  const s = new Set<string>(selected);
  if (requested) s.add(requested);
  return s;
}

/**
 * State of the lightbox's single-photo save button.
 * - `download`  desktop: tap fetches and downloads (no share sheet involved)
 * - `prepare`   mobile, original not downloaded: tap starts the download
 * - `preparing` mobile, download in flight: disabled
 * - `save`      mobile, original already cached (e.g. selected): tap shares
 * - `tapToSave` mobile, original just downloaded on request: tap shares
 */
export type LightboxSaveState = 'download' | 'prepare' | 'preparing' | 'save' | 'tapToSave';

export function lightboxSaveState(opts: {
  canSavePhotos: boolean;
  cached: boolean;
  requested: boolean;
  failed: boolean;
}): LightboxSaveState {
  if (!opts.canSavePhotos) return 'download';
  if (opts.cached) return opts.requested ? 'tapToSave' : 'save';
  // A failed download drops back to `prepare` so the next tap retries, rather
  // than pinning the button on "Preparing…".
  if (opts.requested && !opts.failed) return 'preparing';
  return 'prepare';
}

/**
 * Image the lightbox displays. An original is shown only when it is already in
 * memory for another reason (selected, or requested for saving): displaying it
 * then costs nothing extra. Otherwise the `web` derivative, then the thumbnail
 * while `web` is still being signed.
 */
export function lightboxSrc(opts: {
  canSavePhotos: boolean;
  origUrl?: string | undefined;
  webUrl?: string | undefined;
  thumbUrl: string;
}): string {
  return (opts.canSavePhotos ? opts.origUrl : undefined) ?? opts.webUrl ?? opts.thumbUrl;
}
