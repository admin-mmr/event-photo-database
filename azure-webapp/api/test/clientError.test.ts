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
// pino instance. Instead spy on the real logger's `error` method, which is what
// the route calls and what a log-based alert rule matches on (severity ERROR).
const { logger } = await import('../src/lib/logger.js');
const { buildServer } = await import('../src/server.js');

const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => true as never);

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

describe('POST /api/client-errors', () => {
  const app = buildServer();

  beforeEach(() => {
    errorSpy.mockClear();
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/client-errors').send({ message: 'boom' });
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
        message: 'ZIP download failed',
        context: { eventId: 'ev1', requested: 6, failed: 6 },
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
});
