import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mock env so each test can toggle configured/unconfigured + score.
const mockEnv = {
  RECAPTCHA_PROJECT_ID: '',
  RECAPTCHA_SITE_KEY: '',
  RECAPTCHA_API_KEY: '',
  RECAPTCHA_MIN_SCORE: 0.5,
};

vi.mock('../src/lib/config.js', () => ({
  env: mockEnv,
  isProd: false,
  isTest: true,
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { verifyRecaptcha, isRecaptchaConfigured } = await import('../src/services/recaptcha.js');

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
  configure(false);
});

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
  });
});
