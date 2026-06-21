import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mock env so each test can toggle configured/unconfigured + throttle.
const mockEnv = {
  SENDGRID_API_KEY: '',
  ALERT_EMAIL_FROM: '',
  ALERT_EMAIL_TO: 'admin@mmrunners.org',
  ALERT_THROTTLE_SEC: 900,
  ALERT_MAX_PER_HOUR: 20,
  GIT_COMMIT_SHA: 'testsha',
};

vi.mock('../src/lib/config.js', () => ({
  env: mockEnv,
  isProd: false,
  isTest: true,
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { sendErrorAlert, isAlertingConfigured, shouldSend, _resetThrottleForTest } = await import(
  '../src/services/alertService.js'
);

function configure(on: boolean): void {
  mockEnv.SENDGRID_API_KEY = on ? 'SG.key' : '';
  mockEnv.ALERT_EMAIL_FROM = on ? 'alerts@mmrunners.org' : '';
  mockEnv.ALERT_EMAIL_TO = 'admin@mmrunners.org';
  mockEnv.ALERT_THROTTLE_SEC = 900;
  mockEnv.ALERT_MAX_PER_HOUR = 20;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetThrottleForTest();
  configure(false);
});

describe('isAlertingConfigured', () => {
  it('is false unless all three settings are present', () => {
    expect(isAlertingConfigured()).toBe(false);
    configure(true);
    expect(isAlertingConfigured()).toBe(true);
  });
});

describe('sendErrorAlert', () => {
  it('no-ops and does not fetch when unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await sendErrorAlert(new Error('boom'), { method: 'GET', path: '/x' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to SendGrid with the right envelope when configured', async () => {
    configure(true);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);

    await sendErrorAlert(new Error('kaboom'), { method: 'POST', path: '/api/foo', userEmail: 'u@x.com' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer SG.key');
    const body = JSON.parse(String(opts.body));
    expect(body.personalizations[0].to[0].email).toBe('admin@mmrunners.org');
    expect(body.from.email).toBe('alerts@mmrunners.org');
    expect(body.subject).toContain('kaboom');
    expect(body.content[0].value).toContain('POST /api/foo');
    expect(body.content[0].value).toContain('u@x.com');
  });

  it('never throws when fetch rejects', async () => {
    configure(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(sendErrorAlert(new Error('x'))).resolves.toBeUndefined();
  });

  it('throttles a repeated error signature but lets distinct errors through', async () => {
    configure(true);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);

    // Same error object → identical signature (same message + stack frame),
    // which is how a recurring bug looks in production.
    const recurring = new Error('same');
    await sendErrorAlert(recurring);
    await sendErrorAlert(recurring);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await sendErrorAlert(new Error('different'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('shouldSend (throttle logic)', () => {
  it('blocks the same signature within the cooldown window', () => {
    configure(true);
    const t0 = 1_000_000;
    expect(shouldSend('sig', t0)).toBe(true);
    expect(shouldSend('sig', t0 + 1000)).toBe(false);
    expect(shouldSend('sig', t0 + 901_000)).toBe(true);
  });

  it('enforces the global hourly cap across signatures', () => {
    configure(true);
    mockEnv.ALERT_MAX_PER_HOUR = 3;
    const t0 = 5_000_000;
    expect(shouldSend('a', t0)).toBe(true);
    expect(shouldSend('b', t0 + 1)).toBe(true);
    expect(shouldSend('c', t0 + 2)).toBe(true);
    expect(shouldSend('d', t0 + 3)).toBe(false);
    // After the hour rolls past, the window frees up again.
    expect(shouldSend('e', t0 + 3_600_001)).toBe(true);
  });
});
