/**
 * originals.ts — read one original photo's bytes.
 *
 * Deliberately TWO hops: ask the api for a signed GCS URL (JSON), then
 * `fetch()` that URL directly. The api can also 302 straight to the signed URL,
 * and letting `fetch()` follow that redirect looks equivalent — it isn't.
 *
 * On a cross-origin redirect the browser taints the request origin (so GCS sees
 * `Origin: null`, which the bucket's CORS config — a list of explicit web
 * origins — does not match) and, depending on browser and version, may still
 * carry the `Authorization` header from the first hop (which GCS rejects on a
 * URL that already carries its own signed auth). Either one fails the read, and
 * the variation across browsers is what made "Save to Photos" fail on iOS
 * Safari while the ZIP download — which fetches signed URLs directly — worked
 * on the very same photo.
 *
 * Fetching the signed URL ourselves puts this on that same proven path. It
 * costs no extra api round-trips: the JSON response simply replaces the 302.
 *
 * Still requires bucket CORS for the web origin —
 * infra/scripts/provision-derivatives-cors.sh.
 */

import { apiGet } from './api.js';

export interface SignedOriginal {
  url: string;
  filename: string;
}

/** Ask the api to sign one original; no photo bytes move on this call. */
export async function signOriginal(eventId: string, photoId: string): Promise<SignedOriginal> {
  const res = await apiGet<{ ok: boolean; url: string; filename?: string }>(
    `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(photoId)}/original?format=json`,
  );
  if (!res.url) throw new Error('No signed URL returned for the original');
  return { url: res.url, filename: res.filename || `${photoId}.jpg` };
}

/**
 * Fetch one original's bytes. Throws on a failed sign or a failed byte read —
 * callers treat a throw as "this photo could not be loaded".
 */
export async function fetchOriginalBlob(eventId: string, photoId: string): Promise<Blob> {
  const { url } = await signOriginal(eventId, photoId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`original fetch failed: HTTP ${res.status}`);
  return res.blob();
}
