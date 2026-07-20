import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  listEventImages,
  uploadFileToDriveResumable,
  DRIVE_RESUMABLE_CHUNK_BYTES,
} from '../src/services/driveService.js';

/**
 * driveService recursion + pagination, with `fetch` stubbed and the token
 * passed explicitly (so no IAM signJwt call is ever made).
 */

function drivePage(files: unknown[], nextPageToken?: string) {
  return {
    ok: true,
    json: async () => ({ files, ...(nextPageToken ? { nextPageToken } : {}) }),
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('listEventImages', () => {
  it('recurses into subfolders, keeps images only, builds relPaths', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      // URLSearchParams encodes `'root' in parents` as %27root%27+in+parents
      if (u.includes('%27root%27')) {
        return drivePage([
          { id: 'sub', name: 'Day 2', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'a', name: 'a.jpg', mimeType: 'image/jpeg', md5Checksum: 'ma' },
          { id: 'doc', name: 'notes.txt', mimeType: 'text/plain' },
        ]);
      }
      if (u.includes('%27sub%27')) {
        return drivePage([{ id: 'b', name: 'b.heic', mimeType: 'image/heic', md5Checksum: 'mb' }]);
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const images = await listEventImages('root', { token: 't' });
    expect(images.map((i) => i.relPath).sort()).toEqual(['Day 2/b.heic', 'a.jpg']);
    expect(images.every((i) => i.mimeType.startsWith('image/'))).toBe(true);
  });

  it('does not recurse into SKIP_FOLDER_NAMES folders (e.g. Photos_zzz)', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('%27root%27')) {
        return drivePage([
          { id: 'real', name: 'real.jpg', mimeType: 'image/jpeg', md5Checksum: 'mr' },
          { id: 'dup', name: 'Photos_zzz', mimeType: 'application/vnd.google-apps.folder' },
        ]);
      }
      // If recursion into the skipped folder ever happens, this would add a
      // phantom image and inflate the fingerprint — the test asserts it doesn't.
      if (u.includes('%27dup%27')) {
        return drivePage([{ id: 'copy', name: 'real.jpg', mimeType: 'image/jpeg', md5Checksum: 'mr' }]);
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const images = await listEventImages('root', { token: 't' });
    expect(images.map((i) => i.id)).toEqual(['real']);
  });

  it('follows nextPageToken', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? drivePage([{ id: 'p1', name: '1.jpg', mimeType: 'image/jpeg' }], 'tok2')
          : drivePage([{ id: 'p2', name: '2.jpg', mimeType: 'image/jpeg' }]);
      }),
    );

    const images = await listEventImages('root', { token: 't' });
    expect(images.map((i) => i.id)).toEqual(['p1', 'p2']);
    expect(call).toBe(2);
  });

  it('surfaces Drive API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, text: async () => 'denied' }) as Response),
    );
    await expect(listEventImages('root', { token: 't' })).rejects.toThrow('Drive API 403');
  });
});

describe('uploadFileToDriveResumable', () => {
  const CHUNK = DRIVE_RESUMABLE_CHUNK_BYTES;
  const SESSION = 'https://upload.example/session-1';

  it('initiates a session and PUTs sequential Content-Range chunks until done', async () => {
    const total = 2 * CHUNK + 16 * 1024 * 1024; // 2 full chunks + a short tail
    const puts: Array<{ range: string | undefined; bytes: number }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('uploadType=resumable')) {
          const headers = init?.headers as Record<string, string>;
          expect(init?.method).toBe('POST');
          expect(headers['X-Upload-Content-Length']).toBe(String(total));
          return {
            ok: true,
            status: 200,
            headers: new Headers({ location: SESSION }),
            text: async () => '',
          } as unknown as Response;
        }
        if (u === SESSION) {
          const range = (init?.headers as Record<string, string>)['Content-Range'];
          puts.push({ range, bytes: (init?.body as Buffer).byteLength });
          const end = Number(range?.match(/-(\d+)\//)?.[1]);
          if (end + 1 === total) {
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              json: async () => ({ id: 'f1', name: 'big.mp4' }),
            } as unknown as Response;
          }
          return {
            ok: false,
            status: 308,
            headers: new Headers({ range: `bytes=0-${end}` }),
            text: async () => '',
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const reads: Array<[number, number]> = [];
    const out = await uploadFileToDriveResumable(
      'folder1',
      'big.mp4',
      'video/mp4',
      total,
      async (start, end) => {
        reads.push([start, end]);
        return Buffer.alloc(end - start + 1);
      },
      { token: 't' },
    );

    expect(out).toEqual({ id: 'f1', name: 'big.mp4' });
    expect(reads).toEqual([
      [0, CHUNK - 1],
      [CHUNK, 2 * CHUNK - 1],
      [2 * CHUNK, total - 1],
    ]);
    expect(puts.map((p) => p.range)).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`,
      `bytes ${2 * CHUNK}-${total - 1}/${total}`,
    ]);
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, CHUNK, total - 2 * CHUNK]);
  });

  it('throws instead of looping when Drive reports no committed progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('uploadType=resumable')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ location: SESSION }),
            text: async () => '',
          } as unknown as Response;
        }
        // 308 with no Range header = nothing persisted.
        return { ok: false, status: 308, headers: new Headers(), text: async () => '' } as unknown as Response;
      }),
    );

    await expect(
      uploadFileToDriveResumable('folder1', 'big.mp4', 'video/mp4', CHUNK * 2, async (start, end) =>
        Buffer.alloc(end - start + 1),
      { token: 't' }),
    ).rejects.toThrow(/stalled/);
  });
});
