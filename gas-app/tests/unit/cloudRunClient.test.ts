/**
 * cloudRunClient.test.ts — tests for the Cloud Run image-convert wrapper.
 *
 * Covers:
 *   - Refusal when CLOUD_RUN_URL is not configured (still placeholder)
 *   - Successful convert call
 *   - Non-JSON upstream response is surfaced as { ok: false, error: 'internal' }
 *   - Retries on 429 / 5xx and eventual surface of the final body
 *   - Retries on UrlFetch exceptions
 *   - Non-retriable 4xx (e.g. 401 unauthorized) is returned without retrying
 */

import { convertImage, ConvertRequest } from '@services/cloudRunClient';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const BASE_REQ: ConvertRequest = {
  sourceFileId: 'src-file-1',
  destFolderId: 'dest-folder-1',
  destName: 'out.jpg',
  jpgQuality: 92,
  maxDim: null,
  bakeOrientation: true,
  preserveExif: false,
};

/**
 * Configures PropertiesService mock with a given CLOUD_RUN_URL value.
 * Pass null to simulate the placeholder/unconfigured state.
 */
function setCloudRunUrl(value: string | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (globalThis as any).PropertiesService.getScriptProperties();
  props.getProperty.mockImplementation((key: string) => {
    if (key === 'CLOUD_RUN_URL') return value;
    return null;
  });
}

/**
 * Replaces UrlFetchApp.fetch with a queued-response mock. Each invocation
 * returns the next response in the queue. Exceptions are thrown; response
 * objects are returned.
 */
function queueFetchResponses(
  responses: Array<{ status: number; body: string } | Error>
): jest.Mock {
  const fn = jest.fn();
  for (const r of responses) {
    if (r instanceof Error) {
      fn.mockImplementationOnce(() => {
        throw r;
      });
    } else {
      fn.mockReturnValueOnce({
        getResponseCode: () => r.status,
        getContentText: () => r.body,
      });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).UrlFetchApp = { fetch: fn };
  return fn;
}

beforeEach(() => {
  // Stub ScriptApp for token lookups
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ScriptApp = {
    ...(globalThis as any).ScriptApp,
    getIdentityToken: () => 'id-token',
    getOAuthToken: () => 'user-token',
  };
  // Reset any Cloud Run URL override from previous tests
  setCloudRunUrl(null);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('convertImage — configuration', () => {
  it('refuses to call the placeholder URL and returns not_configured', () => {
    const fetchMock = queueFetchResponses([]);  // should never be called
    const res = convertImage(BASE_REQ);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('convertImage — happy path', () => {
  it('returns the parsed success response', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    const fetchMock = queueFetchResponses([
      {
        status: 200,
        body: JSON.stringify({ ok: true, destFileId: 'new-id', destSizeBytes: 1234 }),
      },
    ]);
    const res = convertImage(BASE_REQ);
    expect(res.ok).toBe(true);
    expect(res.destFileId).toBe('new-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Verify URL and auth headers were set correctly
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://image-convert-abc.a.run.app/convert');
    expect(options.headers['Authorization']).toBe('Bearer id-token');
    expect(options.headers['X-User-Access-Token']).toBe('Bearer user-token');
  });

  it('surfaces non-JSON upstream response as internal error', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    queueFetchResponses([{ status: 200, body: 'not-json-at-all' }]);
    const res = convertImage(BASE_REQ);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('internal');
    expect(res.message).toMatch(/Non-JSON/);
  });
});

describe('convertImage — retry behavior', () => {
  it('retries on 503 and returns the eventual success body', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    const fetchMock = queueFetchResponses([
      { status: 503, body: JSON.stringify({ ok: false, error: 'overloaded' }) },
      { status: 200, body: JSON.stringify({ ok: true, destFileId: 'id-2' }) },
    ]);
    const res = convertImage(BASE_REQ);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.destFileId).toBe('id-2');
  });

  it('retries on UrlFetchApp exception and succeeds on retry', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    const fetchMock = queueFetchResponses([
      new Error('DNS failure'),
      { status: 200, body: JSON.stringify({ ok: true, destFileId: 'id-3' }) },
    ]);
    const res = convertImage(BASE_REQ);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it('gives up after MAX_ATTEMPTS retriable failures', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    const fetchMock = queueFetchResponses([
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
    ]);
    const res = convertImage(BASE_REQ);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(false);
  });

  it('does NOT retry on a non-retriable 4xx (e.g. 401 unauthorized)', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    const fetchMock = queueFetchResponses([
      { status: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) },
    ]);
    const res = convertImage(BASE_REQ);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unauthorized');
  });

  it('does NOT retry on a non-retriable 404 (e.g. source_not_found)', () => {
    setCloudRunUrl('https://image-convert-abc.a.run.app');
    const fetchMock = queueFetchResponses([
      { status: 404, body: JSON.stringify({ ok: false, error: 'source_not_found' }) },
    ]);
    const res = convertImage(BASE_REQ);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('source_not_found');
  });
});
