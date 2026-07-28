/**
 * <AdminDuplicates /> — the page trashes real Drive files, so what matters here
 * is that scanning alone never posts anything, that the removal is gated on the
 * confirm dialog, and that one press drives the queued batch to completion.
 *
 * Removal is ASYNC by design: the apply POST returns 202 + a batchId, then the
 * page drives drain ticks and polls progress. Inline removal used to die at the
 * 60s request ceiling (HTTP 502) on every press while files were being trashed
 * unseen, so "one press finishes the event" is the behaviour under test.
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

/** The 202 the apply POST answers with. */
const QUEUED = { ok: true, mode: 'async', batchId: 'b1', total: 1, notEnqueued: 0, message: 'queued' };

const batch = (over: Record<string, unknown> = {}) => ({
  ok: true,
  batch: {
    id: 'b1',
    eventId: 'ev1',
    status: 'done',
    total: 1,
    removed: 1,
    failed: 0,
    remaining: 0,
    sweepPending: 0,
    bytesReclaimed: 1024 * 1024,
    notEnqueued: 0,
    warnings: [],
    ...over,
  },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Route each request by URL so the page's real call sequence works. `scans` and
 * `statuses` are consumed in order (the last entry repeats), so the re-scan after
 * a removal can differ from the first and the batch can report progress across
 * several drain ticks.
 */
function mockApi(opts: {
  scans: unknown[];
  queued?: unknown;
  queuedStatus?: number;
  statuses?: unknown[];
}): ReturnType<typeof vi.fn> {
  const calls = vi.fn();
  const scans = [...opts.scans];
  const statuses = opts.statuses ? [...opts.statuses] : [batch()];
  const next = (queue: unknown[]): unknown => (queue.length > 1 ? queue.shift() : queue[0]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls(u, init?.method ?? 'GET');
      // Specific routes first — the scan matcher below is a catch-all.
      if (u.endsWith('/remove')) return json(opts.queued ?? QUEUED, opts.queuedStatus ?? 202);
      if (u.endsWith('/duplicates/drain')) return json({ ok: true, drained: true });
      if (u.includes('/duplicates/batch/status')) return json(next(statuses));
      if (u.includes('/api/admin/duplicates/')) return json(next(scans));
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

const postsTo = (calls: ReturnType<typeof vi.fn>, needle: string): unknown[] =>
  calls.mock.calls.filter(([u, method]) => method === 'POST' && String(u).includes(needle));

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
    const calls = mockApi({ scans: [SCAN] });
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderPage();
    await scanEvent();

    const button = await screen.findByRole('button', { name: /move duplicates to trash/i });
    fireEvent.click(button);

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(posted(calls)).toBe(false);
  });

  it('queues on confirm, drives the drain, then reports the result', async () => {
    // First scan finds the duplicate; the re-scan after removal finds none.
    const calls = mockApi({ scans: [SCAN, EMPTY_SCAN] });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPage();
    await scanEvent();

    fireEvent.click(await screen.findByRole('button', { name: /move duplicates to trash/i }));

    await waitFor(() => expect(screen.getByText(/moved 1 duplicate file to trash/i)).toBeTruthy());
    // Enqueue, then at least one drain tick — never an inline removal.
    expect(postsTo(calls, '/duplicates/ev1/remove')).toHaveLength(1);
    expect(postsTo(calls, '/duplicates/drain').length).toBeGreaterThanOrEqual(1);
    // Re-index reminder, since the index still lists the removed copy.
    expect(screen.getByText(/re-indexed/i)).toBeTruthy();
    // The follow-up scan replaced the table with the "nothing left" state.
    await waitFor(() => expect(screen.getByText(/no byte-identical duplicates/i)).toBeTruthy());
  });

  // A tick removes a bounded slice, so a big event needs many ticks. One press
  // has to drain it, or an admin faces a dozen identical presses.
  it('keeps ticking while the batch is still running', async () => {
    const calls = mockApi({
      scans: [SCAN, EMPTY_SCAN],
      queued: { ...QUEUED, total: 250 },
      statuses: [
        batch({ status: 'running', total: 250, removed: 150, remaining: 100, bytesReclaimed: 150 * 1024 * 1024 }),
        batch({ status: 'done', total: 250, removed: 250, remaining: 0, bytesReclaimed: 250 * 1024 * 1024 }),
      ],
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPage();
    await scanEvent();

    fireEvent.click(await screen.findByRole('button', { name: /move duplicates to trash/i }));

    // Mid-run the page shows progress, not a finished summary.
    await waitFor(() => expect(screen.getByText(/150 of 250 done/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/moved 250 duplicate files to trash/i)).toBeTruthy(), {
      timeout: 5000,
    });
    expect(screen.getByText(/250\.0 MB reclaimed/i)).toBeTruthy();
    expect(postsTo(calls, '/duplicates/drain').length).toBeGreaterThanOrEqual(2);
    // Nothing left over, so no "run it again" nag.
    expect(screen.queryByText(/still to go/i)).toBeNull();
  });

  it('surfaces files that could not be trashed', async () => {
    mockApi({
      scans: [SCAN, SCAN],
      queued: { ...QUEUED, total: 5 },
      statuses: [batch({ status: 'done', total: 5, removed: 0, failed: 5, bytesReclaimed: 0 })],
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPage();
    await scanEvent();

    fireEvent.click(await screen.findByRole('button', { name: /move duplicates to trash/i }));

    await waitFor(() => expect(screen.getByText(/5 files could not be trashed/i)).toBeTruthy());
  });

  it('nags to run again when the scan found more than one batch holds', async () => {
    mockApi({
      scans: [SCAN, SCAN],
      queued: { ...QUEUED, total: 1500, notEnqueued: 100 },
      statuses: [batch({ status: 'done', total: 1500, removed: 1500, notEnqueued: 100 })],
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPage();
    await scanEvent();

    fireEvent.click(await screen.findByRole('button', { name: /move duplicates to trash/i }));

    await waitFor(() => expect(screen.getByText(/100 still to go/i)).toBeTruthy());
  });

  it('does not claim a removal when the server had nothing to queue', async () => {
    const calls = mockApi({
      scans: [SCAN, EMPTY_SCAN],
      queued: { ok: true, mode: 'none', batchId: null, total: 0, notEnqueued: 0, message: 'nothing to do' },
      queuedStatus: 200,
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPage();
    await scanEvent();

    fireEvent.click(await screen.findByRole('button', { name: /move duplicates to trash/i }));

    await waitFor(() => expect(screen.getByText(/no byte-identical duplicates/i)).toBeTruthy());
    expect(screen.queryByText(/moved \d+ duplicate/i)).toBeNull();
    // No batch to drive, so no drain ticks were fired.
    expect(postsTo(calls, '/duplicates/drain')).toHaveLength(0);
  });

  it('says so plainly when there are no duplicates', async () => {
    mockApi({ scans: [EMPTY_SCAN] });
    renderPage();
    await scanEvent();

    await waitFor(() => expect(screen.getByText(/no byte-identical duplicates/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /move duplicates to trash/i })).toBeNull();
  });
});
