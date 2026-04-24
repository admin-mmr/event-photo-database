/**
 * tokenService.test.ts — Unit tests for verifyGoogleIdToken and exchangeOAuthCode.
 *
 * Security-critical: these are the only server-side identity checks in the
 * system.  Every error path must be tested so regressions are caught before
 * they reach production.
 *
 * Coverage:
 *   verifyGoogleIdToken()
 *     - empty / missing token
 *     - UrlFetchApp network exception
 *     - non-200 HTTP response (Google rejects token)
 *     - payload.error set
 *     - unparseable response body
 *     - missing email claim
 *     - email_verified false (boolean and string)
 *     - expired token (exp < now)
 *     - aud mismatch when GOOGLE_CLIENT_ID is configured
 *     - aud check skipped when GOOGLE_CLIENT_ID not configured
 *     - aud check skipped when payload.aud absent
 *     - happy path: returns lowercase-trimmed email
 *     - email_verified as string 'true' is accepted
 *
 *   exchangeOAuthCode()
 *     - empty code
 *     - missing GOOGLE_CLIENT_ID
 *     - missing GOOGLE_CLIENT_SECRET
 *     - UrlFetchApp network exception
 *     - non-200 token endpoint response
 *     - unparseable token response
 *     - response missing id_token
 *     - happy path: exchanges code → verifies id_token → returns email
 *     - propagates verifyGoogleIdToken errors (e.g. invalid id_token)
 */

import {
  verifyGoogleIdToken,
  exchangeOAuthCode,
} from '../../src/services/tokenService';
import { ResultStatus } from '../../src/types/enums';

// ─── GAS globals ──────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as unknown as Record<string, unknown>).UrlFetchApp = { fetch: mockFetch };

const mockGetProperty = jest.fn();
(global as unknown as Record<string, unknown>).PropertiesService = {
  getScriptProperties: jest.fn(() => ({ getProperty: mockGetProperty })),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a mock UrlFetchApp response */
function mockResponse(code: number, body: object | string) {
  return {
    getResponseCode: jest.fn(() => code),
    getContentText:  jest.fn(() =>
      typeof body === 'string' ? body : JSON.stringify(body)
    ),
  };
}

/** Builds a valid tokeninfo payload that will pass all checks */
function validTokenInfo(overrides: Record<string, unknown> = {}): object {
  return {
    email:          'User@Example.com',
    email_verified: true,
    aud:            'test-client-id',
    exp:            String(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
    ...overrides,
  };
}

// ─── verifyGoogleIdToken() ────────────────────────────────────────────────────

describe('verifyGoogleIdToken()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no GOOGLE_CLIENT_ID configured (aud check skipped)
    mockGetProperty.mockReturnValue(null);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('returns ERROR for empty string token', () => {
    const result = verifyGoogleIdToken('');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('No ID token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns ERROR for whitespace-only token', () => {
    const result = verifyGoogleIdToken('   ');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('No ID token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Network errors ──────────────────────────────────────────────────────────

  it('returns ERROR when UrlFetchApp throws a network error', () => {
    mockFetch.mockImplementation(() => { throw new Error('Network timeout'); });

    const result = verifyGoogleIdToken('some.id.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('network error');
  });

  // ── Google rejection ────────────────────────────────────────────────────────

  it('returns ERROR when Google returns non-200 HTTP status', () => {
    mockFetch.mockReturnValue(mockResponse(400, { error: 'invalid_token' }));

    const result = verifyGoogleIdToken('bad.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Token rejected by Google');
  });

  it('returns ERROR when response body contains an error field (even on 200)', () => {
    mockFetch.mockReturnValue(mockResponse(200, {
      error: 'invalid_token',
      error_description: 'Token has been revoked.',
    }));

    const result = verifyGoogleIdToken('revoked.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Token has been revoked.');
  });

  it('prefers error_description over error in rejection message', () => {
    mockFetch.mockReturnValue(mockResponse(400, {
      error: 'invalid_token',
      error_description: 'Token has been revoked.',
    }));

    const result = verifyGoogleIdToken('bad.token');
    expect(result.message).toContain('Token has been revoked.');
    expect(result.message).not.toContain('invalid_token');
  });

  // ── Unparseable response ────────────────────────────────────────────────────

  it('returns ERROR when response body is not valid JSON', () => {
    mockFetch.mockReturnValue(mockResponse(200, 'not-json-at-all'));

    const result = verifyGoogleIdToken('some.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('unparseable');
  });

  // ── Claim validation ────────────────────────────────────────────────────────

  it('returns ERROR when email claim is missing from payload', () => {
    mockFetch.mockReturnValue(mockResponse(200, {
      email_verified: true,
      exp: String(Math.floor(Date.now() / 1000) + 3600),
    }));

    const result = verifyGoogleIdToken('no.email.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('no email claim');
  });

  it('returns ERROR when email_verified is boolean false', () => {
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ email_verified: false })));

    const result = verifyGoogleIdToken('unverified.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('not verified');
  });

  it('returns ERROR when email_verified is string "false"', () => {
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ email_verified: 'false' })));

    const result = verifyGoogleIdToken('unverified.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('not verified');
  });

  it('accepts email_verified as string "true"', () => {
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ email_verified: 'true' })));

    const result = verifyGoogleIdToken('valid.token');
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  // ── Expiry ──────────────────────────────────────────────────────────────────

  it('returns ERROR when token exp is in the past', () => {
    const expiredSecs = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ exp: String(expiredSecs) })));

    const result = verifyGoogleIdToken('expired.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('expired');
  });

  it('accepts a token whose exp is in the future', () => {
    const futureSecs = Math.floor(Date.now() / 1000) + 3600;
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ exp: String(futureSecs) })));

    const result = verifyGoogleIdToken('fresh.token');
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  // ── Audience (aud) check ────────────────────────────────────────────────────

  it('returns ERROR when aud does not match the configured GOOGLE_CLIENT_ID', () => {
    mockGetProperty.mockImplementation((key: string) =>
      key === 'GOOGLE_CLIENT_ID' ? 'expected-client-id' : null
    );
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ aud: 'wrong-client-id' })));

    const result = verifyGoogleIdToken('wrong-aud.token');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('audience');
  });

  it('returns SUCCESS when aud matches the configured GOOGLE_CLIENT_ID', () => {
    mockGetProperty.mockImplementation((key: string) =>
      key === 'GOOGLE_CLIENT_ID' ? 'test-client-id' : null
    );
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ aud: 'test-client-id' })));

    const result = verifyGoogleIdToken('correct-aud.token');
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  it('skips aud check when GOOGLE_CLIENT_ID is not configured', () => {
    mockGetProperty.mockReturnValue(null); // not configured
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ aud: 'any-client-id' })));

    const result = verifyGoogleIdToken('no-client-id-check.token');
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  it('skips aud check when payload contains no aud field', () => {
    mockGetProperty.mockImplementation((key: string) =>
      key === 'GOOGLE_CLIENT_ID' ? 'test-client-id' : null
    );
    // payload has no aud
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo({ aud: undefined })));

    const result = verifyGoogleIdToken('no-aud-in-payload.token');
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns SUCCESS with lowercased, trimmed email on a valid token', () => {
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo()));

    const result = verifyGoogleIdToken('valid.token');
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).not.toBeNull();
    expect(result.data!.email).toBe('user@example.com'); // lowercased + trimmed
  });

  it('calls the tokeninfo endpoint with the encoded token as a query param', () => {
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo()));

    verifyGoogleIdToken('my.id.token');

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain('https://oauth2.googleapis.com/tokeninfo');
    expect(url).toContain('id_token=my.id.token');
  });

  it('URL-encodes the token when calling tokeninfo', () => {
    mockFetch.mockReturnValue(mockResponse(200, validTokenInfo()));

    verifyGoogleIdToken('token with spaces');

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    // encodeURIComponent encodes spaces as %20 (not +)
    expect(url).toContain('token%20with%20spaces');
  });
});

// ─── exchangeOAuthCode() ──────────────────────────────────────────────────────

describe('exchangeOAuthCode()', () => {
  const REDIRECT_URI = 'https://script.google.com/macros/s/abc/exec';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProperty.mockImplementation((key: string) => {
      if (key === 'GOOGLE_CLIENT_ID')     return 'test-client-id';
      if (key === 'GOOGLE_CLIENT_SECRET') return 'test-client-secret';
      return null;
    });
  });

  // ── Input / config validation ───────────────────────────────────────────────

  it('returns ERROR for empty code', () => {
    const result = exchangeOAuthCode('', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('No authorization code');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns ERROR when GOOGLE_CLIENT_ID is not configured', () => {
    mockGetProperty.mockImplementation((key: string) =>
      key === 'GOOGLE_CLIENT_SECRET' ? 'secret' : null
    );

    const result = exchangeOAuthCode('auth-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('GOOGLE_CLIENT_ID');
  });

  it('returns ERROR when GOOGLE_CLIENT_SECRET is not configured', () => {
    mockGetProperty.mockImplementation((key: string) =>
      key === 'GOOGLE_CLIENT_ID' ? 'client-id' : null
    );

    const result = exchangeOAuthCode('auth-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('GOOGLE_CLIENT_SECRET');
  });

  // ── Network / HTTP errors ───────────────────────────────────────────────────

  it('returns ERROR when UrlFetchApp throws during token exchange', () => {
    mockFetch.mockImplementation(() => { throw new Error('Connection refused'); });

    const result = exchangeOAuthCode('auth-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('network error');
  });

  it('returns ERROR when token endpoint returns non-200', () => {
    mockFetch.mockReturnValue(mockResponse(400, {
      error: 'invalid_grant',
      error_description: 'Code already used.',
    }));

    const result = exchangeOAuthCode('used-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Code already used.');
  });

  it('returns ERROR when token response is not valid JSON', () => {
    mockFetch.mockReturnValue(mockResponse(200, 'not-json'));

    const result = exchangeOAuthCode('auth-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('unparseable');
  });

  it('returns ERROR when token response contains no id_token', () => {
    mockFetch.mockReturnValue(mockResponse(200, { access_token: 'at', token_type: 'Bearer' }));

    const result = exchangeOAuthCode('auth-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('no id_token');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('exchanges the code for an id_token, verifies it, and returns the email', () => {
    // First fetch: token exchange endpoint → returns id_token
    const tokenExchangeResp = mockResponse(200, { id_token: 'valid.id.token' });
    // Second fetch: tokeninfo verification of that id_token
    const tokenInfoResp = mockResponse(200, validTokenInfo());

    mockFetch
      .mockReturnValueOnce(tokenExchangeResp)
      .mockReturnValueOnce(tokenInfoResp);

    const result = exchangeOAuthCode('fresh-auth-code', REDIRECT_URI);

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.email).toBe('user@example.com');
  });

  it('posts to the correct token endpoint with all required fields', () => {
    mockFetch
      .mockReturnValueOnce(mockResponse(200, { id_token: 'valid.id.token' }))
      .mockReturnValueOnce(mockResponse(200, validTokenInfo()));

    exchangeOAuthCode('my-code', REDIRECT_URI);

    const [url, options] = mockFetch.mock.calls[0] as [string, { payload: Record<string, string> }];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options.payload.code).toBe('my-code');
    expect(options.payload.client_id).toBe('test-client-id');
    expect(options.payload.client_secret).toBe('test-client-secret');
    expect(options.payload.redirect_uri).toBe(REDIRECT_URI);
    expect(options.payload.grant_type).toBe('authorization_code');
  });

  it('propagates verifyGoogleIdToken errors when the id_token itself is invalid', () => {
    // Token exchange succeeds but the returned id_token fails verification
    mockFetch
      .mockReturnValueOnce(mockResponse(200, { id_token: 'invalid.id.token' }))
      .mockReturnValueOnce(mockResponse(400, { error: 'invalid_token' }));

    const result = exchangeOAuthCode('valid-code', REDIRECT_URI);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Token rejected by Google');
  });
});
