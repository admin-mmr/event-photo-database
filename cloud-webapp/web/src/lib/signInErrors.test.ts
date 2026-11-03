import { describe, it, expect } from 'vitest';
import { isSignInCancelled } from './signInErrors.js';

describe('isSignInCancelled', () => {
  it('treats a closed or superseded popup as a cancel, not a failure', () => {
    expect(isSignInCancelled({ code: 'auth/popup-closed-by-user' })).toBe(true);
    expect(isSignInCancelled({ code: 'auth/cancelled-popup-request' })).toBe(true);
    expect(isSignInCancelled({ code: 'auth/user-cancelled' })).toBe(true);
  });

  it('keeps real failures as failures', () => {
    expect(isSignInCancelled({ code: 'auth/popup-blocked' })).toBe(false);
    expect(isSignInCancelled({ code: 'auth/network-request-failed' })).toBe(false);
    expect(isSignInCancelled(new Error('INTERNAL ASSERTION FAILED: Pending promise was never set'))).toBe(false);
    expect(isSignInCancelled(null)).toBe(false);
    expect(isSignInCancelled(undefined)).toBe(false);
  });
});
