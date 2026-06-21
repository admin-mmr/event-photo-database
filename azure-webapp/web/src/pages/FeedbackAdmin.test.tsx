import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
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
    expect(screen.getByText('1 confirmed')).toBeTruthy();
    expect(screen.getByText('1 wrong')).toBeTruthy();
    expect(screen.getByText('2 in view')).toBeTruthy();
    // Verdict labels rendered per row (scoped to the table — the filter
    // dropdown carries the same labels as options).
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Wrong match')).toBeTruthy();
    expect(table.getByText("That's me")).toBeTruthy();
    // Falls back to uid when email is null.
    expect(table.getByText('u2')).toBeTruthy();
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
