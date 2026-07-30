/**
 * sheetsService.unhideSheetTabs — the self-heal for a managed tab hidden by hand
 * in the Sheets UI. The field case: "Video Folders" sat state="hidden" on the
 * public folder-index sheet holding 11 current rows, invisible to everyone,
 * because nothing in the rebuild path looks at tab visibility.
 *
 * The traps pinned down here: a visible tab reports NO `hidden` field at all (so
 * a loose truthiness check would be fine but `hidden: false` must never be
 * treated as hidden), and the whole set must cost at most ONE batchUpdate — a
 * per-tab write would multiply the shared per-subject Sheets quota.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/googleCredentials.js', () => ({
  mintDwdToken: async () => 'test-token',
}));
// isProd is read by logger.ts, pulled in transitively via driveRateLimit.
vi.mock('../src/lib/config.js', () => ({ env: { DWD_SUBJECT: 'admin@example.org' }, isProd: false }));

const { unhideSheetTabs } = await import('../src/services/sheetsService.js');

interface Props {
  sheetId: number;
  title: string;
  hidden?: boolean;
}

const calls: Array<{ url: string; method: string; body?: unknown }> = [];

/** Stub the Sheets API: a `?fields=` GET returns `sheets`, batchUpdate returns {}. */
function stubSheets(sheets: Props[], opts?: { batchStatus?: number }): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      return new Response(JSON.stringify({ sheets: sheets.map((properties) => ({ properties })) }), { status: 200 });
    }
    const status = opts?.batchStatus ?? 200;
    return new Response(status === 200 ? '{}' : 'nope', { status });
  });
}

const batchUpdates = (): Array<{ url: string; method: string; body?: unknown }> =>
  calls.filter((c) => c.method === 'POST');

beforeEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe('unhideSheetTabs', () => {
  it('un-hides only the hidden tabs it was asked about, in one batchUpdate', async () => {
    stubSheets([
      { sheetId: 1, title: 'Photo Folders' },
      { sheetId: 4, title: 'Video Folders', hidden: true },
      { sheetId: 9, title: '岚山', hidden: true },
    ]);

    const restored = await unhideSheetTabs('sheet1', ['Photo Folders', 'Video Folders', '岚山']);

    expect(restored).toEqual(['Video Folders', '岚山']);
    const posts = batchUpdates();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain(':batchUpdate');
    expect(posts[0]!.body).toEqual({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 4, hidden: false }, fields: 'hidden' } },
        { updateSheetProperties: { properties: { sheetId: 9, hidden: false }, fields: 'hidden' } },
      ],
    });
  });

  it('writes nothing when every requested tab is already visible', async () => {
    // A visible tab omits `hidden`; an explicit false must read the same way.
    stubSheets([
      { sheetId: 1, title: 'Photo Folders' },
      { sheetId: 4, title: 'Video Folders', hidden: false },
    ]);

    expect(await unhideSheetTabs('sheet1', ['Photo Folders', 'Video Folders'])).toEqual([]);
    expect(batchUpdates()).toHaveLength(0);
    expect(calls).toHaveLength(1); // the single read, nothing more
  });

  it('leaves a hidden tab it was not asked about alone', async () => {
    stubSheets([
      { sheetId: 4, title: 'Video Folders', hidden: true },
      { sheetId: 7, title: 'Scratch notes', hidden: true },
    ]);

    expect(await unhideSheetTabs('sheet1', ['Video Folders'])).toEqual(['Video Folders']);
    expect(batchUpdates()[0]!.body).toEqual({
      requests: [{ updateSheetProperties: { properties: { sheetId: 4, hidden: false }, fields: 'hidden' } }],
    });
  });

  it('ignores titles that do not exist yet (caller is about to create them)', async () => {
    stubSheets([{ sheetId: 1, title: 'Photo Folders' }]);

    expect(await unhideSheetTabs('sheet1', ['Photo Folders', 'Brand New Club'])).toEqual([]);
    expect(batchUpdates()).toHaveLength(0);
  });

  it('short-circuits on an empty title list without touching the API', async () => {
    stubSheets([{ sheetId: 1, title: 'Photo Folders', hidden: true }]);

    expect(await unhideSheetTabs('sheet1', [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws when the batchUpdate is rejected', async () => {
    stubSheets([{ sheetId: 4, title: 'Video Folders', hidden: true }], { batchStatus: 403 });

    await expect(unhideSheetTabs('sheet1', ['Video Folders'])).rejects.toThrow(/updateSheetProperties 403/);
  });
});
