/**
 * scriptUrl — canonical deployment URL helpers.
 *
 * `ScriptApp.getService().getUrl()` returns a different URL depending on the
 * caller's Google account type. Google has used TWO Workspace URL shapes over
 * time (and both still appear in the wild), so we must handle all three:
 *   • External Gmail  → https://script.google.com/macros/s/<DEPLOY_ID>/exec
 *   • Workspace (new) → https://script.google.com/a/<domain>/macros/s/<DEPLOY_ID>/exec
 *   • Workspace (old) → https://script.google.com/a/macros/<domain>/s/<DEPLOY_ID>/exec
 *
 * That's fatal for OAuth 2.0: the `redirect_uri` sent to Google's authorize
 * endpoint must match byte-for-byte a URI registered on the OAuth client, and
 * the `redirect_uri` sent during the subsequent code→token exchange must match
 * the one used at authorize time. If we use the raw ScriptApp URL, Workspace
 * and external users end up sending different redirect_uris — requiring every
 * possible form to be registered AND producing a mismatch whenever the two
 * phases run under different account contexts.
 *
 * getCanonicalScriptUrl() extracts the deployment ID from whatever URL shape
 * ScriptApp returns and rebuilds the canonical, domain-free form. As a result:
 *   1. Only one redirect URI needs to be registered in GCP.
 *   2. Workspace and external users always produce the exact same redirect_uri.
 *   3. Workspace users get transparently redirected by Google from
 *      /macros/s/.../exec → /a/<domain>/macros/s/.../exec on arrival, with
 *      any query-string (?code=...) preserved — so no UX change.
 */

/* global ScriptApp */

/**
 * Returns the deployment URL in the canonical (non-Workspace) form
 * `https://script.google.com/macros/s/<DEPLOY_ID>/exec`.
 *
 * Works regardless of which account the script is currently executing as and
 * regardless of which Workspace URL shape Google happens to emit today.
 * Extracts the deployment ID and rebuilds the URL rather than pattern-matching
 * the prefix — that way, any future Workspace URL shape still canonicalises
 * correctly.
 */
export function getCanonicalScriptUrl(): string {
  const raw = ScriptApp.getService().getUrl();
  // The deployment ID is always sandwiched between "/s/" and "/exec" regardless
  // of URL shape. Everything before "/s/" is per-account boilerplate we want to
  // discard.
  const match = raw.match(/\/s\/([^/]+)\/exec\b/);
  if (!match) {
    // Unexpected shape — return the raw URL so we don't silently break sign-in
    // if Google changes the URL format again. The redirect_uri mismatch will
    // surface visibly and we'll fix the regex.
    return raw;
  }
  return `https://script.google.com/macros/s/${match[1]}/exec`;
}
