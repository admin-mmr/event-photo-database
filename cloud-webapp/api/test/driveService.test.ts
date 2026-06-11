import { describe, it, expect, vi, afterEach } from 'vitest';
import { listEventImages } from '../src/services/driveService.js';

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
