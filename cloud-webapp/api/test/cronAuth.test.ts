/**
 * cronAuth.test.ts — the SYNC_TRIGGER_TOKEN rotation grace window.
 *
 * During a rotation the api accepts the new token AND the pre-rotation one
 * (SYNC_TRIGGER_TOKEN_PREVIOUS), because the old value lives on in places that
 * can't be switched atomically: every queued Cloud Tasks upload copy stores it
 * in its header, and each Cloud Scheduler job sends it until re-provisioned.
 * These pin the window open while PREVIOUS is set, shut once it is cleared, and
 * the WARN that tells the owner who is still on the old token.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

process.env.MASTER_SPREADSHEET_ID = 'sheet-123';
process.env.SYNC_TRIGGER_TOKEN = 'new-token';

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (_req: Request, res: Response, _next: NextFunction) => {
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing bearer token' });
  },
}));

const reconcile = vi.fn(async () => ({
  spreadsheetId: 'sheet-123',
  scanned: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  tagsLinked: 0,
  orphans: [],
  events: [],
  durationMs: 1,
}));
vi.mock('../src/services/reconcileService.js', () => ({
  reconcile: (...args: unknown[]) => reconcile(...(args as [])),
}));

const enqueueStagedBatch = vi.fn();
const validateUploadLink = vi.fn();
vi.mock('../src/services/volunteerUploadService.js', () => ({
  validateUploadLink,
  enqueueStagedBatch,
  createResumableSession: vi.fn(),
  UploadLinkError: class UploadLinkError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('../src/services/uploadBatchService.js', () => ({
  getUploadBatch: vi.fn(),
  initUploadBatch: vi.fn(),
  updateUploadBatch: vi.fn(),
}));

const { env } = await import('../src/lib/config.js');
const { logger } = await import('../src/lib/logger.js');
const { matchCronToken, validCronToken } = await import('../src/middleware/cronAuth.js');
const { buildServer } = await import('../src/server.js');

const app = buildServer();

/** WARN calls the grace window made, so a test can assert on who was named. */
function previousTokenWarnings(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((o: Record<string, unknown>) => o?.['alert'] === 'sync_token_previous');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  env.SYNC_TRIGGER_TOKEN = 'new-token';
  env.SYNC_TRIGGER_TOKEN_PREVIOUS = '';
  reconcile.mockClear();
  enqueueStagedBatch.mockReset();
  validateUploadLink.mockReset();
  warn = vi.spyOn(logger, 'warn');
});

afterEach(() => {
  warn.mockRestore();
  env.SYNC_TRIGGER_TOKEN_PREVIOUS = '';
});

describe('matchCronToken', () => {
  it('matches only the current token when no rotation is in progress', () => {
    expect(matchCronToken('new-token')).toBe('current');
    expect(matchCronToken('old-token')).toBeNull();
    expect(matchCronToken('')).toBeNull();
    expect(matchCronToken(undefined)).toBeNull();
  });

  it('accepts the previous token too while PREVIOUS is set', () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect(matchCronToken('new-token')).toBe('current');
    expect(matchCronToken('old-token')).toBe('previous');
    expect(matchCronToken('other')).toBeNull();
  });

  it('reports "current" while PREVIOUS still equals it (first rollout step)', () => {
    // The runbook wires PREVIOUS as a copy of the live value before adding a new
    // version, so for a while the two are identical. That must not read as a
    // stale caller, or every request would log a warning.
    env.SYNC_TRIGGER_TOKEN = 'old-token';
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect(matchCronToken('old-token')).toBe('current');
  });

  it('never opens the header path on PREVIOUS alone', () => {
    // An empty SYNC_TRIGGER_TOKEN means "machine callers disabled"; a leftover
    // PREVIOUS must not quietly re-enable it with the retired value.
    env.SYNC_TRIGGER_TOKEN = '';
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect(matchCronToken('old-token')).toBeNull();
    expect(matchCronToken('')).toBeNull();
  });

  it('rejects the old token again once PREVIOUS is cleared', () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect(matchCronToken('old-token')).toBe('previous');
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = '';
    expect(matchCronToken('old-token')).toBeNull();
  });

  it('does not treat a prefix or a differently-sized token as a match', () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    for (const t of ['new', 'new-token-x', 'old', 'old-token ', ' new-token']) {
      expect(matchCronToken(t), t).toBeNull();
    }
  });
});

describe('validCronToken', () => {
  it('logs a PREVIOUS match only when given the request, so a re-check logs once', () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect(validCronToken('old-token')).toBe(true);
    expect(previousTokenWarnings(warn)).toHaveLength(0);
  });

  it('does not log for the current token', () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect(validCronToken('new-token')).toBe(true);
    expect(previousTokenWarnings(warn)).toHaveLength(0);
  });
});

describe('grace window through the real gates', () => {
  it('lets a not-yet-reprovisioned scheduler job through and names it', async () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    const res = await request(app)
      .post('/api/admin/sync')
      .set('x-sync-token', 'old-token')
      .set('user-agent', 'Google-Cloud-Scheduler')
      .set('x-cloudscheduler-jobname', 'findme-drive-sync');
    expect(res.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const warnings = previousTokenWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      method: 'POST',
      path: '/api/admin/sync',
      userAgent: 'Google-Cloud-Scheduler',
      schedulerJob: 'findme-drive-sync',
    });
    // The point of PR #99: the token value must never reach the logs.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('old-token');
  });

  it('lets a Cloud Tasks upload copy queued before the switch through', async () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    validateUploadLink.mockResolvedValue({ eventId: 'ev1', linkId: 'link1', clubName: 'ClubA', tag: '' });
    enqueueStagedBatch.mockResolvedValue({ copied: 1, skippedDuplicates: 0, skippedDuplicateNames: [] });
    const res = await request(app)
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'old-token')
      .set('x-cloudtasks-taskname', 'b1')
      .send({ token: 't', batchId: 'b1', objectNames: ['vol/ev1/b1/u1.jpg'] });
    expect(res.status).toBe(200);
    expect(enqueueStagedBatch).toHaveBeenCalledTimes(1);
    expect(previousTokenWarnings(warn)[0]).toMatchObject({ taskName: 'b1' });
  });

  it('401s the old token on both paths once PREVIOUS is cleared', async () => {
    const sync = await request(app).post('/api/admin/sync').set('x-sync-token', 'old-token');
    expect(sync.status).toBe(401);
    const batch = await request(app)
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'old-token')
      .send({ token: 't', batchId: 'b1', objectNames: ['vol/ev1/b1/u1.jpg'] });
    expect(batch.status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
    expect(enqueueStagedBatch).not.toHaveBeenCalled();
  });

  it('keeps accepting the new token throughout', async () => {
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = 'old-token';
    expect((await request(app).post('/api/admin/sync').set('x-sync-token', 'new-token')).status).toBe(200);
    env.SYNC_TRIGGER_TOKEN_PREVIOUS = '';
    expect((await request(app).post('/api/admin/sync').set('x-sync-token', 'new-token')).status).toBe(200);
    expect(previousTokenWarnings(warn)).toHaveLength(0);
  });
});
