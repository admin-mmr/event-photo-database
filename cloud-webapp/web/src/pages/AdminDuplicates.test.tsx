/**
 * <AdminDuplicates /> — the page trashes real Drive files, so what matters here
 * is that scanning alone never posts anything and that the removal is gated on
 * the confirm dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({
  idToken: async () => 'fake-token',
}));

const { AdminDuplicates } = await import('./AdminDuplicates.js');

const EVENTS = { ok: true, events: [{ id: 'ev1', name: 'Spring Meet', date: '2026-06-01' }] };

const dup = (id: string, relPath: string, sizeBytes = 1024 * 1024) => ({
  driveFileId: id,
  name: relPath.split('/').pop(),
  relPath,
  mimeType: 'image/jpeg',
  clubName: 'Blue',
  batchFolderName: 'b',
  sizeBytes,
});

const SCAN = {
  ok: true,
  eventId: 'ev1',
  eventName: 'Spring Meet',
  filesScanned: 3,
  unhashedFiles: 0,
  duplicateFiles: 1,
  reclaimableBytes: 1024 * 1024,
  groups: [
    {
      contentHash: 'abc',
      canonical: dup('keep', 'Blue/t/b/1.jpg'),
      duplicates: [dup('dup1', 'Blue/t/b/2.jpg')],
    },
  ],
};

const EMPTY_SCAN = { ...SCAN, duplicateFiles: 0, reclaimableBytes: 0, groups: [] };

const REMOVED = {
  ok: true,
  eventId: 'ev1',
  apply: true,
  message: 'ok',
  candidates: 1,
  removed: 1,
  failed: 0,
  remaining: 0,
  bytesReclaimed: 1024 * 1024,
  planned: [],
  warnings: [],
  reindexRecommended: true,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * Route each request by URL so the page's real call sequence works. `scans` is
 * consumed in order, so the re-scan after a removal can differ from the first.
 */
function mockApi(opts: { scans: unknown[]; remove?: unknown }): ReturnType<typeof vi.fn> {
  const calls = vi.fn();
  const scans = [...opts.scans];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls(u, init?.method ?? 'GET');
      if (u.endsWith('/remove')) return json(opts.remove);
      if (u.includes('/api/admin/duplicates/')) return json(scans.length > 1 ? scans.shift() : scans[0]);
      return json(EVENTS);
    }),
  );
  return calls;
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AdminDuplicates />
    </MemoryRouter>,
  );
}

/** Pick the event and run a scan. */
async function scanEvent(): Promise<void> {
  const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
  // Wait for the events list to land before selecting (options of a collapsed
  // <select> aren't exposed to byRole, so assert on the element itself).
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 'ev1' } });
  fireEvent.click(screen.getByRole('button', { name: /scan drive/i }));
}

const posted = (calls: ReturnType<typeof vi.fn>): boolean =>
  calls.mock.calls.some(([, method]) => method === 'POST');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<AdminDuplicates />', () => {
  it('scans without removing anything, and shows which copy survives', async () => {
    const calls = mockApi({ scans: [SCAN] });
    renderPage();
    await scanEvent();

    await waitFor(() => expect(screen.getByText(/1 duplicate file across 1 group/i)).toBeTruthy());
    expect(screen.getByText('Blue/t/b/1.jpg')).toBeTruthy();
    expect(screen.getByText('Blue/t/b/2.jpg')).toBeTruthy();
    // A scan is a GET only — nothing was posted.
    expect(posted(calls)).toBe(false);
  });

  it('does not remove anything when the confirm dialog is dismissed', async () => {
    const calls = mockApi({ scans: [SCAN], remove: REMOVED });
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderPage();
    await scanEvent();

    const button = await screen.findByRole('button', { name: /move duplicates to trash/i });
    fireEvent.click(button);

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(posted(calls)).toBe(false);
  });

  it('posts apply:true once confirmed, then reports the result', async () => {
    // First scan finds the duplicate; the re-scan after removal finds none.
    const calls = mockApi({ scans: [SCAN, EMPTY_SCAN], remove: REMOVED });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPage();
    await scanEvent();

    fireEvent.click(await screen.findByRole('button', { name: /move duplicates to trash/i }));

    await waitFor(() => expect(screen.getByText(/moved 1 duplicate file to trash/i)).toBeTruthy());
    const post = calls.mock.calls.find(([, method]) => method === 'POST');
    expect(post?.[0]).toBe('/api/admin/duplicates/ev1/remove');
    // Re-index reminder, since the index still lists the removed copy.
    expect(screen.getByText(/re-indexed/i)).toBeTruthy();
    // The follow-up scan replaced the table with the "nothing left" state.
    await waitFor(() => expect(screen.getByText(/no byte-identical duplicates/i)).toBeTruthy());
  });

  it('says so plainly when there are no duplicates', async () => {
    mockApi({ scans: [EMPTY_SCAN] });
    renderPage();
    await scanEvent();

    await waitFor(() => expect(screen.getByText(/no byte-identical duplicates/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /move duplicates to trash/i })).toBeNull();
  });
});
