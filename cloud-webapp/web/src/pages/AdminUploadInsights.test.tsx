/**
 * <AdminUploadInsights /> — read-only, so what matters is that picking an event
 * loads that event's roll-up, that the rows can be re-sorted, that a row opens
 * onto the sessions behind it, and that a club_admin's 403 reads as such.
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
        session('bbbbbbbb-2', 'stuck'),
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

/** Uploader names in table order (their expand buttons). */
const uploaderOrder = (): string[] =>
  screen.getAllByRole('button', { name: /show sessions for/i }).map((b) => b.textContent?.replace(/^[▸▾]\s*/, '') ?? '');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<AdminUploadInsights />', () => {
  it('loads the picked event and lists one row per uploader with totals', async () => {
    const calls = mockApi(() => json(INSIGHTS));
    await pickEvent();
    await screen.findByRole('button', { name: /show sessions for jane/i });
    expect(calls.mock.calls.some(([u]) => String(u).endsWith('/api/admin/upload-insights/ev1'))).toBe(true);
    expect(screen.getByRole('button', { name: /show sessions for bob/i })).toBeTruthy();
    expect(screen.getByText('1 stuck')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('210')).toBeTruthy();
  });

  it('re-sorts when a column header is clicked', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    await screen.findByRole('button', { name: /show sessions for jane/i });
    fireEvent.click(screen.getByRole('button', { name: /^files( [▲▼])?$/i }));
    expect(uploaderOrder()).toEqual(['bob', 'jane']);
    fireEvent.click(screen.getByRole('button', { name: /^files( [▲▼])?$/i }));
    expect(uploaderOrder()).toEqual(['jane', 'bob']);
  });

  it('opens a row onto its sessions', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    const toggle = await screen.findByRole('button', { name: /show sessions for bob/i });
    expect(screen.queryByTitle('bbbbbbbb-2')).toBeNull();
    fireEvent.click(toggle);
    const cell = screen.getByTitle('bbbbbbbb-2');
    const sessionRow = cell.closest('tr') as HTMLElement;
    expect(within(sessionRow).getByText('stuck')).toBeTruthy();
    expect(within(sessionRow).getByText('20261101-140000_jane')).toBeTruthy();
    const retried = screen.getByTitle('cccccccc-3').closest('tr') as HTMLElement;
    expect(within(retried).getByText('1236')).toBeTruthy();
    expect(screen.getByText(/Files = copied \+ not counted \+ duplicates \+ in staging/)).toBeTruthy();
  });

  it('pins club, tag and uploader as the sticky first three columns', async () => {
    mockApi(() => json(INSIGHTS));
    await pickEvent();
    const toggle = await screen.findByRole('button', { name: /show sessions for jane/i });
    const cells = Array.from((toggle.closest('tr') as HTMLElement).children);
    expect(cells.slice(0, 3).map((c) => c.className)).toEqual(['mono sticky-c1', 'sticky-c2', 'sticky-c3']);
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
