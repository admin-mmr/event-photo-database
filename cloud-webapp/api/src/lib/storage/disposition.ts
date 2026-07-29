/**
 * disposition.ts — the one place a `Content-Disposition` is built.
 *
 * Shared by both adapters so a filename is encoded identically whether it rides
 * on a GCS `responseDisposition` or an Azure SAS `rscd`. RFC 5987 `filename*`
 * with an explicit UTF-8 charset, because event photos routinely carry Chinese
 * filenames and a bare `filename=` is latin-1 only.
 *
 * Callers pass the RAW filename. Percent-encoding here (rather than at the call
 * site, which is what `routes/download.ts` used to do) means a name can only be
 * encoded once — a double-encoded name reaches the volunteer as `%E6%B9%98…`.
 */

/**
 * `attachment; filename*=UTF-8''<encoded>` for `filename`, or `''` when there
 * is no filename to attach (i.e. serve inline).
 */
export function attachmentDisposition(filename: string | undefined): string {
  const name = (filename ?? '').trim();
  if (!name) return '';
  // encodeURIComponent leaves ! ' ( ) * alone; ' and * are the two that matter
  // inside a filename* value, since they terminate/quote the token.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}
