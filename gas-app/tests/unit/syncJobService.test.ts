/**
 * syncJobService.test.ts — Unit tests for PropertiesService-backed sync job tracking.
 *
 * Coverage:
 *   createJob()          — creates pending job, writes to PropertiesService
 *   getJob()             — deserialise + default-merge; null for missing/corrupt
 *   updateJob()          — pending→running auto-promotion, error append, null guard
 *   incrementJobCounters() — delta accumulation, currentStep passthrough
 *   completeJob()        — terminal status, finalMessage, expiresAt extension
 *   requestCancel()      — sets flag, refuses on terminal jobs, false on missing
 *   isCancelRequested()  — reads flag; safe on missing job
 *   sweepExpired()       — removes expired + corrupt records, leaves live ones
 */

import {
  createJob,
  getJob,
  updateJob,
  incrementJobCounters,
  completeJob,
  requestCancel,
  isCancelRequested,
  sweepExpired,
} from '../../src/services/syncJobService';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/utils/uuid', () => ({
  generateUuid: jest.fn(() => 'test-uuid-001'),
}));

jest.mock('../../src/utils/dateFormatter', () => ({
  nowIsoTimestamp: jest.fn(() => '2026-04-23T10:00:00.000Z'),
}));

// ─── PropertiesService mock ───────────────────────────────────────────────────

const mockStore: Record<string, string> = {};

const mockScriptProperties = {
  getProperty:    jest.fn((key: string) => mockStore[key] ?? null),
  setProperty:    jest.fn((key: string, value: string) => { mockStore[key] = value; }),
  deleteProperty: jest.fn((key: string) => { delete mockStore[key]; }),
  getProperties:  jest.fn(() => ({ ...mockStore })),
};

(global as unknown as Record<string, unknown>).PropertiesService = {
  getScriptProperties: jest.fn(() => mockScriptProperties),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearStore() {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
}

function storeKey(jobId: string) {
  return `sync_job_${jobId}`;
}

function writeRaw(jobId: string, data: object) {
  mockStore[storeKey(jobId)] = JSON.stringify(data);
}

// ─── createJob() ──────────────────────────────────────────────────────────────

describe('createJob()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns a job in pending status', () => {
    const job = createJob('sync-event', 'evt-001');
    expect(job.status).toBe('pending');
    expect(job.jobType).toBe('sync-event');
    expect(job.eventId).toBe('evt-001');
  });

  it('persists the job to PropertiesService', () => {
    createJob('sync-event', 'evt-001');
    expect(mockScriptProperties.setProperty).toHaveBeenCalledWith(
      storeKey('test-uuid-001'),
      expect.stringContaining('"status":"pending"')
    );
  });

  it('initialises all counters to zero', () => {
    const job = createJob('backfill-all');
    expect(job.photosSynced).toBe(0);
    expect(job.photosSkipped).toBe(0);
    expect(job.photosDeduplicated).toBe(0);
    expect(job.albumsCreated).toBe(0);
    expect(job.eventsProcessed).toBe(0);
    expect(job.errors).toEqual([]);
    expect(job.cancelRequested).toBe(false);
  });

  it('defaults eventId to empty string when not provided', () => {
    const job = createJob('backfill-all');
    expect(job.eventId).toBe('');
  });

  it('sets expiresAt in the future', () => {
    const before = Date.now();
    const job = createJob('sync-event');
    const expiresMs = new Date(job.expiresAt).getTime();
    expect(expiresMs).toBeGreaterThan(before);
  });
});

// ─── getJob() ─────────────────────────────────────────────────────────────────

describe('getJob()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns null for an unknown jobId', () => {
    expect(getJob('nonexistent')).toBeNull();
  });

  it('returns null for a corrupt (non-JSON) stored value', () => {
    mockStore[storeKey('bad-job')] = 'not-json{{{';
    expect(getJob('bad-job')).toBeNull();
  });

  it('returns the stored job for a known jobId', () => {
    const job = createJob('sync-event', 'evt-123');
    const fetched = getJob(job.jobId);
    expect(fetched).not.toBeNull();
    expect(fetched!.jobId).toBe(job.jobId);
    expect(fetched!.eventId).toBe('evt-123');
  });

  it('applies defaults for fields missing in older records (backward compat)', () => {
    // Simulate a record written by an older version missing newer fields
    writeRaw('old-job', {
      jobId:   'old-job',
      jobType: 'sync-event',
      status:  'running',
      // photosDeduplicated, albumsCreated, eventsTotal etc. are absent
    });
    const job = getJob('old-job');
    expect(job).not.toBeNull();
    expect(job!.photosDeduplicated).toBe(0);
    expect(job!.albumsCreated).toBe(0);
    expect(job!.eventsTotal).toBe(0);
    expect(job!.errors).toEqual([]);
  });

  it('stored values take precedence over defaults', () => {
    writeRaw('job-with-data', {
      jobId:        'job-with-data',
      jobType:      'backfill-all',
      status:       'running',
      photosSynced: 42,
      errors:       ['something went wrong'],
    });
    const job = getJob('job-with-data');
    expect(job!.photosSynced).toBe(42);
    expect(job!.errors).toEqual(['something went wrong']);
  });
});

// ─── updateJob() ──────────────────────────────────────────────────────────────

describe('updateJob()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns null for an unknown jobId', () => {
    expect(updateJob('ghost', { currentStep: 'step' })).toBeNull();
  });

  it('auto-promotes status from pending to running on first update', () => {
    const job = createJob('sync-event');
    expect(job.status).toBe('pending');

    const updated = updateJob(job.jobId, { currentStep: 'Doing work' });
    expect(updated!.status).toBe('running');
  });

  it('does not auto-promote if status is already running', () => {
    writeRaw('running-job', { jobId: 'running-job', jobType: 'sync-event', status: 'running', errors: [] });
    const updated = updateJob('running-job', { currentStep: 'Still working' });
    expect(updated!.status).toBe('running');
  });

  it('respects an explicit status in the patch (e.g. completed)', () => {
    const job = createJob('sync-event');
    const updated = updateJob(job.jobId, { status: 'completed', finalMessage: 'Done!' });
    expect(updated!.status).toBe('completed');
  });

  it('concatenates errors rather than replacing them', () => {
    writeRaw('err-job', {
      jobId:   'err-job',
      jobType: 'sync-event',
      status:  'running',
      errors:  ['first error'],
    });
    const updated = updateJob('err-job', { errors: ['second error'] });
    expect(updated!.errors).toEqual(['first error', 'second error']);
  });

  it('preserves existing fields not included in the patch', () => {
    writeRaw('partial-job', {
      jobId:        'partial-job',
      jobType:      'backfill-all',
      status:       'running',
      photosSynced: 10,
      errors:       [],
    });
    const updated = updateJob('partial-job', { currentStep: 'New step' });
    expect(updated!.photosSynced).toBe(10);
    expect(updated!.currentStep).toBe('New step');
  });

  it('persists the merged result to PropertiesService', () => {
    const job = createJob('sync-event');
    jest.clearAllMocks();
    updateJob(job.jobId, { currentStep: 'Working' });
    expect(mockScriptProperties.setProperty).toHaveBeenCalledWith(
      storeKey(job.jobId),
      expect.stringContaining('"currentStep":"Working"')
    );
  });
});

// ─── incrementJobCounters() ───────────────────────────────────────────────────

describe('incrementJobCounters()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns null for an unknown jobId', () => {
    expect(incrementJobCounters('ghost', { photosSynced: 1 })).toBeNull();
  });

  it('adds delta to photosSynced', () => {
    writeRaw('counter-job', {
      jobId: 'counter-job', jobType: 'sync-event', status: 'running',
      photosSynced: 5, photosSkipped: 0, photosDeduplicated: 0,
      albumsCreated: 0, eventsProcessed: 0, errors: [],
    });
    const result = incrementJobCounters('counter-job', { photosSynced: 3 });
    expect(result!.photosSynced).toBe(8);
  });

  it('accumulates multiple counter deltas simultaneously', () => {
    writeRaw('multi-counter', {
      jobId: 'multi-counter', jobType: 'sync-event', status: 'running',
      photosSynced: 2, photosSkipped: 1, photosDeduplicated: 0,
      albumsCreated: 1, eventsProcessed: 0, errors: [],
    });
    const result = incrementJobCounters('multi-counter', {
      photosSynced: 10,
      photosSkipped: 2,
      albumsCreated: 1,
    });
    expect(result!.photosSynced).toBe(12);
    expect(result!.photosSkipped).toBe(3);
    expect(result!.albumsCreated).toBe(2);
    expect(result!.photosDeduplicated).toBe(0); // untouched
  });

  it('does not alter counters not present in deltas', () => {
    writeRaw('partial-delta', {
      jobId: 'partial-delta', jobType: 'sync-event', status: 'running',
      photosSynced: 5, photosSkipped: 2, photosDeduplicated: 3,
      albumsCreated: 0, eventsProcessed: 0, errors: [],
    });
    incrementJobCounters('partial-delta', { photosSynced: 1 });
    const job = getJob('partial-delta')!;
    expect(job.photosSkipped).toBe(2);
    expect(job.photosDeduplicated).toBe(3);
  });

  it('sets currentStep when provided', () => {
    writeRaw('step-job', {
      jobId: 'step-job', jobType: 'sync-event', status: 'running',
      photosSynced: 0, photosSkipped: 0, photosDeduplicated: 0,
      albumsCreated: 0, eventsProcessed: 0, errors: [], currentStep: 'old step',
    });
    const result = incrementJobCounters('step-job', { photosSynced: 1 }, 'new step');
    expect(result!.currentStep).toBe('new step');
  });

  it('leaves currentStep unchanged when not provided', () => {
    writeRaw('no-step', {
      jobId: 'no-step', jobType: 'sync-event', status: 'running',
      photosSynced: 0, photosSkipped: 0, photosDeduplicated: 0,
      albumsCreated: 0, eventsProcessed: 0, errors: [], currentStep: 'keep me',
    });
    incrementJobCounters('no-step', { photosSynced: 1 });
    expect(getJob('no-step')!.currentStep).toBe('keep me');
  });
});

// ─── completeJob() ────────────────────────────────────────────────────────────

describe('completeJob()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns null for an unknown jobId', () => {
    expect(completeJob('ghost', 'completed', 'done')).toBeNull();
  });

  it('sets status to completed and stores finalMessage', () => {
    writeRaw('done-job', { jobId: 'done-job', jobType: 'sync-event', status: 'running', errors: [] });
    const result = completeJob('done-job', 'completed', 'Synced 42 photos');
    expect(result!.status).toBe('completed');
    expect(result!.finalMessage).toBe('Synced 42 photos');
    expect(result!.currentStep).toBe('Done');
  });

  it('sets status to failed with appropriate currentStep', () => {
    writeRaw('fail-job', { jobId: 'fail-job', jobType: 'sync-event', status: 'running', errors: [] });
    const result = completeJob('fail-job', 'failed', 'Drive folder not found');
    expect(result!.status).toBe('failed');
    expect(result!.currentStep).toBe('Failed');
  });

  it('sets status to cancelled with appropriate currentStep', () => {
    writeRaw('cancel-job', { jobId: 'cancel-job', jobType: 'sync-event', status: 'running', errors: [] });
    const result = completeJob('cancel-job', 'cancelled', 'User cancelled');
    expect(result!.status).toBe('cancelled');
    expect(result!.currentStep).toBe('Cancelled');
  });

  it('extends expiresAt to 24 h from now (longer than running TTL)', () => {
    writeRaw('ttl-job', { jobId: 'ttl-job', jobType: 'sync-event', status: 'running', errors: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString() }); // short TTL
    const before = Date.now();
    const result = completeJob('ttl-job', 'completed', 'done');
    const expiresMs = new Date(result!.expiresAt).getTime();
    // Should be ~24 h from now, definitely more than 1 h away
    expect(expiresMs - before).toBeGreaterThan(60 * 60 * 1000);
  });
});

// ─── requestCancel() ─────────────────────────────────────────────────────────

describe('requestCancel()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns false for an unknown jobId', () => {
    expect(requestCancel('ghost')).toBe(false);
  });

  it('returns false for a completed job', () => {
    writeRaw('done-job', { jobId: 'done-job', jobType: 'sync-event', status: 'completed', errors: [] });
    expect(requestCancel('done-job')).toBe(false);
  });

  it('returns false for a failed job', () => {
    writeRaw('fail-job', { jobId: 'fail-job', jobType: 'sync-event', status: 'failed', errors: [] });
    expect(requestCancel('fail-job')).toBe(false);
  });

  it('returns false for an already-cancelled job', () => {
    writeRaw('cancelled-job', { jobId: 'cancelled-job', jobType: 'sync-event', status: 'cancelled', errors: [] });
    expect(requestCancel('cancelled-job')).toBe(false);
  });

  it('returns true and sets cancelRequested on a running job', () => {
    writeRaw('running-job', { jobId: 'running-job', jobType: 'sync-event', status: 'running', errors: [] });
    const result = requestCancel('running-job');
    expect(result).toBe(true);
    expect(getJob('running-job')!.cancelRequested).toBe(true);
  });

  it('returns true and sets cancelRequested on a pending job', () => {
    writeRaw('pending-job', { jobId: 'pending-job', jobType: 'sync-event', status: 'pending', errors: [] });
    expect(requestCancel('pending-job')).toBe(true);
    expect(getJob('pending-job')!.cancelRequested).toBe(true);
  });
});

// ─── isCancelRequested() ─────────────────────────────────────────────────────

describe('isCancelRequested()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns false for an unknown jobId', () => {
    expect(isCancelRequested('ghost')).toBe(false);
  });

  it('returns false when cancelRequested is false', () => {
    writeRaw('normal-job', { jobId: 'normal-job', jobType: 'sync-event', status: 'running',
      cancelRequested: false, errors: [] });
    expect(isCancelRequested('normal-job')).toBe(false);
  });

  it('returns true when cancelRequested is true', () => {
    writeRaw('cancel-job', { jobId: 'cancel-job', jobType: 'sync-event', status: 'running',
      cancelRequested: true, errors: [] });
    expect(isCancelRequested('cancel-job')).toBe(true);
  });
});

// ─── sweepExpired() ───────────────────────────────────────────────────────────

describe('sweepExpired()', () => {
  beforeEach(() => { jest.clearAllMocks(); clearStore(); });

  it('returns 0 when the store is empty', () => {
    expect(sweepExpired()).toBe(0);
  });

  it('removes jobs whose expiresAt is in the past', () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    writeRaw('expired-job', { jobId: 'expired-job', jobType: 'sync-event',
      status: 'completed', expiresAt: pastExpiry, errors: [] });

    const removed = sweepExpired();
    expect(removed).toBe(1);
    expect(getJob('expired-job')).toBeNull();
  });

  it('keeps jobs whose expiresAt is in the future', () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    writeRaw('live-job', { jobId: 'live-job', jobType: 'sync-event',
      status: 'running', expiresAt: futureExpiry, errors: [] });

    sweepExpired();
    expect(getJob('live-job')).not.toBeNull();
  });

  it('removes corrupt (non-JSON) records', () => {
    mockStore[storeKey('corrupt-job')] = 'this is not JSON';
    const removed = sweepExpired();
    expect(removed).toBe(1);
    expect(mockStore[storeKey('corrupt-job')]).toBeUndefined();
  });

  it('does not touch keys that do not start with sync_job_', () => {
    mockStore['some_other_key'] = 'some value';
    sweepExpired();
    expect(mockStore['some_other_key']).toBe('some value');
  });

  it('removes only expired records and leaves live ones intact', () => {
    const past   = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    writeRaw('expired', { jobId: 'expired', jobType: 'sync-event', status: 'completed', expiresAt: past,   errors: [] });
    writeRaw('live',    { jobId: 'live',    jobType: 'sync-event', status: 'running',   expiresAt: future, errors: [] });

    const removed = sweepExpired();
    expect(removed).toBe(1);
    expect(getJob('live')).not.toBeNull();
  });
});
