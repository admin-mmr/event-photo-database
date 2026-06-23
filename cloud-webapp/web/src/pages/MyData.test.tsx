import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('../lib/firebase.js', () => ({
  idToken: async () => 'fake-token',
}));

const { MyData } = await import('./MyData.js');

const UPLOADS = {
  ok: true,
  uploads: [
    {
      uploadId: 'up-1',
      url: 'https://signed.example/ref?up-1',
      mode: 'fused',
      createdAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2099-09-10T00:00:00.000Z',
    },
    {
      uploadId: 'up-2',
      url: 'https://signed.example/ref?up-2',
      mode: 'person',
      createdAt: '2026-06-11T00:00:00.000Z',
      expiresAt: '2099-09-11T00:00:00.000Z',
    },
  ],
};

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  fetchImpl = async (url) => {
    if (String(url) === '/api/findme/uploads') {
      return new Response(JSON.stringify(UPLOADS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => fetchImpl(String(url), init)),
  );
});

describe('<MyData />', () => {
  it('lists saved selfies with mode + expiry', async () => {
    render(<MyData />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(screen.getByText('Face')).toBeTruthy();
    expect(screen.getByText('Outfit')).toBeTruthy();
    expect(screen.getAllByText(/expires in/i).length).toBeGreaterThan(0);
  });

  it('deletes a photo after confirmation and removes it from the list', async () => {
    const deleted: string[] = [];
    fetchImpl = async (url, init) => {
      if (String(url) === '/api/findme/uploads') {
        return new Response(JSON.stringify(UPLOADS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (init?.method === 'DELETE') {
        deleted.push(String(url));
        return new Response(JSON.stringify({ ok: true, uploadId: 'up-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    render(<MyData />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));

    // First card → Delete → confirm.
    const firstCard = screen.getAllByRole('listitem')[0]!;
    fireEvent.click(within(firstCard).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(firstCard).getByRole('button', { name: /Yes, delete/i }));

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1));
    expect(deleted).toContain('/api/findme/uploads/up-1');
    expect(screen.getByText(/Photo deleted\./)).toBeTruthy();
  });

  it('deletes all data via the danger zone (two-step confirm)', async () => {
    let purged = false;
    fetchImpl = async (url, init) => {
      if (String(url) === '/api/findme/uploads') {
        return new Response(JSON.stringify(UPLOADS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url) === '/api/findme/me/data' && init?.method === 'DELETE') {
        purged = true;
        return new Response(
          JSON.stringify({ ok: true, deleted: { references: 2, consents: 3, matchRuns: 1, feedback: 4 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    };

    render(<MyData />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Delete all my data' }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, delete everything/i }));

    await waitFor(() => expect(screen.getByText(/All your Find Me data was deleted/i)).toBeTruthy());
    expect(purged).toBe(true);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('shows an empty state when there are no saved photos', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true, uploads: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    render(<MyData />);
    await waitFor(() => expect(screen.getByText(/no saved photos/i)).toBeTruthy());
  });
});
