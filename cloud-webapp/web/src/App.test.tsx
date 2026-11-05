import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { User } from 'firebase/auth';

// Mock the firebase module so tests never load the real SDK / network.
const authState: { user: User | null } = { user: null };
/** The App's auth listener, so a test can switch accounts mid-session. */
let emitAuth: (u: User | null) => void = () => undefined;

const signInWithGoogle = vi.fn();
vi.mock('./lib/firebase.js', () => ({
  watchAuth: (cb: (u: User | null) => void) => {
    emitAuth = cb;
    cb(authState.user);
    return () => undefined;
  },
  idToken: async () => (authState.user ? 'fake-token' : null),
  signInWithGoogle: () => signInWithGoogle(),
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

describe('<App /> Google sign-in', () => {
  // Closing the popup used to be an unhandled rejection that tripped the ERROR
  // alert (3 on 2026-11-02); a real failure told the user nothing.
  it('says nothing when the user closes the popup', async () => {
    authState.user = null;
    signInWithGoogle.mockReset();
    signInWithGoogle.mockRejectedValue(Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Sign in with Google/i })).toHaveProperty('disabled', false));
    expect(screen.queryByText(/did not finish/i)).toBeNull();
  });

  it('tells the user when sign-in really fails', async () => {
    authState.user = null;
    signInWithGoogle.mockReset();
    signInWithGoogle.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    expect(await screen.findByText(/Google sign-in did not finish/i)).toBeTruthy();
  });

  // A WeChat guest tapped the header button 5 times on 2026-11-03: every try
  // was auth/popup-blocked, and the error told them to "allow pop-ups".
  // …and whatever page a WeChat link lands on, the same "open in Safari"
  // steps are at the top of it — never only on the sign-in screen.
  describe.each([
    ['signed out, on a sub-page', null, '/events/ev1/findme'],
    ['a guest, in the gallery', { isAnonymous: true }, '/events/ev1'],
    ['a guest, bounced off an admin link', { isAnonymous: true }, '/admin/uploads'],
    ['a signed-in member', { email: 'member@mmrunners.org' }, '/'],
  ])('in WeChat — %s', (_label, user, path) => {
    it('shows the open-in-Safari steps and no Google button', async () => {
      authState.user = user as User | null;
      window.history.pushState({}, '', path);
      const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.79',
      );
      try {
        render(<App />);
        expect(await screen.findAllByRole('alert')).toHaveLength(1);
        expect(screen.getByText(/Open in Safari/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Sign in with Google/i })).toBeNull();
      } finally {
        ua.mockRestore();
        window.history.pushState({}, '', '/');
      }
    });
  });

  it('shows no in-app warning in a normal browser', async () => {
    authState.user = { isAnonymous: true } as User;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Spring Run 2026/)).toBeTruthy());
    expect(screen.queryByText(/Open in Safari/)).toBeNull();
  });

  it('keeps the header Google button for a guest in a normal browser', async () => {
    authState.user = { isAnonymous: true } as User;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Spring Run 2026/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Sign in with Google/i })).toBeTruthy();
  });

  it('ignores a second click while the popup is open', async () => {
    authState.user = null;
    signInWithGoogle.mockReset();
    signInWithGoogle.mockReturnValue(new Promise(() => undefined));
    render(<App />);
    const button = screen.getByRole('button', { name: /Sign in with Google/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
  });
});

describe('<App />', () => {
  it('shows the sign-in screen when signed out: a required name + Continue, plus Google', () => {
    authState.user = null;
    render(<App />);
    expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    // Guests now enter their name here (remembered for the session) and Continue.
    expect(screen.getByLabelText(/your name/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Continue$/ })).toBeTruthy();
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

  // ── Role-aware navigation (driven by GET /api/me) ─────────────────────────

  function stubFetchWithRole(role: 'owner' | 'super_admin' | 'club_admin' | null): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u === '/api/me') {
          return new Response(
            JSON.stringify({ ok: true, email: 'u@x.org', emailVerified: true, role, clubId: '' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u === '/api/events') {
          return new Response(JSON.stringify({ ok: true, events: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
  }

  it('shows every admin menu item to a super_admin', async () => {
    authState.user = { email: 'boss@x.org' } as User;
    stubFetchWithRole('super_admin');
    render(<App />);
    // Super-only items resolve once /api/me returns.
    expect(await screen.findByRole('link', { name: 'Audit' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Metrics' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Match feedback' })).toBeTruthy();
    // …plus the any-admin items and the everyone items.
    expect(screen.getByRole('link', { name: 'Users' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Galleries$/ })).toBeTruthy();
  });

  it('shows the owner every super_admin menu item too', async () => {
    authState.user = { email: 'admin@mmrunners.org' } as User;
    stubFetchWithRole('owner');
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Audit' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Users' })).toBeTruthy();
  });

  it('shows club-scoped items to a club_admin but hides super-only ones', async () => {
    authState.user = { email: 'ca@x.org' } as User;
    stubFetchWithRole('club_admin');
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Users' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Report' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Email settings' })).toBeTruthy();
    // No super-only items.
    expect(screen.queryByRole('link', { name: 'Audit' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Metrics' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Match feedback' })).toBeNull();
  });

  it('shows only Galleries + My data to a signed-in member with no role', async () => {
    authState.user = { email: 'm@x.org' } as User;
    stubFetchWithRole(null);
    render(<App />);
    expect(await screen.findByRole('link', { name: /^Galleries$/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'My data' })).toBeTruthy();
    // No admin items at all.
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Events' })).toBeNull();
  });
});

// 2026-11-03: a tab switched accounts with Find-Me results on screen; the new
// account voted on the old one's search and its saved selfies 404'd.
describe('<App /> Safari storage loss', () => {
  it('a sign-in that fails because Safari lost its database says "reload", and is not reported', async () => {
    authState.user = null;
    signInWithGoogle.mockReset();
    signInWithGoogle.mockRejectedValue(
      new Error('Connection to Indexed Database server lost. Refresh the page to try again'),
    );
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/Reload the page/));
    expect(screen.getByRole('button', { name: /^Reload$/ })).toBeTruthy();
    expect(screen.queryByText(/Allow pop-ups/)).toBeNull();
  });
});

describe('<App /> account switch', () => {
  function eventsFetches(): number {
    return vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === '/api/events').length;
  }

  it('remounts the page for a different account, not for the same one', async () => {
    authState.user = { uid: 'guest-1', isAnonymous: true } as User;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Spring Run 2026/)).toBeTruthy());
    const before = eventsFetches();

    // Same uid (a guest linked to Google keeps it): the page stays put.
    act(() => emitAuth({ uid: 'guest-1', isAnonymous: false, email: 'a@x.org' } as User));
    expect(eventsFetches()).toBe(before);

    // A different uid: the page starts over, holding nothing of the last account.
    act(() => emitAuth({ uid: 'google-2', isAnonymous: false, email: 'b@x.org' } as User));
    await waitFor(() => expect(eventsFetches()).toBe(before + 1));
  });

  it('forgets cached Find-Me matches on sign-out', async () => {
    authState.user = { uid: 'guest-1', isAnonymous: true } as User;
    sessionStorage.setItem('findme:results:guest-1:ev1', '{}');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Exit guest/i }));
    expect(sessionStorage.getItem('findme:results:guest-1:ev1')).toBeNull();
  });
});
