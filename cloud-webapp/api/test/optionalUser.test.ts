import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

// optionalUser is attribution for open routes (the volunteer upload link): it
// must report a signed-in caller and NEVER turn anyone away.

const verifyIdToken = vi.fn();
vi.mock('firebase-admin/app', () => ({
  getApps: () => [{}],
  initializeApp: vi.fn(),
  applicationDefault: vi.fn(),
  cert: vi.fn(),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken }) }));

const { optionalUser } = await import('../src/middleware/auth.js');

const req = (authorization?: string): Request =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as Request;

beforeEach(() => {
  verifyIdToken.mockReset();
});

describe('optionalUser', () => {
  it('returns the signed-in user', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'u1',
      email: 'cathy@example.org',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' },
    });
    expect(await optionalUser(req('Bearer good'))).toEqual({
      uid: 'u1',
      email: 'cathy@example.org',
      emailVerified: true,
    });
    expect(verifyIdToken).toHaveBeenCalledWith('good');
  });

  it('reads no header as signed out, without verifying anything', async () => {
    expect(await optionalUser(req())).toBeNull();
    expect(await optionalUser(req('Basic abc'))).toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('reads an expired or forged token as signed out instead of throwing', async () => {
    verifyIdToken.mockImplementation(async () => {
      throw new Error('auth/id-token-expired');
    });
    expect(await optionalUser(req('Bearer stale'))).toBeNull();
  });

  it('reads an anonymous guest as signed out', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'anon', firebase: { sign_in_provider: 'anonymous' } });
    expect(await optionalUser(req('Bearer guest'))).toBeNull();
  });
});
