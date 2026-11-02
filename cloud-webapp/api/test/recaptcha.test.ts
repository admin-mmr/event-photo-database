import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mock env so each test can toggle configured/unconfigured + score.
const mockEnv = {
  RECAPTCHA_PROJECT_ID: '',
  RECAPTCHA_SITE_KEY: '',
  RECAPTCHA_API_KEY: '',
  RECAPTCHA_MIN_SCORE: 0.5,
  RECAPTCHA_MODE: 'shadow' as 'shadow' | 'enforce',
};

vi.mock('../src/lib/config.js', () => ({
  env: mockEnv,
  isProd: false,
  isTest: true,
}));
const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../src/lib/logger.js', () => ({ logger: mockLogger }));

const { verifyRecaptcha, isRecaptchaConfigured, recaptchaConfigStatus, recaptchaSelfCheck } =
  await import('../src/services/recaptcha.js');
const { requireRecaptcha, verdictOutcome } = await import('../src/middleware/recaptcha.js');

function configure(on: boolean): void {
  mockEnv.RECAPTCHA_PROJECT_ID = on ? 'proj' : '';
  mockEnv.RECAPTCHA_SITE_KEY = on ? 'site-key' : '';
  mockEnv.RECAPTCHA_API_KEY = on ? 'api-key' : '';
  mockEnv.RECAPTCHA_MIN_SCORE = 0.5;
}

function mockFetchJson(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  configure(false);
  mockEnv.RECAPTCHA_MODE = 'shadow';
});

/** The body Google actually returns for a bad API key (verified 2026-11-02). */
const BAD_KEY_BODY = {
  error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
};

/** Logged objects, flattened to JSON, for "the key never appears" checks. */
function everythingLogged(): string {
  return JSON.stringify([
    ...mockLogger.info.mock.calls,
    ...mockLogger.warn.mock.calls,
    ...mockLogger.error.mock.calls,
  ]);
}

describe('verifyRecaptcha', () => {
  it('no-ops (ok, disabled) and does not fetch when unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isRecaptchaConfigured()).toBe(false);
  });

  it('rejects a missing token when configured', async () => {
    configure(true);
    const r = await verifyRecaptcha(undefined, 'findme_search');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_token');
  });

  it('accepts a valid token with a high score', async () => {
    configure(true);
    mockFetchJson({
      tokenProperties: { valid: true, action: 'findme_search' },
      riskAnalysis: { score: 0.9 },
    });
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(true);
    expect(r.score).toBe(0.9);
  });

  it('rejects a score below the minimum', async () => {
    configure(true);
    mockFetchJson({
      tokenProperties: { valid: true, action: 'findme_search' },
      riskAnalysis: { score: 0.1 },
    });
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('low_score');
  });

  it('rejects an invalid token', async () => {
    configure(true);
    mockFetchJson({ tokenProperties: { valid: false, invalidReason: 'EXPIRED' } });
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('EXPIRED');
  });

  it('rejects an action mismatch', async () => {
    configure(true);
    mockFetchJson({
      tokenProperties: { valid: true, action: 'something_else' },
      riskAnalysis: { score: 0.9 },
    });
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('action_mismatch');
  });

  it('fails OPEN on a non-2xx from the assessment API', async () => {
    configure(true);
    mockFetchJson({}, false, 500);
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('http_500');
  });

  it('fails OPEN when fetch throws', async () => {
    configure(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const r = await verifyRecaptcha('tok', 'findme_search');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('verify_error');
    expect(r.failOpen).toBe(true);
  });

  // The 2026-10-04 → 11-02 incident: every call 400'd "API key not valid" and
  // only a WARN was logged, so nothing alerted for a month.
  it('logs a bad API key (400) at ERROR with the alert tag, still failing open', async () => {
    configure(true);
    mockFetchJson(BAD_KEY_BODY, false, 400);
    const r = await verifyRecaptcha('tok', 'download');
    expect(r).toMatchObject({ ok: true, reason: 'http_400', failOpen: true });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [fields] = mockLogger.error.mock.calls[0]!;
    expect(fields).toMatchObject({
      alert: 'recaptcha_broken',
      status: 400,
      action: 'download',
      api: { status: 'INVALID_ARGUMENT' },
    });
  });

  it.each([401, 403, 404])('treats HTTP %i as a config error (ERROR + alert)', async (status) => {
    configure(true);
    mockFetchJson({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }, false, status);
    await verifyRecaptcha('tok', 'findme_search');
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error.mock.calls[0]![0]).toMatchObject({
      alert: 'recaptcha_broken',
      api: { reason: 'API_KEY_SERVICE_BLOCKED' },
    });
  });

  it.each([429, 500, 503])('treats HTTP %i as transient (WARN, no alert)', async (status) => {
    configure(true);
    mockFetchJson({}, false, status);
    await verifyRecaptcha('tok', 'findme_search');
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('sends the API key in a header, never in the URL', async () => {
    configure(true);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchSpy);
    await verifyRecaptcha('tok', 'download');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('api-key');
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('api-key');
  });

  it('never logs the API key, even on a config error', async () => {
    configure(true);
    mockFetchJson(BAD_KEY_BODY, false, 400);
    await verifyRecaptcha('tok', 'download');
    expect(everythingLogged()).not.toContain('api-key');
  });
});

describe('recaptchaSelfCheck', () => {
  it('is disabled (and does not fetch) when unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await recaptchaSelfCheck()).toEqual({ state: 'disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // A working key answers 200 with valid:false / MALFORMED for a bogus token
  // (verified against the live API 2026-11-02) — that is HEALTHY.
  it('is healthy on a 200, even though the bogus token is invalid', async () => {
    configure(true);
    mockFetchJson({ tokenProperties: { valid: false, invalidReason: 'MALFORMED' } });
    expect(await recaptchaSelfCheck()).toEqual({ state: 'healthy' });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('is broken on a bad key, and logs the alert line', async () => {
    configure(true);
    mockFetchJson(BAD_KEY_BODY, false, 400);
    expect(await recaptchaSelfCheck()).toEqual({ state: 'broken', status: 400 });
    expect(mockLogger.error.mock.calls[0]![0]).toMatchObject({ alert: 'recaptcha_broken', action: 'self_check' });
  });

  it('is inconclusive (no alert) on a 5xx or a network error, and never throws', async () => {
    configure(true);
    mockFetchJson({}, false, 503);
    expect(await recaptchaSelfCheck()).toEqual({ state: 'unknown', status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await recaptchaSelfCheck()).toEqual({ state: 'unknown' });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe('verdictOutcome', () => {
  it('maps results to outcomes per mode', () => {
    expect(verdictOutcome({ ok: true, reason: 'ok' }, 'enforce')).toBe('pass');
    expect(verdictOutcome({ ok: true, reason: 'http_400', failOpen: true }, 'enforce')).toBe('fail_open');
    expect(verdictOutcome({ ok: false, reason: 'low_score' }, 'shadow')).toBe('would_block');
    expect(verdictOutcome({ ok: false, reason: 'low_score' }, 'enforce')).toBe('blocked');
  });
});

describe('requireRecaptcha middleware', () => {
  function run(headers: Record<string, string> = {}, signInProvider?: string) {
    const user = { uid: 'u1', ...(signInProvider ? { signInProvider } : {}) };
    const req = { headers, body: {}, user } as never;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const next = vi.fn();
    return { req, res, next, go: () => requireRecaptcha('findme_search')(req, res as never, next) };
  }
  const lowScore = { tokenProperties: { valid: true, action: 'findme_search' }, riskAnalysis: { score: 0.1 } };

  it('passes through without fetching when unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = run();
    await t.go();
    expect(t.next).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SHADOW (the default): a low score is logged as would_block but allowed', async () => {
    configure(true);
    mockFetchJson(lowScore);
    const t = run({ 'x-recaptcha-token': 'tok' });
    await t.go();
    expect(t.next).toHaveBeenCalled();
    expect(t.res.status).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        recaptcha: { action: 'findme_search', mode: 'shadow', outcome: 'would_block', reason: 'low_score', score: 0.1 },
        uid: 'u1',
      },
      'recaptcha verdict',
    );
  });

  it('SHADOW: a missing token is allowed (an ad-blocked script must not lock anyone out yet)', async () => {
    configure(true);
    const t = run();
    await t.go();
    expect(t.next).toHaveBeenCalled();
    expect(mockLogger.warn.mock.calls[0]![0]).toMatchObject({
      recaptcha: { outcome: 'would_block', reason: 'missing_token' },
    });
  });

  it('ENFORCE: a low score is 403d and logged as blocked', async () => {
    configure(true);
    mockEnv.RECAPTCHA_MODE = 'enforce';
    mockFetchJson(lowScore);
    const t = run({ 'x-recaptcha-token': 'tok' });
    await t.go();
    expect(t.next).not.toHaveBeenCalled();
    expect(t.res.status).toHaveBeenCalledWith(403);
    expect(mockLogger.warn.mock.calls[0]![0]).toMatchObject({ recaptcha: { mode: 'enforce', outcome: 'blocked' } });
  });

  it('ENFORCE: a good score passes and logs the score at INFO', async () => {
    configure(true);
    mockEnv.RECAPTCHA_MODE = 'enforce';
    mockFetchJson({ tokenProperties: { valid: true, action: 'findme_search' }, riskAnalysis: { score: 0.9 } });
    const t = run({ 'x-recaptcha-token': 'tok' });
    await t.go();
    expect(t.next).toHaveBeenCalled();
    expect(mockLogger.info.mock.calls[0]![0]).toMatchObject({ recaptcha: { outcome: 'pass', score: 0.9 } });
  });

  it('a Google-signed-in user skips the assessment (no fetch, no 403) and is logged as skipped', async () => {
    configure(true);
    mockEnv.RECAPTCHA_MODE = 'enforce';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = run({}, 'google.com');
    await t.go();
    expect(t.next).toHaveBeenCalled();
    expect(t.res.status).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLogger.info.mock.calls[0]![0]).toMatchObject({
      recaptcha: { outcome: 'skipped_signed_in', reason: 'google.com' },
      uid: 'u1',
    });
  });

  // Guests are the hole (a fresh anonymous uid = a fresh quota), and the skip is
  // an ALLOWLIST: an unknown or future provider (e.g. email/password, cheap to
  // mass-create) must still be checked.
  it.each([['anonymous'], ['password'], [undefined]])(
    'provider %s is still checked (and 403d on a low score in enforce)',
    async (provider) => {
      configure(true);
      mockEnv.RECAPTCHA_MODE = 'enforce';
      mockFetchJson(lowScore);
      const t = run({ 'x-recaptcha-token': 'tok' }, provider);
      await t.go();
      expect(t.res.status).toHaveBeenCalledWith(403);
      expect(t.next).not.toHaveBeenCalled();
    },
  );

  it('ENFORCE: an infra failure still fails OPEN (a broken key never blocks attendees)', async () => {
    configure(true);
    mockEnv.RECAPTCHA_MODE = 'enforce';
    mockFetchJson(BAD_KEY_BODY, false, 400);
    const t = run({ 'x-recaptcha-token': 'tok' });
    await t.go();
    expect(t.next).toHaveBeenCalled();
    expect(t.res.status).not.toHaveBeenCalled();
    expect(mockLogger.info.mock.calls[0]![0]).toMatchObject({ recaptcha: { outcome: 'fail_open', reason: 'http_400' } });
  });
});

describe('recaptchaConfigStatus', () => {
  it('reports fully configured', () => {
    configure(true);
    const s = recaptchaConfigStatus();
    expect(s).toEqual({
      configured: true,
      partial: false,
      present: { projectId: true, siteKey: true, apiKey: true },
    });
  });

  it('reports unconfigured (all absent, expected in dev)', () => {
    configure(false);
    const s = recaptchaConfigStatus();
    expect(s.configured).toBe(false);
    expect(s.partial).toBe(false);
  });

  it('flags the partial (dangerous) case when the API key is missing', () => {
    // Mirrors the prod incident: project id + site key set, api key blank
    // (the secret was bound to the wrong env-var name).
    mockEnv.RECAPTCHA_PROJECT_ID = 'proj';
    mockEnv.RECAPTCHA_SITE_KEY = 'site-key';
    mockEnv.RECAPTCHA_API_KEY = '';
    const s = recaptchaConfigStatus();
    expect(s.configured).toBe(false);
    expect(s.partial).toBe(true);
    expect(s.present).toEqual({ projectId: true, siteKey: true, apiKey: false });
    expect(isRecaptchaConfigured()).toBe(false);
  });
});
