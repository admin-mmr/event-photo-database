import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({
  idToken: async () => 'fake-token',
}));

const { FeedbackAdmin } = await import('./FeedbackAdmin.js');

const SAMPLE = {
  ok: true,
  total: 2,
  counts: { not_me: 1, confirmed: 1 },
  items: [
    {
      feedbackId: 'f1',
      eventId: 'ev1',
      photoId: 'p1',
      verdict: 'not_me',
      runId: 'run-7',
      uid: 'u1',
      email: 'runner@mmrunners.org',
      createdAt: '2026-06-15T10:00:00.000Z',
      tier: 'expanded',
      thumbUrl: 't/ev1/p1',
      eventName: 'Spring 10K',
      rank: 14,
      score: 4.62,
    },
    {
      feedbackId: 'f2',
      eventId: 'ev2',
      photoId: 'p2',
      verdict: 'confirmed',
      runId: null,
      uid: 'u2',
      email: null,
      createdAt: '2026-06-15T11:00:00.000Z',
    },
  ],
};

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    if (/\/photos\/[^/]+\/web$/.test(String(input))) {
      return new Response(JSON.stringify({ ok: true, photoId: 'p1', webUrl: 'w/ev1/p1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function requestedUrls(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<FeedbackAdmin />', () => {
  it('renders the feedback queue with counts and rows', async () => {
    mockFetch(200, SAMPLE);
    render(
      <MemoryRouter>
        <FeedbackAdmin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('runner@mmrunners.org')).toBeTruthy());
    expect(screen.getByText(/1 confirmed/)).toBeTruthy();
    expect(screen.getByText(/1 wrong/)).toBeTruthy();
    expect(screen.getByText(/2 in view/)).toBeTruthy();
    // Verdict labels rendered per row (scoped to the table — the filter
    // dropdown carries the same labels as options).
    const table = within(screen.getByRole('table'));
    expect(table.getByText(/Wrong match/)).toBeTruthy();
    expect(table.getByText(/That's me/)).toBeTruthy();
    // Falls back to uid when email is null.
    expect(table.getByText('u2')).toBeTruthy();
  });

  it('shows each row ready to investigate: photo, event name, placement, search link', async () => {
    mockFetch(200, SAMPLE);
    render(
      <MemoryRouter>
        <FeedbackAdmin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Spring 10K')).toBeTruthy());
    const table = within(screen.getByRole('table'));
    expect(table.getByAltText('p1').getAttribute('src')).toBe('t/ev1/p1');
    expect(table.getByText('#14 · 4.62')).toBeTruthy();
    expect(table.getByText('see more')).toBeTruthy();
    // An event with no resolved name falls back to its id.
    expect(table.getByText('ev2')).toBeTruthy();
    // The run links into the verdict-batch view; a run-less vote says so.
    const link = table.getByRole('link', { name: /Open search/ });
    expect(link.getAttribute('href')).toBe('/admin/verdicts?run=run-7');
    expect(table.getByText('Not linked to a search')).toBeTruthy();
  });

  it('opens a row full-size in the lightbox, signing the web copy on demand', async () => {
    const fetchFn = mockFetch(200, SAMPLE);
    render(
      <MemoryRouter>
        <FeedbackAdmin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Spring 10K')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Open photo' })[0]!);
    await waitFor(() =>
      expect(screen.getAllByAltText('p1').some((el) => el.getAttribute('src') === 'w/ev1/p1')).toBe(true),
    );
    expect(requestedUrls(fetchFn)).toContain('/api/events/ev1/photos/p1/web');
  });

  it('narrows the queue to an event or a user from the row', async () => {
    const fetchFn = mockFetch(200, SAMPLE);
    render(
      <MemoryRouter>
        <FeedbackAdmin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Spring 10K')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'runner@mmrunners.org' }));
    await waitFor(() => expect(requestedUrls(fetchFn)).toContain('/api/admin/feedback?uid=u1'));
    expect(screen.getByText('User: runner@mmrunners.org')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Spring 10K' }));
    await waitFor(() =>
      expect(requestedUrls(fetchFn)).toContain('/api/admin/feedback?eventId=ev1&uid=u1'),
    );
    expect((screen.getByPlaceholderText('Filter by event ID') as HTMLInputElement).value).toBe('ev1');

    fireEvent.click(screen.getByRole('button', { name: 'Clear user filter' }));
    await waitFor(() => expect(screen.queryByText(/^User:/)).toBeNull());
  });

  it('shows an admin-only message on 403', async () => {
    mockFetch(403, { error: 'forbidden', message: 'admin only' });
    render(
      <MemoryRouter>
        <FeedbackAdmin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/admin-only/i)).toBeTruthy());
  });

  it('shows an empty state when there is no feedback', async () => {
    mockFetch(200, { ok: true, total: 0, counts: { not_me: 0, confirmed: 0 }, items: [] });
    render(
      <MemoryRouter>
        <FeedbackAdmin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/No feedback yet/i)).toBeTruthy());
  });
});
