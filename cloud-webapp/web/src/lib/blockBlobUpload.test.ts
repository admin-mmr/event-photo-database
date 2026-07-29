import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  blockId,
  blockOffset,
  buildBlockListXml,
  commitBlockList,
  missingBlocks,
  parseUncommittedBlockIds,
  queryStagedBlocks,
  stagedBytes,
  withQuery,
} from './blockBlobUpload.js';

afterEach(() => vi.unstubAllGlobals());

describe('blockId', () => {
  it('is fixed-width base64, which Azure requires of every block in a blob', () => {
    // Variable-length ids are rejected on Put Block List, so the padding is not
    // cosmetic. 5 digits covers Azure's 50,000-block ceiling.
    expect(blockId(0)).toBe(btoa('00000'));
    expect(blockId(42)).toBe(btoa('00042'));
    expect(blockId(0).length).toBe(blockId(9999).length);
  });

  it('orders lexicographically with the block index', () => {
    // Not required by the service (the block list carries the order) but it makes
    // a `Get Block List` response readable when debugging a stuck upload.
    expect([blockId(2), blockId(10), blockId(1)].sort()).toEqual([blockId(1), blockId(2), blockId(10)]);
  });
});

describe('withQuery', () => {
  it('adds parameters without dropping the SAS token', () => {
    const out = withQuery('https://a.blob.core.windows.net/c/b.jpg?sig=abc&se=2026', {
      comp: 'block',
      blockid: 'MDAwMDA=',
    });
    expect(out).toContain('sig=abc');
    expect(out).toContain('se=2026');
    expect(out).toContain('comp=block');
    expect(out).toContain('blockid=MDAwMDA%3D');
  });

  it('replaces a parameter rather than appending a duplicate', () => {
    const out = withQuery('https://a.blob.core.windows.net/c/b.jpg?comp=block', { comp: 'blocklist' });
    expect(out.match(/comp=/g)).toHaveLength(1);
    expect(out).toContain('comp=blocklist');
  });
});

describe('parseUncommittedBlockIds', () => {
  it('pulls the block names out of a Get Block List response', () => {
    const xml = `<?xml version="1.0"?><BlockList><UncommittedBlocks>
      <Block><Name>MDAwMDA=</Name><Size>8388608</Size></Block>
      <Block><Name>MDAwMDE=</Name><Size>8388608</Size></Block>
    </UncommittedBlocks></BlockList>`;
    expect([...parseUncommittedBlockIds(xml)]).toEqual(['MDAwMDA=', 'MDAwMDE=']);
  });

  it('is empty for a blob with nothing staged', () => {
    expect(parseUncommittedBlockIds('<?xml version="1.0"?><BlockList />').size).toBe(0);
  });
});

describe('buildBlockListXml', () => {
  it('lists every block in order, as Latest', () => {
    // Order in the body IS the order of bytes in the blob — get it wrong and the
    // photo is scrambled rather than failing loudly.
    expect(buildBlockListXml(2)).toBe(
      `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId(0)}</Latest><Latest>${blockId(1)}</Latest></BlockList>`,
    );
  });
});

describe('missingBlocks / stagedBytes', () => {
  const CHUNK = 8 * 1024 * 1024;

  it('asks for every block on a fresh upload', () => {
    expect(missingBlocks(3 * CHUNK, CHUNK, new Set())).toEqual([0, 1, 2]);
    expect(stagedBytes(3 * CHUNK, CHUNK, new Set())).toBe(0);
  });

  it('skips what the service already holds — this is the resume', () => {
    const staged = new Set([blockId(0), blockId(1)]);
    expect(missingBlocks(3 * CHUNK, CHUNK, staged)).toEqual([2]);
    expect(stagedBytes(3 * CHUNK, CHUNK, staged)).toBe(2 * CHUNK);
  });

  it('re-sends a block the service does NOT report, even out of order', () => {
    // A PUT cut off mid-flight leaves no staged block, so block 1 comes back on
    // the work list while 0 and 2 stay done. Put Block is idempotent per id, so
    // re-sending is always safe.
    const staged = new Set([blockId(0), blockId(2)]);
    expect(missingBlocks(3 * CHUNK, CHUNK, staged)).toEqual([1]);
  });

  it('counts the final short block at its real size, not a whole chunk', () => {
    const total = CHUNK + 100;
    const staged = new Set([blockId(0), blockId(1)]);
    expect(missingBlocks(total, CHUNK, staged)).toEqual([]);
    expect(stagedBytes(total, CHUNK, staged)).toBe(total);
  });

  it('treats an empty file as one block, so it still gets committed', () => {
    expect(missingBlocks(0, CHUNK, new Set())).toEqual([0]);
  });
});

describe('queryStagedBlocks', () => {
  it('treats 404 as "nothing staged", which is the fresh-upload case', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false }) as unknown as Response));
    expect((await queryStagedBlocks('https://a/c/b.jpg?sig=x')).size).toBe(0);
  });

  it('asks for the UNCOMMITTED list specifically', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        ({ status: 200, ok: true, text: async () => '<BlockList />' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    await queryStagedBlocks('https://a/c/b.jpg?sig=x');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('comp=blocklist');
    // The committed list would be empty for an in-progress upload and the
    // volunteer would re-send every byte they had already sent.
    expect(url).toContain('blocklisttype=uncommitted');
  });

  it('throws on an unexpected status instead of silently restarting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 403, ok: false }) as unknown as Response));
    await expect(queryStagedBlocks('https://a/c/b.jpg?sig=x')).rejects.toThrow(/HTTP 403/);
  });
});

describe('commitBlockList', () => {
  /** A `fetch` double that records its url + init, typed so the calls are too. */
  function captureFetch() {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        ({ ok: true, status: 201 }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** The headers of the Nth recorded request. */
  function headersOf(fetchMock: ReturnType<typeof captureFetch>, n = 0): Record<string, string> {
    return (fetchMock.mock.calls[n]?.[1]?.headers ?? {}) as Record<string, string>;
  }

  it('stamps the metadata, because the commit overwrites whatever was there', async () => {
    // Put Block List replaces the blob's properties and metadata, so this
    // request is the ONLY chance to attach photographer credit. Losing it is how
    // a volunteer's name would silently vanish from every Azure upload.
    const fetchMock = captureFetch();
    await commitBlockList('https://a/c/b.jpg?sig=x', 2, 'image/jpeg', {
      originalName: 'race-001.jpg',
      photographerName: 'Jane Doe',
    });
    const headers = headersOf(fetchMock);
    expect(headers['x-ms-meta-originalName']).toBe('race-001.jpg');
    expect(headers['x-ms-meta-photographerName']).toBe('Jane Doe');
    expect(headers['x-ms-blob-content-type']).toBe('image/jpeg');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('comp=blocklist');
  });

  it('omits a blank metadata value rather than sending an empty header', async () => {
    // An uncredited upload is legitimate (the name is optional), and an empty
    // x-ms-meta header is rejected by the service.
    const fetchMock = captureFetch();
    await commitBlockList('https://a/c/b.jpg?sig=x', 1, 'image/jpeg', { photographerName: '' });
    expect(headersOf(fetchMock)['x-ms-meta-photographerName']).toBeUndefined();
  });

  it('defaults a missing content type', async () => {
    const fetchMock = captureFetch();
    await commitBlockList('https://a/c/b.jpg?sig=x', 1, '', {});
    expect(headersOf(fetchMock)['x-ms-blob-content-type']).toBe('application/octet-stream');
  });

  it('throws when the commit fails, so the file is never reported as uploaded', async () => {
    // Nothing exists until this succeeds: a swallowed failure would mark the
    // photo done with no object behind it, and the batch would never be recovered.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response));
    await expect(commitBlockList('https://a/c/b.jpg?sig=x', 1, 'image/jpeg', {})).rejects.toThrow(
      /HTTP 400/,
    );
  });
});

describe('blockOffset', () => {
  it('is the byte the block starts at', () => {
    expect(blockOffset(0, 1000)).toBe(0);
    expect(blockOffset(3, 1000)).toBe(3000);
  });
});
