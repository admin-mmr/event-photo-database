/**
 * <AdminEvents /> — the delete control. The page can remove an event's whole
 * gallery, so what matters here is that the first click only PREVIEWS, that the
 * apply is gated on typing the event's name, and that the button isn't offered to
 * anyone the API would 403 anyway.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({ idToken: async () => 'fake-token' }));

const { AdminEvents } = await import('./AdminEvents.js');

const EVENTS = {
  ok: true,
  events: [
    { id: 'ev1', name: 'Test', date: '2026-05-01' },
    { id: 'ev2', name: 'Real Race', date: '2026-06-01' },
  ],
};

const INVENTORY = {
  photos: 0,
  links: 5,
  activeLinks: 5,
  uploadBatches: 0,
  dedupClaims: 0,
  matchRuns: 0,
  matchFeedback: 0,
  specialFolderRows: 0,
  derivativeObjects: 0,
  derivativeObjectsCapped: false,
  stagedObjects: 3,
  driveFolderExists: true,
  sheetRowExists: true,
};

const PREVIEW = {
  ok: true,
  apply: false,
  eventId: 'ev1',
  eventName: 'Test',
  eventDate: '2026-05-01',
  folderName: '2026-05-01_Test',
  driveFolderId: 'folder-1',
  message: 'Dry run',
  inventory: INVENTORY,
  removed: { linksRevoked: 0, sheetRowsRemoved: 0, specialFolderRows: 0, firestoreDocs: 0, derivativeObjects: 0 },
  driveFolderTrashed: false,
  deleteId: '',
  derivativesRemaining: false,
  warnings: ['3 staged upload(s) are NOT deleted — they may be the only copy.'],
};

const APPLIED = {
  ...PREVIEW,
  apply: true,
  message: 'Deleted "Test"',
  driveFolderTrashed: true,
  deleteId: 'del-1',
  removed: { linksRevoked: 5, sheetRowsRemoved: 1, specialFolderRows: 0, firestoreDocs: 6, derivativeObjects: 0 },
  warnings: [],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockApi(opts?: { applied?: unknown }): ReturnType<typeof vi.fn> {
  const calls = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls(u, init?.method ?? 'GET', init?.body);
      if (u.includes('/delete-preview')) return json(PREVIEW);
      if (u.endsWith('/delete')) return json(opts?.applied ?? APPLIED);
      return json(EVENTS);
    }),
  );
  return calls;
}

const renderPage = (isSuperAdmin = true): void => {
  render(
    <MemoryRouter>
      <AdminEvents isSuperAdmin={isSuperAdmin} />
    </MemoryRouter>,
  );
};

const posts = (calls: ReturnType<typeof vi.fn>, needle: string): unknown[][] =>
  calls.mock.calls.filter(([u, method]) => method === 'POST' && String(u).includes(needle));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<AdminEvents /> delete', () => {
  it('offers no delete control to a non-super-admin', async () => {
    mockApi();
    renderPage(false);
    await screen.findByText('Real Race');
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('first click only previews — it posts nothing and shows the inventory', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('Real Race');

    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i })[0]!);

    await screen.findByRole('heading', { name: /delete "test"\?/i });
    expect(screen.getByText(/5 active upload link/i)).toBeTruthy();
    // The staged-uploads warning has to reach the admin before they confirm.
    expect(screen.getByText(/NOT deleted/i)).toBeTruthy();
    expect(posts(calls, '/delete')).toHaveLength(0);
  });

  it('keeps the confirm button disabled until the event name is typed', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('Real Race');
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i })[0]!);
    await screen.findByRole('heading', { name: /delete "test"\?/i });

    const confirmBtn = screen.getByRole('button', { name: /^delete event$/i }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/type "test" to confirm/i);
    fireEvent.change(input, { target: { value: 'Test1' } });
    expect((screen.getByRole('button', { name: /^delete event$/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'test' } }); // case-insensitive
    expect((screen.getByRole('button', { name: /^delete event$/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(posts(calls, '/delete')).toHaveLength(0);
  });

  it('applies with confirmName once armed, then reports the result', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('Real Race');
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i })[0]!);
    await screen.findByRole('heading', { name: /delete "test"\?/i });
    fireEvent.change(screen.getByPlaceholderText(/type "test" to confirm/i), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /^delete event$/i }));

    await waitFor(() => expect(posts(calls, '/api/admin/events/ev1/delete')).toHaveLength(1));
    const body = JSON.parse(String(posts(calls, '/delete')[0]?.[2] ?? '{}'));
    expect(body).toMatchObject({ apply: true, confirmName: 'Test' });
    await screen.findByText(/Deleted "Test"/);
    // Panel closes on a finished delete.
    expect(screen.queryByRole('heading', { name: /delete "test"\?/i })).toBeNull();
  });

  it('keeps the panel open and says to run again when the sweep is unfinished', async () => {
    const calls = mockApi({ applied: { ...APPLIED, derivativesRemaining: true, message: 'Partly done' } });
    renderPage();
    await screen.findByText('Real Race');
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i })[0]!);
    await screen.findByRole('heading', { name: /delete "test"\?/i });
    fireEvent.change(screen.getByPlaceholderText(/type "test" to confirm/i), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /^delete event$/i }));

    await screen.findByText(/run the delete again/i);
    expect(screen.getByRole('heading', { name: /delete "test"\?/i })).toBeTruthy();
    expect(posts(calls, '/delete')).toHaveLength(1);
  });
});
