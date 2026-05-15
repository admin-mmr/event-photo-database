/**
 * SessionService — server-side session management via CacheService.
 *
 * After a successful Google Identity Services login (client-side), the server
 * creates a session token and stores {email, role} in the Script Cache.
 *
 * The client stores the token in sessionStorage and passes it with every
 * google.script.run call and every page navigation (?session=TOKEN).
 *
 * Sessions expire after SESSION_TTL_SECONDS (30 min) of INACTIVITY — every
 * successful lookup refreshes the TTL (sliding expiration), so an active
 * user stays logged in indefinitely while an idle session still times out.
 *
 * The cache is shared across all users (Script Cache) keyed by a UUID token,
 * so there is no cross-user data leakage.
 */

/* global CacheService, Utilities */

const SESSION_TTL_SECONDS = 1800; // 30 minutes of inactivity
const CACHE_PREFIX = 'xsd_sess_';

interface SessionPayload {
  email: string;
  role:  string;
  /** Optional display name carried alongside the session. For volunteer
   *  sessions, this is the photographer's typed name from the confirm page
   *  and is used as the second component of credited filenames. */
  displayName?: string;
}

/**
 * Creates a new session for the given email/role and returns the session token.
 *
 * @param displayName  Optional human-readable name to carry with the session.
 *                     Volunteer sessions use this to label every uploaded file
 *                     with a photographer credit.
 */
export function createSession(email: string, role: string, displayName?: string): string {
  const token   = Utilities.getUuid();
  const payload: SessionPayload = { email, role };
  if (displayName && displayName.trim()) payload.displayName = displayName.trim();
  CacheService.getScriptCache().put(
    CACHE_PREFIX + token,
    JSON.stringify(payload),
    SESSION_TTL_SECONDS
  );
  return token;
}

/**
 * Looks up a session token and returns {email, role} or null if missing/expired.
 *
 * On a successful lookup, the cache entry is re-written with the full TTL
 * (sliding expiration). This ensures an active user's session does not hit
 * a hard 30-minute wall from login time — only real inactivity expires them.
 */
export function lookupSession(token: string): SessionPayload | null {
  if (!token || token.trim() === '') return null;
  const key = CACHE_PREFIX + token.trim();
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw) as SessionPayload;
  } catch {
    return null;
  }
  // Sliding expiration: refresh the TTL on every successful read so that
  // active users stay logged in. Only idle sessions (>30 min without any
  // request) will expire.
  CacheService.getScriptCache().put(key, raw, SESSION_TTL_SECONDS);
  return payload;
}

/**
 * Explicitly invalidates a session (logout).
 */
export function deleteSession(token: string): void {
  if (token) CacheService.getScriptCache().remove(CACHE_PREFIX + token.trim());
}
