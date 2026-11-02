import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const upgradeGuestToGoogle = vi.fn();
vi.mock('../lib/firebase.js', () => ({
  upgradeGuestToGoogle: () => upgradeGuestToGoogle(),
  idToken: async () => 'fake-token',
}));

const { GuestSignInPrompt } = await import('./GuestSignInPrompt.js');
const { apiPost, ApiError, GUEST_BLOCKED_EVENT, isGuestBlock } = await import('../lib/api.js');

function block(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(GUEST_BLOCKED_EVENT));
  });
}

function stubFetchStatus(status: number, error: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: false, error, message: 'nope' }), { status })),
  );
}

beforeEach(() => {
  upgradeGuestToGoogle.mockReset();
  vi.unstubAllGlobals();
});

describe('isGuestBlock', () => {
  it('is true only for the two checks that Google sign-in lifts', () => {
    expect(isGuestBlock(403, 'recaptcha_failed')).toBe(true);
    expect(isGuestBlock(429, 'guest_rate_limited')).toBe(true);
    // The per-uid limit: signing in does not lift it, so no prompt.
    expect(isGuestBlock(429, 'rate_limited')).toBe(false);
    expect(isGuestBlock(403, 'forbidden')).toBe(false);
  });
});

describe('api error → prompt signal', () => {
  it('a 403 recaptcha_failed fires the event and still throws the ApiError', async () => {
    const seen = vi.fn();
    window.addEventListener(GUEST_BLOCKED_EVENT, seen);
    stubFetchStatus(403, 'recaptcha_failed');
    await expect(apiPost('/api/events/ev1/download', {})).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(GUEST_BLOCKED_EVENT, seen);
  });

  it('a per-uid 429 rate_limited does not', async () => {
    const seen = vi.fn();
    window.addEventListener(GUEST_BLOCKED_EVENT, seen);
    stubFetchStatus(429, 'rate_limited');
    await expect(apiPost('/api/events/ev1/download', {})).rejects.toBeInstanceOf(ApiError);
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener(GUEST_BLOCKED_EVENT, seen);
  });
});

describe('<GuestSignInPrompt />', () => {
  it('renders nothing until a guest is blocked', () => {
    render(<GuestSignInPrompt isGuest />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a blocked guest is offered Google sign-in; success asks them to try again', async () => {
    upgradeGuestToGoogle.mockResolvedValue('linked');
    render(<GuestSignInPrompt isGuest />);
    block();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    await waitFor(() => expect(screen.getByText(/You're signed in\. Please try again\./)).toBeTruthy());
    expect(upgradeGuestToGoogle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^OK$/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed or cancelled sign-in says so and lets them retry or dismiss', async () => {
    upgradeGuestToGoogle.mockRejectedValue(new Error('auth/popup-closed-by-user'));
    render(<GuestSignInPrompt isGuest />);
    block();
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    await waitFor(() => expect(screen.getByText(/Sign-in didn't finish/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Not now/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores the event for a signed-in (non-guest) user', () => {
    render(<GuestSignInPrompt isGuest={false} />);
    block();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
