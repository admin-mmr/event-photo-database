/**
 * indexTriggerClient.test.ts — tests for the two best-effort cloud-webapp
 * triggers fired from the gas-app: triggerEventIndex (POST /api/events/:id/index)
 * and triggerMetadataSync (POST /api/admin/sync, §5A B8).
 *
 * Both must be fire-and-forget: a missing config, a non-2xx upstream, or a
 * thrown UrlFetch exception is logged and swallowed (never thrown), so callers
 * can wrap them in a try/catch and never surface an error to the admin.
 */

import { triggerEventIndex, triggerMetadataSync } from '@services/indexTriggerClient';
import { mockScriptProperties, resetMockScriptProperties } from '../mocks/gasGlobals';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Configure the api URL + shared token Script Properties (or clear them). */
function configureTrigger(url: string | null, token: string | null): void {
  if (url === null) mockScriptProperties.deleteProperty('FINDME_API_URL');
  else mockScriptProperties.setProperty('FINDME_API_URL', url);
  if (token === null) mockScriptProperties.deleteProperty('INDEX_TRIGGER_TOKEN');
  else mockScriptProperties.setProperty('INDEX_TRIGGER_TOKEN', token);
}

/** Replace UrlFetchApp.fetch with a single queued response (or thrown error). */
function mockFetch(result: { status: number; body?: string } | Error): jest.Mock {
  const fn = jest.fn();
  if (result instanceof Error) {
    fn.mockImplementation(() => {
      throw result;
    });
  } else {
    fn.mockReturnValue({
      getResponseCode: () => result.status,
      getContentText: () => result.body ?? '',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).UrlFetchApp = { fetch: fn };
  return fn;
}

beforeEach(() => {
  resetMockScriptProperties();
  // gasGlobals' mockScriptApp has no getIdentityToken — add it (as cloudRunClient.test does).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ScriptApp = {
    ...(globalThis as any).ScriptApp,
    getIdentityToken: () => 'id-token',
  };
  configureTrigger('https://event-photo-api-abc.a.run.app', 'secret-token');
});

// ─── triggerMetadataSync (§5A B8) ─────────────────────────────────────────────

describe('triggerMetadataSync', () => {
  it('no-ops (no fetch) when FINDME_API_URL / INDEX_TRIGGER_TOKEN are unset', () => {
    configureTrigger(null, null);
    const fetchMock = mockFetch({ status: 200, body: '{"ok":true}' });
    const res = triggerMetadataSync('event_created');
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs /api/admin/sync with OIDC + X-Sync-Token and returns triggered on 200', () => {
    const fetchMock = mockFetch({ status: 200, body: '{"ok":true}' });
    const res = triggerMetadataSync('event_created');
    expect(res.triggered).toBe(true);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://event-photo-api-abc.a.run.app/api/admin/sync');
    expect(options.method).toBe('post');
    expect(options.headers['Authorization']).toBe('Bearer id-token');
    expect(options.headers['X-Sync-Token']).toBe('secret-token');
    expect(options.muteHttpExceptions).toBe(true);
  });

  it('accepts a 202 as triggered', () => {
    mockFetch({ status: 202 });
    expect(triggerMetadataSync().triggered).toBe(true);
  });

  it('swallows a non-2xx response (returns http_<status>, never throws)', () => {
    mockFetch({ status: 503, body: 'overloaded' });
    const res = triggerMetadataSync('link_generated');
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe('http_503');
    expect(res.status).toBe(503);
  });

  it('swallows a thrown UrlFetch exception (returns request_failed, never throws)', () => {
    mockFetch(new Error('DNS failure'));
    const res = triggerMetadataSync('event_created');
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe('request_failed');
  });
});

// ─── triggerEventIndex (existing path, covered for regression safety) ─────────

describe('triggerEventIndex', () => {
  it('returns missing_event_id without fetching when eventId is empty', () => {
    const fetchMock = mockFetch({ status: 202 });
    const res = triggerEventIndex('');
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe('missing_event_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops when not configured', () => {
    configureTrigger(null, null);
    const fetchMock = mockFetch({ status: 202 });
    const res = triggerEventIndex('evt-1');
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs /api/events/:id/index and returns triggered on 202', () => {
    const fetchMock = mockFetch({ status: 202 });
    const res = triggerEventIndex('evt-1');
    expect(res.triggered).toBe(true);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://event-photo-api-abc.a.run.app/api/events/evt-1/index');
  });

  it('treats 409 already_running as benign (not triggered, not an error)', () => {
    mockFetch({ status: 409, body: 'already_running' });
    const res = triggerEventIndex('evt-1');
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe('already_running');
    expect(res.status).toBe(409);
  });

  it('url-encodes the event id', () => {
    const fetchMock = mockFetch({ status: 200 });
    triggerEventIndex('evt/with space');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://event-photo-api-abc.a.run.app/api/events/evt%2Fwith%20space/index');
  });
});
