/**
 * Unit tests for sessionService.
 *
 * Covers createSession(), lookupSession(), and deleteSession() using the
 * in-memory CacheService mock installed in gasGlobals.ts.
 */

import { createSession, lookupSession, deleteSession } from '../../src/services/sessionService';
import { resetMockCache, mockScriptCache } from '../mocks/gasGlobals';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CACHE_PREFIX = 'xsd_sess_';

/** Returns the raw cache key used internally for a given token. */
function cacheKey(token: string): string {
  return `${CACHE_PREFIX}${token}`;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('sessionService', () => {
  beforeEach(() => {
    resetMockCache();
  });

  // ── createSession ──────────────────────────────────────────────────────────

  describe('createSession()', () => {
    it('returns a non-empty UUID token', () => {
      const token = createSession('user@example.com', 'user');
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('stores the session payload in the cache under the prefixed key', () => {
      const token = createSession('admin@mmrunners.org', 'admin');
      expect(mockScriptCache.put).toHaveBeenCalledWith(
        cacheKey(token),
        JSON.stringify({ email: 'admin@mmrunners.org', role: 'admin' }),
        1800
      );
    });

    it('uses a 30-minute TTL (1800 seconds)', () => {
      createSession('user@example.com', 'user');
      const [, , ttl] = mockScriptCache.put.mock.calls[0] as [string, string, number];
      expect(ttl).toBe(1800);
    });

    it('generates a different token each call', () => {
      const t1 = createSession('a@example.com', 'user');
      const t2 = createSession('b@example.com', 'user');
      expect(t1).not.toBe(t2);
    });
  });

  // ── lookupSession ──────────────────────────────────────────────────────────

  describe('lookupSession()', () => {
    it('returns { email, role } for a valid, non-expired token', () => {
      const token = createSession('user@example.com', 'user');
      const session = lookupSession(token);
      expect(session).not.toBeNull();
      expect(session!.email).toBe('user@example.com');
      expect(session!.role).toBe('user');
    });

    it('returns null for an unknown token', () => {
      expect(lookupSession('not-a-real-token')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(lookupSession('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(lookupSession('   ')).toBeNull();
    });

    it('trims leading/trailing whitespace from the token before lookup', () => {
      const token = createSession('user@example.com', 'user');
      const session = lookupSession(`  ${token}  `);
      expect(session).not.toBeNull();
      expect(session!.email).toBe('user@example.com');
    });

    it('returns null when the cache returns corrupted JSON', () => {
      // Simulate a corrupted or partially-expired cache entry
      mockScriptCache.get.mockReturnValueOnce('{bad json:::');
      expect(lookupSession('any-token')).toBeNull();
    });

    it('returns null when the cache returns null (expired session)', () => {
      mockScriptCache.get.mockReturnValueOnce(null);
      expect(lookupSession('expired-token')).toBeNull();
    });

    it('refreshes the TTL on a successful lookup (sliding expiration)', () => {
      const token = createSession('user@example.com', 'user');

      // Clear the put-call history so we only observe the lookup's re-put.
      mockScriptCache.put.mockClear();

      const session = lookupSession(token);
      expect(session).not.toBeNull();

      // lookupSession should have re-put the entry with the full TTL so the
      // session keeps extending while the user is active.
      expect(mockScriptCache.put).toHaveBeenCalledWith(
        cacheKey(token),
        JSON.stringify({ email: 'user@example.com', role: 'user' }),
        1800
      );
    });

    it('does not refresh TTL when the token is missing/expired', () => {
      mockScriptCache.put.mockClear();
      expect(lookupSession('ghost-token')).toBeNull();
      expect(mockScriptCache.put).not.toHaveBeenCalled();
    });

    it('does not refresh TTL when the cached JSON is corrupted', () => {
      mockScriptCache.get.mockReturnValueOnce('{bad json:::');
      mockScriptCache.put.mockClear();
      expect(lookupSession('any-token')).toBeNull();
      expect(mockScriptCache.put).not.toHaveBeenCalled();
    });
  });

  // ── deleteSession ──────────────────────────────────────────────────────────

  describe('deleteSession()', () => {
    it('removes the session so subsequent lookups return null', () => {
      const token = createSession('user@example.com', 'user');
      expect(lookupSession(token)).not.toBeNull(); // confirm it exists first

      deleteSession(token);
      expect(lookupSession(token)).toBeNull();
    });

    it('calls cache.remove() with the prefixed key', () => {
      const token = createSession('user@example.com', 'user');
      deleteSession(token);
      expect(mockScriptCache.remove).toHaveBeenCalledWith(cacheKey(token));
    });

    it('trims whitespace from the token before removal', () => {
      const token = createSession('user@example.com', 'user');
      deleteSession(`  ${token}  `);
      expect(mockScriptCache.remove).toHaveBeenCalledWith(cacheKey(token));
    });

    it('is a no-op for an empty token (does not call cache.remove)', () => {
      deleteSession('');
      expect(mockScriptCache.remove).not.toHaveBeenCalled();
    });

    it('does not throw when deleting a token that never existed', () => {
      expect(() => deleteSession('ghost-token')).not.toThrow();
    });

    it('only deletes the targeted session, leaving others intact', () => {
      const t1 = createSession('alice@example.com', 'user');
      const t2 = createSession('bob@example.com', 'admin');

      deleteSession(t1);

      expect(lookupSession(t1)).toBeNull();
      expect(lookupSession(t2)).not.toBeNull();
      expect(lookupSession(t2)!.email).toBe('bob@example.com');
    });
  });

  // ── round-trip ─────────────────────────────────────────────────────────────

  describe('full session lifecycle', () => {
    it('create → lookup → delete → lookup returns null', () => {
      const token = createSession('cathy@mmrunners.org', 'admin');

      const before = lookupSession(token);
      expect(before).not.toBeNull();
      expect(before!.email).toBe('cathy@mmrunners.org');
      expect(before!.role).toBe('admin');

      deleteSession(token);

      expect(lookupSession(token)).toBeNull();
    });
  });
});
