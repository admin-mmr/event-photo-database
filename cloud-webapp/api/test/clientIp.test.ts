import { describe, it, expect } from 'vitest';

import { clientIp, isGoogleFrontEnd, rateLimitKeyForIp } from '../src/lib/clientIp.js';

// Real hops seen on Firebase Hosting → Cloud Run requests (2026-11-02) are in
// 66.102.8.0/24, 74.125.210.0/24 and 192.178.11.0/24. 35.192.0.1 is a Google
// CLOUD customer address (us-central1) — Google-owned, but anyone can rent it.
const GFE = '66.102.8.7';
const GFE2 = '74.125.210.5';
const GCE_VM = '35.192.0.1';
const CLIENT = '198.51.100.4';
const FORGED = '203.0.113.7';

function req(xff?: string, remoteAddress = '::ffff:10.0.0.1') {
  return { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } } as never;
}

describe('isGoogleFrontEnd', () => {
  it('recognises the front ends Hosting traffic arrives through', () => {
    for (const ip of [GFE, GFE2, '192.178.11.9']) expect(isGoogleFrontEnd(ip)).toBe(true);
  });

  it('does NOT trust Google Cloud customer ranges, or anyone else', () => {
    expect(isGoogleFrontEnd(GCE_VM)).toBe(false);
    expect(isGoogleFrontEnd(CLIENT)).toBe(false);
    expect(isGoogleFrontEnd('not-an-ip')).toBe(false);
  });
});

describe('clientIp', () => {
  it('via Hosting: the hop before the Google front end is the client', () => {
    expect(clientIp(req(`${CLIENT}, ${GFE}`))).toEqual({ ip: CLIENT, via: 'hosting' });
  });

  it('reads right-to-left, so extra leading entries change nothing', () => {
    expect(clientIp(req(`${FORGED}, ${CLIENT}, ${GFE}`))).toEqual({ ip: CLIENT, via: 'hosting' });
  });

  // The bypass this module exists to close: direct to *.run.app, Cloud Run only
  // APPENDS the real caller, so req.ip (leftmost) would be the forged value.
  it('direct to run.app: a forged X-Forwarded-For is ignored, the real caller is used', () => {
    expect(clientIp(req(`${FORGED}, ${CLIENT}`))).toEqual({ ip: CLIENT, via: 'direct' });
    expect(clientIp(req(`1.1.1.1, ${FORGED}, ${CLIENT}`))).toEqual({ ip: CLIENT, via: 'direct' });
  });

  it('a bot on a Google Cloud VM cannot pose as a front end to name its own client', () => {
    expect(clientIp(req(`${FORGED}, ${GCE_VM}`))).toEqual({ ip: GCE_VM, via: 'direct' });
  });

  it('never returns a front end as the client (stale range list) — suspect, no ip', () => {
    expect(clientIp(req(`${GFE2}, ${GFE}`))).toEqual({ ip: undefined, via: 'hosting', suspect: true });
    expect(clientIp(req(GFE))).toEqual({ ip: undefined, via: 'hosting', suspect: true });
  });

  it('skips non-IP junk and unmaps IPv4-mapped addresses', () => {
    expect(clientIp(req(`unknown, ::ffff:${CLIENT}`))).toEqual({ ip: CLIENT, via: 'direct' });
  });

  it('falls back to the socket address when there is no X-Forwarded-For (local dev)', () => {
    expect(clientIp(req(undefined, '::ffff:127.0.0.1'))).toEqual({ ip: '127.0.0.1', via: 'local' });
    expect(clientIp(req(''))).toEqual({ ip: '10.0.0.1', via: 'local' });
  });
});

describe('rateLimitKeyForIp', () => {
  it('keeps IPv4 as-is', () => {
    expect(rateLimitKeyForIp(CLIENT)).toBe(CLIENT);
  });

  it('collapses IPv6 to its /64, so rotating within a subscriber prefix does not help', () => {
    expect(rateLimitKeyForIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKeyForIp('2001:db8:1:2:ffff::9')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKeyForIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKeyForIp('2001:DB8:0001:0002::1')).toBe('2001:db8:1:2::/64');
  });
});
