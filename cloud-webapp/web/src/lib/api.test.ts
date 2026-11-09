/**
 * api.ts — a tab whose session is gone must say "reload", not just fail.
 * 2026-11-08: an iPhone sent six requests with no token (the token read failed
 * and the request went on without one); every one 401'd and the user only saw
 * searches fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A plain function, not vi.fn: a spy records a rejected promise's outcome on a
// derived promise of its own, which Vitest then reports as unhandled.
let idTokenImpl: () => Promise<string | null> = async () => null;
vi.mock('./firebase.js', () => ({ idToken: () => idTokenImpl() }));

const { apiGet } = await import('./api.js');

function reasons(): { list: string[]; stop: () => void } {
  const list: string[] = [];
  const on = (e: Event): void => {
    list.push((e as CustomEvent<{ reason: string }>).detail.reason);
  };
  window.addEventListener('app:storage-lost', on);
  return { list, stop: () => window.removeEventListener('app:storage-lost', on) };
}

beforeEach(() => {
  idTokenImpl = async () => null;
});
afterEach(() => vi.unstubAllGlobals());

describe('api session loss', () => {
  it('a 401 unauthorized asks the App to show "reload"', async () => {
    idTokenImpl = async () => 'tok';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 })),
    );
    const seen = reasons();
    await expect(apiGet('/api/me')).rejects.toMatchObject({ status: 401 });
    seen.stop();
    expect(seen.list).toEqual(['session']);
  });

  it('a token read that fails because Safari lost its database says so', async () => {
    idTokenImpl = async () => {
      throw new Error('Connection to Indexed Database server lost. Refresh the page to try again');
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const seen = reasons();
    await apiGet('/api/events');
    seen.stop();
    expect(seen.list).toEqual(['storage']);
  });

  it('other errors raise no banner', async () => {
    idTokenImpl = async () => 'tok';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 })),
    );
    const seen = reasons();
    await expect(apiGet('/api/admin/users')).rejects.toMatchObject({ status: 403 });
    seen.stop();
    expect(seen.list).toEqual([]);
  });
});
