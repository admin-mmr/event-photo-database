/**
 * Unit tests for drivePermissionsService.
 *
 * The module wraps a single Drive REST endpoint, so we stub UrlFetchApp
 * directly (same pattern as cloudRunClient.test.ts) and verify the request
 * shape plus the outcome classification.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  grantAnyoneRead,
  tryGrantAnyoneRead,
  foldBatchGrantSummary,
  EMPTY_BATCH_GRANT_SUMMARY,
} from '../../src/services/drivePermissionsService';

interface FetchResponseSpec {
  status: number;
  body: string;
}

function queueFetchResponses(
  responses: Array<FetchResponseSpec | Error>
): jest.Mock {
  const queue = [...responses];
  const fn = jest.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) {
      throw new Error('queueFetchResponses: no more queued responses');
    }
    if (next instanceof Error) throw next;
    return {
      getResponseCode: () => next.status,
      getContentText: () => next.body,
    };
  });
  (globalThis as any).UrlFetchApp = { fetch: fn };
  return fn;
}

beforeEach(() => {
  // Mock ScriptApp.getOAuthToken so getDriveAuthToken() doesn't blow up.
  (globalThis as any).ScriptApp = {
    getOAuthToken: jest.fn().mockReturnValue('test-token-abc'),
  };
  (globalThis as any).Logger = { log: jest.fn() };
});

// grantAnyoneRead() first PROBES the permission list (a GET) to detect an
// already-shared file, then only POSTs a create when no anyone-permission is
// present. Tests therefore queue the probe response before the create response.
// A probe body with no `type:'anyone'` entry means "not shared yet".
const PROBE_NOT_SHARED: FetchResponseSpec = {
  status: 200,
  body: JSON.stringify({ permissions: [{ type: 'user', role: 'owner' }] }),
};

describe('grantAnyoneRead()', () => {
  it('probes, then returns outcome=created on HTTP 200 with the permission ID', () => {
    const fetchMock = queueFetchResponses([
      PROBE_NOT_SHARED,
      { status: 200, body: JSON.stringify({ id: 'perm-xyz' }) },
    ]);

    const result = grantAnyoneRead('folder-abc');

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('created');
    expect(result.permissionId).toBe('perm-xyz');
    expect(result.status).toBe(200);

    // Two round-trips: a GET probe followed by the POST create.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [probeUrl, probeOpts] = fetchMock.mock.calls[0];
    expect(probeUrl).toContain('/drive/v3/files/folder-abc/permissions');
    expect(probeOpts.method).toBe('get');

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain('/drive/v3/files/folder-abc/permissions');
    expect(url).toContain('supportsAllDrives=true');
    expect(url).toContain('sendNotificationEmail=false');
    expect(opts.method).toBe('post');
    expect(opts.headers.Authorization).toBe('Bearer test-token-abc');
    const body = JSON.parse(opts.payload);
    expect(body.role).toBe('reader');
    expect(body.type).toBe('anyone');
    expect(body.allowFileDiscovery).toBe(false);
  });

  it('returns outcome=exists (no create POST) when an anyone-reader already exists', () => {
    const fetchMock = queueFetchResponses([
      {
        status: 200,
        body: JSON.stringify({
          permissions: [
            { type: 'user', role: 'owner' },
            { type: 'anyone', role: 'reader' },
          ],
        }),
      },
    ]);

    const result = grantAnyoneRead('folder-already-shared');
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('exists');
    // Only the probe ran — no create attempt, no re-share, nothing logged.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('get');
  });

  it('falls back to outcome=exists on a "duplicate" 400 from the create', () => {
    // Defensive fallback: if the probe missed it (e.g. a race) and the create
    // still 400s as a duplicate, we treat it as already-shared.
    queueFetchResponses([
      PROBE_NOT_SHARED,
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 400, message: 'duplicate permission' },
        }),
      },
    ]);

    const result = grantAnyoneRead('folder-dup');
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('exists');
    expect(result.status).toBe(400);
  });

  it('classifies a 5xx as outcome=error so callers can retry', () => {
    queueFetchResponses([
      PROBE_NOT_SHARED,
      { status: 500, body: 'Internal Server Error' },
    ]);

    const result = grantAnyoneRead('folder-flaky');
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.status).toBe(500);
    expect(result.error).toContain('HTTP 500');
  });

  it('classifies a non-duplicate 403 as outcome=error (not silently shared)', () => {
    queueFetchResponses([
      PROBE_NOT_SHARED,
      {
        status: 403,
        body: JSON.stringify({
          error: { message: 'The user does not have sufficient permissions.' },
        }),
      },
    ]);

    const result = grantAnyoneRead('folder-no-access');
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.status).toBe(403);
  });

  it('attempts the create when the probe itself fails (unknown state)', () => {
    // Probe throws → state unknown → fall through to create rather than
    // wrongly assuming the file is unshared-and-safe-to-skip.
    const fetchMock = queueFetchResponses([
      new Error('probe blip'),
      { status: 200, body: JSON.stringify({ id: 'perm-after-probe-fail' }) },
    ]);

    const result = grantAnyoneRead('folder-probe-fail');
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('created');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns outcome=error when the create fetch itself throws', () => {
    queueFetchResponses([PROBE_NOT_SHARED, new Error('DNS failure')]);

    const result = grantAnyoneRead('folder-network-blip');
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.status).toBe(0);
    expect(result.error).toContain('DNS failure');
  });

  it('rejects empty folderId without calling the API', () => {
    const fetchMock = queueFetchResponses([
      { status: 200, body: '{"id":"never-called"}' },
    ]);
    const result = grantAnyoneRead('');
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tryGrantAnyoneRead()', () => {
  it('returns the underlying result without throwing on error paths', () => {
    queueFetchResponses([{ status: 500, body: 'oops' }]);
    // Must not throw — that's the whole point of the try variant.
    expect(() => tryGrantAnyoneRead('folder-x')).not.toThrow();
  });
});

describe('foldBatchGrantSummary()', () => {
  it('counts a created result', () => {
    const summary = foldBatchGrantSummary(EMPTY_BATCH_GRANT_SUMMARY, {
      ok: true,
      outcome: 'created',
      status: 200,
    });
    expect(summary.created).toBe(1);
    expect(summary.alreadyShared).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it('counts an exists result without inflating created', () => {
    const summary = foldBatchGrantSummary(EMPTY_BATCH_GRANT_SUMMARY, {
      ok: true,
      outcome: 'exists',
      status: 400,
    });
    expect(summary.created).toBe(0);
    expect(summary.alreadyShared).toBe(1);
  });

  it('appends a contextual message for error outcomes', () => {
    const summary = foldBatchGrantSummary(
      EMPTY_BATCH_GRANT_SUMMARY,
      { ok: false, outcome: 'error', status: 500, error: 'boom' },
      'photos/Photos_001(drv-1)'
    );
    expect(summary.errors).toBe(1);
    expect(summary.errorSample[0]).toBe('photos/Photos_001(drv-1): boom');
  });

  it('caps errorSample at 20 entries to keep logs readable', () => {
    let summary = EMPTY_BATCH_GRANT_SUMMARY;
    for (let i = 0; i < 30; i++) {
      summary = foldBatchGrantSummary(
        summary,
        { ok: false, outcome: 'error', status: 500, error: `err-${i}` },
        `ctx-${i}`
      );
    }
    expect(summary.errors).toBe(30);
    expect(summary.errorSample.length).toBe(20);
    expect(summary.errorSample[0]).toBe('ctx-0: err-0');
    expect(summary.errorSample[19]).toBe('ctx-19: err-19');
  });
});
