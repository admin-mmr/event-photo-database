/**
 * POST /api/admin/upload-recovery-sweep — the hourly Cloud Scheduler entry point.
 * The rules live in uploadRecoverySweep.test.ts; this pins the wiring: machine
 * token only, dry run by default, and an audit row only when something moved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Must be set before config.ts is imported by the server.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';
process.env.MASTER_SPREADSHEET_ID = 'sheet1';

const sweepStagedUploads = vi.fn();
vi.mock('../src/services/uploadRecoverySweep.js', () => ({
  sweepStagedUploads: (opts: unknown) => sweepStagedUploads(opts),
}));

const recordAudit = vi.fn(async () => undefined);
vi.mock('../src/services/auditStore.js', () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...(a as [])),
}));

const { buildServer } = await import('../src/server.js');

function report(dispatchedObjects: number): Record<string, unknown> {
  return {
    apply: true,
    stagedObjects: 3,
    strandedObjects: 3,
    events: 1,
    batches: { recover: 1, active: 0, settling: 0, cooldown: 0, young: 0 },
    dispatched: { objects: dispatchedObjects, tasks: dispatchedObjects ? 1 : 0, batches: dispatchedObjects ? 1 : 0 },
    overdue: { objects: 0, oldestHours: 0, events: [] },
    alerted: false,
    warnings: [],
  };
}

beforeEach(() => {
  sweepStagedUploads.mockReset().mockResolvedValue(report(3));
  recordAudit.mockClear();
});

describe('POST /api/admin/upload-recovery-sweep', () => {
  it('refuses a caller with no machine token or session', async () => {
    const res = await request(buildServer()).post('/api/admin/upload-recovery-sweep').send({ apply: true });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(sweepStagedUploads).not.toHaveBeenCalled();
  });

  it('is a dry run unless apply is exactly true', async () => {
    const res = await request(buildServer())
      .post('/api/admin/upload-recovery-sweep')
      .set('x-sync-token', 'cron-secret')
      .send({ apply: 'true' });
    expect(res.status).toBe(200);
    expect(sweepStagedUploads).toHaveBeenCalledWith({ apply: false });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('applies for the scheduler and audits what it re-dispatched', async () => {
    const res = await request(buildServer())
      .post('/api/admin/upload-recovery-sweep')
      .set('x-sync-token', 'cron-secret')
      .send({ apply: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, dispatched: { objects: 3 } });
    expect(sweepStagedUploads).toHaveBeenCalledWith({ apply: true });
    expect(recordAudit).toHaveBeenCalledWith(
      'sheet1',
      expect.objectContaining({ action: 'UPLOAD_RECOVERY_SWEEP', details: expect.objectContaining({ objects: 3 }) }),
    );
  });

  it('writes no audit row for an hour where nothing needed re-sending', async () => {
    sweepStagedUploads.mockResolvedValue(report(0));
    const res = await request(buildServer())
      .post('/api/admin/upload-recovery-sweep')
      .set('x-sync-token', 'cron-secret')
      .send({ apply: true });
    expect(res.status).toBe(202);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
