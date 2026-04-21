/**
 * SessionService — server-side session management via CacheService.
 *
 * After a successful Google Identity Services login (client-side), the server
 * creates a session token and stores {email, role} in the Script Cache.
 *
 * The client stores the token in sessionStorage and passes it with every
 * google.script.run call and every page navigation (?session=TOKEN).
 *
 * Sessions expire after SESSION_TTL_SECONDS (30 min) of inactivity.
 * The cache is shared across all users (Script Cache) keyed by a UUID token,
 * so there is no cross-user data leakage.
 */

/* global CacheService, Utilities */

const SESSION_TTL_SECONDS = 1800; // 30 minutes
const CACHE_PREFIX = 'xsd_sess_';

interface SessionPayload {
  email: string;
  role:  string;
}

/**
 * Creates a new session for the given email/role and returns the session token.
 */
export function createSession(email: string, role: string): string {
  const token   = Utilities.getUuid();
  const payload: SessionPayload = { email, role };
  CacheService.getScriptCache().put(
    CACHE_PREFIX + token,
    JSON.stringify(payload),
    SESSION_TTL_SECONDS
  );
  return token;
}

/**
 * Looks up a session token and returns {email, role} or null if missing/expired.
 */
export function lookupSession(token: string): SessionPayload | null {
  if (!token || token.trim() === '') return null;
  const raw = CacheService.getScriptCache().get(CACHE_PREFIX + token.trim());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Explicitly invalidates a session (logout).
 */
export function deleteSession(token: string): void {
  if (token) CacheService.getScriptCache().remove(CACHE_PREFIX + token.trim());
}
