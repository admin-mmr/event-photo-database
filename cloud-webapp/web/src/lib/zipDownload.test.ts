import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportClientError = vi.fn();
vi.mock('./reportError.js', () => ({ reportClientError: (...a: unknown[]) => reportClientError(...a) }));
const downloadBlob = vi.fn();
vi.mock('./share.js', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

const { downloadOriginalsZip } = await import('./zipDownload.js');
import type { FetchOriginalsResult, OriginalsFetcher } from './originals.js';

function fetcherReturning(r: FetchOriginalsResult): OriginalsFetcher {
  return { fetch: async () => r } as unknown as OriginalsFetcher;
}

beforeEach(() => {
  reportClientError.mockReset();
  downloadBlob.mockReset();
});

describe('downloadOriginalsZip', () => {
  it('an all-aborted fetch is a quiet cancel: no ZIP, no error, no report', async () => {
    const r = await downloadOriginalsZip(
      fetcherReturning({ entries: [], failed: 0, cancelled: 50, sampleErrors: [] }),
      'ev1',
      ['p1'],
      'x.zip',
    );
    expect(r).toEqual({ included: 0, failed: 0, cancelled: true });
    expect(reportClientError).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('a real total failure is still reported and thrown', async () => {
    await expect(
      downloadOriginalsZip(
        fetcherReturning({ entries: [], failed: 2, cancelled: 0, sampleErrors: ['HTTP 503'] }),
        'ev1',
        ['p1', 'p2'],
        'x.zip',
      ),
    ).rejects.toThrow(/could be downloaded/);
    expect(reportClientError).toHaveBeenCalledWith('download_failed', expect.any(String), expect.anything());
  });
});
