/**
 * <AdminUploadInsights /> — read-only, so what matters is that picking an event
 * loads its pivot, that regrouping re-adds the numbers, that rows sort, collapse
 * and open onto their sessions, that the column picker and detail panel work,
 * and that a club_admin's 403 reads as such.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({
  idToken: async () => 'fake-token',
}));

const { AdminUploadInsights } = await import('./AdminUploadInsights.js');

const EVENTS = { ok: true, events: [{ id: 'ev1', name: 'NYC Marathon', date: '2026-11-01' }] };

const base = {
  sessions: 1,
  copied: 10,
  skippedDuplicates: 0,
  failed: 0,
  staged: 0,
  untracked: 0,
  copiedBytes: 10 * 1024 * 1024,
  stagedBytes: 0,
  minutes: 12,
  indexed: 10,
  indexRatio: 1,
  mbPerSec: 0.5,
  filesPerMin: 1,
  inProgress: 0,
  stuck: 0,
  errors: 0,
  neverCompleted: 0,
  recovered: 0,
  firstSessionAt: '2026-11-01T14:00:00.000Z',
  lastSessionAt: '2026-11-01T14:00:00.000Z',
  lastActivityAt: '2026-11-01T14:12:00.000Z',
};

const session = (batchId: string, status: string, over: Record<string, unknown> = {}) => ({
  batchId,
  status,
  batchFolders: ['20261101-140000_jane'],
  files: 10,
  copied: 10,
  skippedDuplicates: 0,
  failed: 0,
  staged: 0,
  untracked: 0,
  copiedBytes: 10 * 1024 * 1024,
  stagedBytes: 0,
  indexed: 10,
  startedAt: '2026-11-01T14:00:00.000Z',
  lastActivityAt: '2026-11-01T14:12:00.000Z',
  minutes: 12,
  recovered: false,
  ...over,
});

const INSIGHTS = {
  ok: true,
  eventId: 'ev1',
  generatedAt: '2026-11-02T12:00:00.000Z',
  indexCountsAt: '2026-11-02T11:00:00.000Z',
  stagingListed: true,
  truncated: false,
  warnings: [],
  totals: { ...base, clubName: '', tag: '', uploader: '', sessions: 2, files: 210 },
  groups: [
    { ...base, clubName: 'MMR', tag: 'NYC', uploader: 'jane', files: 10, sessionList: [session('aaaaaaaa-1', 'ok')] },
    {
      ...base,
      clubName: 'Harriers',
      tag: 'ALL',
      uploader: 'bob',
      files: 200,
      stuck: 1,
      indexRatio: 0.25,
      sessionList: [
        session('bbbbbbbb-2', 'stuck', { copied: 4, staged: 6, stagedBytes: 6 * 1024 * 1024 }),
        // A retried session: the parts must add up to Files on screen.
        session('cccccccc-3', 'ok', { files: 5133, copied: 3755, skippedDuplicates: 142, untracked: 1236 }),
      ],
    },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockApi(insights: () => Response): ReturnType<typeof vi.fn> {
  const calls = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      calls(u);
      if (u.includes('/api/admin/upload-insights/')) return insights();
      return json(EVENTS);
    }),
  );
  return calls;
}

async function pickEvent(): Promise<void> {
  render(
    <MemoryRouter>
      <AdminUploadInsights />
    </MemoryRouter>,
  );
  const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 'ev1' } });
}

/** Top-level labels in table order (the frozen label cells of depth-0 rows). */
const firstColumn = (): string[] =>
  Array.from(document.querySelectorAll('tbody tr'))
    .map((tr) => tr.querySelector('td')?.textContent?.replace(/^[▸▾]\s*/, '') ?? '')
    .filter(Boolean);

const rowFor = (name: RegExp): HTMLElement => screen.getByRole('row', { name });

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('<AdminUploadInsights />', () => {
  it('loads the picked event as club › tag › uploader rows, rolled up from the sessions', async () => {
    const calls = mockApi(() => json(INSIGHTS));
    await pickEvent();
    await screen.findByRole('button', { name: /show sessions for jane/i });
    expect(calls.mock.calls.some(([u]) => String(u).endsWith('/api/admin/upload-insights/ev1'))).toBe(true);
    expect(screen.getByRole('button', { name: /collapse harriers/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /show sessions for bob/i })).toBeTruthy();
    // The total adds the sessions (10 + 10 + 5133), not the server's own totals row.
    const total = rowFor(/details for whole event/i);
    expect(within(total).getByText('Total')).toBeTruthy();
    expect(within(total).getByText('5,153')).toBeTruthy();
    expect(within(rowFor(/details for harriers/i)).getByText('1 stuck')).toBeTruthy();
  });

  it('pins the grouping columns, each at its own left edge', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    const toggle = await screen.findByRole('button', { name: /show sessions for jane/i });
    const cells = Array.from((toggle.closest('tr') as HTMLElement).children) as HTMLElement[];
    expect(cells.slice(0, 3).every((c) => c.classList.contains('pivot-dim'))).toBe(true);
    expect(cells[3]?.classList.contains('pivot-dim')).toBe(false);
    expect(cells.slice(0, 3).map((c) => c.style.getPropertyValue('--pivot-left'))).toEqual(['0px', '170px', '300px']);
  });

  it('regroups and re-adds when a grouping is removed, and remembers it', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    await screen.findByRole('button', { name: /show sessions for jane/i });
    fireEvent.click(screen.getByRole('button', { name: /stop grouping by club/i }));
    fireEvent.click(screen.getByRole('button', { name: /stop grouping by tag/i }));
    expect(screen.queryByRole('button', { name: /collapse harriers/i })).toBeNull();
    // bob's two sessions are one row now: 10 + 5133 files.
    expect(within(rowFor(/details for bob/i)).getByText('5,143')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('admin.uploadInsights.layout') ?? '{}').dims).toEqual(['uploader']);
    // Added back, Club comes last: uploader › club.
    fireEvent.click(screen.getByRole('button', { name: /^group by club$/i }));
    expect(screen.getByRole('button', { name: /collapse bob/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /show sessions for harriers/i })).toBeTruthy();
  });

  it('collapses a group and re-sorts within each level', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    fireEvent.click(await screen.findByRole('button', { name: /collapse harriers/i }));
    expect(screen.queryByRole('button', { name: /show sessions for bob/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByRole('button', { name: /show sessions for bob/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.click(screen.getByRole('button', { name: /^files( [▲▼])?$/i }));
    expect(firstColumn().slice(0, 2)).toEqual(['Harriers', 'MMR']);
    fireEvent.click(screen.getByRole('button', { name: /^files( [▲▼])?$/i }));
    expect(firstColumn().slice(0, 2)).toEqual(['MMR', 'Harriers']);
  });

  it('opens a row onto its sessions, with the same columns', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    fireEvent.click(await screen.findByRole('button', { name: /show sessions for bob/i }));
    const stuck = rowFor(/bbbbbbbb/i);
    expect(within(stuck).getByText('stuck')).toBeTruthy();
    const retried = rowFor(/cccccccc/i);
    expect(within(retried).getByText('1,236')).toBeTruthy();
    expect(within(retried).getByText('5,133')).toBeTruthy();
  });

  it('opens a detail panel whose parts add up to Files', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    await screen.findByRole('button', { name: /show sessions for bob/i });
    fireEvent.click(rowFor(/details for bob/i));
    const panel = screen.getByRole('complementary');
    expect(within(panel).getByRole('heading', { name: 'bob' })).toBeTruthy();
    expect(
      within(panel).getByText('5,143 files = 3,759 copied + 1,236 not counted + 142 duplicates + 6 in staging'),
    ).toBeTruthy();
    // A session from the panel's list opens in the panel, with a way back.
    fireEvent.click(within(panel).getAllByRole('button', { name: /stuck/i })[0] as HTMLElement);
    expect(within(panel).getByText('bbbbbbbb-2')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /back to bob/i }));
    expect(within(panel).getByRole('heading', { name: 'bob' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('shows leftovers already in the gallery apart from files still waiting', async () => {
    mockApi(() =>
      json({
        ...INSIGHTS,
        groups: [
          {
            ...base,
            clubName: 'Misty',
            tag: 'mile14',
            uploader: 'dannyzeng',
            files: 407,
            sessionList: [
              session('dddddddd-4', 'ok', {
                files: 407,
                staged: 407,
                stagedBytes: 2900 * 1024 * 1024,
                stagedInGallery: 407,
                stagedInGalleryBytes: 2900 * 1024 * 1024,
              }),
            ],
          },
        ],
      }),
    );
    await pickEvent();
    const row = await screen.findByRole('row', { name: /details for dannyzeng/i });
    expect(within(row).getByText('+407 in gallery')).toBeTruthy();
    // Nothing waiting, so nothing in the warning colour.
    expect(row.querySelector('.insights-warn')).toBeNull();
  });

  it('hides a column from the picker and remembers it', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    await screen.findByRole('button', { name: /show sessions for jane/i });
    expect(screen.getByRole('button', { name: /^duplicates( [▲▼])?$/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /columns · 12 of 17/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /duplicates/i }));
    expect(screen.queryByRole('button', { name: /^duplicates( [▲▼])?$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /columns · 11 of 17/i })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('admin.uploadInsights.layout') ?? '{}').columns).not.toContain('skippedDuplicates');
  });

  it('says when index counts have not been written yet', async () => {
    mockApi(() => json({ ...INSIGHTS, indexCountsAt: null }));
    await pickEvent();
    expect(await screen.findByText(/after the event is next indexed/i)).toBeTruthy();
  });

  it('shows the admin-only notice on a 403', async () => {
    mockApi(() => json({ ok: false, error: 'forbidden' }, 403));
    await pickEvent();
    expect(await screen.findByText(/admin-only/i)).toBeTruthy();
  });
});
