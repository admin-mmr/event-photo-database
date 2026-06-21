import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { User } from 'firebase/auth';

// Mock the firebase module so tests never load the real SDK / network.
const authState: { user: User | null } = { user: null };

vi.mock('./lib/firebase.js', () => ({
  watchAuth: (cb: (u: User | null) => void) => {
    cb(authState.user);
    return () => undefined;
  },
  idToken: async () => (authState.user ? 'fake-token' : null),
  signInWithGoogle: vi.fn(),
  continueAsGuest: vi.fn(),
  signOutUser: vi.fn(),
}));

const { App } = await import('./App.js');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/events') {
        return new Response(
          JSON.stringify({
            ok: true,
            events: [{ id: 'ev1', name: 'Spring Run 2026', indexState: { status: 'done', photoCount: 42 } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

describe('<App />', () => {
  it('shows the sign-in screen when signed out, with a guest option', () => {
    authState.user = null;
    render(<App />);
    expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue as guest/i })).toBeTruthy();
  });

  it('lets a guest browse events but hides admin controls', async () => {
    authState.user = { isAnonymous: true } as User;
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Spring Run 2026/)).toBeTruthy();
    });
    // Guests see the catalog…
    expect(screen.getByText(/Find Me ready/)).toBeTruthy();
    // …but not the admin-only Index / Sync controls.
    expect(screen.queryByRole('button', { name: /Index now|Indexing/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sync with Drive/i })).toBeNull();
  });

  it('redirects a guest away from the admin feedback route', async () => {
    authState.user = { isAnonymous: true } as User;
    window.history.pushState({}, '', '/admin/feedback');
    render(<App />);
    // Bounced to "/" → the Events catalog renders instead of the admin page.
    await waitFor(() => {
      expect(screen.getByText(/Spring Run 2026/)).toBeTruthy();
    });
    window.history.pushState({}, '', '/');
  });

  it('lists events when signed in', async () => {
    authState.user = { email: 'member@mmrunners.org' } as User;
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Spring Run 2026/)).toBeTruthy();
    });
    expect(screen.getByText(/Find Me ready/)).toBeTruthy();
    expect(screen.getByText(/42 photos/)).toBeTruthy();
    // The per-event "Index now" control is present.
    expect(screen.getByRole('button', { name: /Index now|Indexing/i })).toBeTruthy();
    // …as is the admin "Sync with Drive" trigger.
    expect(screen.getByRole('button', { name: /Sync with Drive/i })).toBeTruthy();
  });
});
