import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// ── mocks (must precede the server import) ──────────────────────────────────

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-user'];
    if (!raw) {
      res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing bearer token' });
      return;
    }
    req.user = JSON.parse(String(raw));
    next();
  },
}));

// Don't mock the logger module — pino-http (wired in server.ts) needs a real
// pino instance. Instead spy on the real logger's `error` method, which is
// what the route calls and what the Cloud Monitoring alert policy matches on
// (severity>=ERROR).
const { logger } = await import('../src/lib/logger.js');
const { buildServer } = await import('../src/server.js');
const { resetClientErrorRepeats, REPEAT_WINDOW_MS } = await import('../src/routes/telemetry.js');

const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => true as never);
const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => true as never);

/** Only the route's own lines — pino-http also logs through the logger. */
function clientErrorCalls(spy: typeof errorSpy): Array<[Record<string, unknown>, string]> {
  return (spy.mock.calls as Array<[Record<string, unknown>, string]>).filter(
    ([f]) => f && typeof f === 'object' && f.clientError === true,
  );
}

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

describe('POST /api/client-errors', () => {
  const app = buildServer();

  beforeEach(() => {
    errorSpy.mockClear();
    warnSpy.mockClear();
    resetClientErrorRepeats();
    vi.useRealTimers();
  });

  it('requires auth', async () => {
    const res = await request(app)
      .post('/api/client-errors')
      .send({ message: 'boom' });
    expect(res.status).toBe(401);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('400s when message is missing', async () => {
    const res = await request(app)
      .post('/api/client-errors')
      .set('x-test-user', USER)
      .send({ kind: 'download_failed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('accepts a report and logs it at ERROR severity', async () => {
    const res = await request(app)
      .post('/api/client-errors')
      .set('x-test-user', USER)
      .send({
        kind: 'download_failed',
        message: 'ZIP download: every original failed to fetch',
        context: { eventId: 'ev1', requested: 6, signed: 6, failed: 6, sampleErrors: ['HTTP 403'] },
      });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.clientError).toBe(true);
    expect(fields.kind).toBe('download_failed');
    expect(fields.by).toBe('member@mmrunners.org');
    expect((fields.context as Record<string, unknown>).failed).toBe(6);
    expect(msg).toContain('download_failed');
  });

  it('defaults kind to client_error when omitted', async () => {
    const res = await request(app)
      .post('/api/client-errors')
      .set('x-test-user', USER)
      .send({ message: 'something broke' });

    expect(res.status).toBe(202);
    const [fields] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.kind).toBe('client_error');
  });

  it('drops an oversized context bag instead of logging it', async () => {
    const big = 'x'.repeat(5000);
    const res = await request(app)
      .post('/api/client-errors')
      .set('x-test-user', USER)
      .send({ message: 'big', context: { blob: big } });

    expect(res.status).toBe(202);
    const [fields] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.context).toEqual({ truncated: true });
  });

  describe('repeat backstop', () => {
    const IDB_LOST = 'Connection to Indexed Database server lost. Refresh the page to try again';
    const OTHER = JSON.stringify({ uid: 'u2', email: 'other@mmrunners.org', emailVerified: true });
    const send = (user: string, body: Record<string, unknown>) =>
      request(app).post('/api/client-errors').set('x-test-user', user).send(body);

    it('a flood of identical reports from one user logs ERROR once, then WARN', async () => {
      for (let i = 0; i < 5; i += 1) {
        const res = await send(USER, { kind: 'unhandled_rejection', message: IDB_LOST });
        expect(res.status).toBe(202);
      }
      expect(clientErrorCalls(errorSpy)).toHaveLength(1);
      const warns = clientErrorCalls(warnSpy);
      expect(warns).toHaveLength(4);
      expect(warns[0]?.[0].repeat).toBe(true);
      expect(warns[0]?.[1]).toContain('repeated');
    });

    it('a different user, kind or message still logs at ERROR', async () => {
      await send(USER, { kind: 'unhandled_rejection', message: IDB_LOST });
      await send(OTHER, { kind: 'unhandled_rejection', message: IDB_LOST });
      await send(USER, { kind: 'unhandled_error', message: IDB_LOST });
      await send(USER, { kind: 'unhandled_rejection', message: 'something else' });
      expect(clientErrorCalls(errorSpy)).toHaveLength(4);
      expect(clientErrorCalls(warnSpy)).toHaveLength(0);
    });

    it('the same report after the window logs at ERROR again', async () => {
      const now = vi.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000_000);
        await send(USER, { kind: 'download_failed', message: 'ZIP download failed' });
        now.mockReturnValue(1_000_000 + REPEAT_WINDOW_MS);
        await send(USER, { kind: 'download_failed', message: 'ZIP download failed' });
      } finally {
        now.mockRestore();
      }
      expect(clientErrorCalls(errorSpy)).toHaveLength(2);
    });

    it("the client's own follow-up (repeatCount) logs at WARN and keeps the count", async () => {
      const res = await send(USER, {
        kind: 'unhandled_rejection',
        message: IDB_LOST,
        repeatCount: 10,
      });
      expect(res.status).toBe(202);
      expect(clientErrorCalls(errorSpy)).toHaveLength(0);
      const [fields] = clientErrorCalls(warnSpy)[0] ?? [];
      expect(fields?.repeatCount).toBe(10);
    });

    it('rejects a non-integer repeatCount', async () => {
      const res = await send(USER, { message: 'x', repeatCount: 'lots' });
      expect(res.status).toBe(400);
    });
  });
});
