import { describe, it, expect } from 'vitest';

import { hasVerifiedSignIn } from '../src/lib/signIn.js';

function req(user?: { signInProvider?: string; linkedProviders?: string[] }) {
  return { user: user ? { uid: 'u1', email: undefined, emailVerified: false, ...user } : undefined } as never;
}

describe('hasVerifiedSignIn', () => {
  it('Google sign-in is verified', () => {
    expect(hasVerifiedSignIn(req({ signInProvider: 'google.com', linkedProviders: ['google.com', 'email'] }))).toBe(true);
  });

  // The "sign in to continue" upgrade: linkWithPopup keeps the anonymous uid,
  // and the token may still say sign_in_provider 'anonymous'.
  it('a guest who LINKED Google in place is verified', () => {
    expect(hasVerifiedSignIn(req({ signInProvider: 'anonymous', linkedProviders: ['google.com'] }))).toBe(true);
  });

  it('a plain guest, an unknown provider, or no user is not', () => {
    expect(hasVerifiedSignIn(req({ signInProvider: 'anonymous', linkedProviders: [] }))).toBe(false);
    expect(hasVerifiedSignIn(req({ signInProvider: 'password', linkedProviders: ['email'] }))).toBe(false);
    expect(hasVerifiedSignIn(req({}))).toBe(false);
    expect(hasVerifiedSignIn(req())).toBe(false);
  });
});
