import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Pure unit tests for the pilot feature-flag decision (dev plan M6.1/M6.4).
 * config.ts parses process.env at import, so each scenario re-imports it under
 * vi.resetModules() with the env it wants.
 */

async function loadConfig(vars: Record<string, string>) {
  vi.resetModules();
  delete process.env.FINDME_ENABLED;
  delete process.env.FINDME_EVENT_ALLOWLIST;
  Object.assign(process.env, vars);
  return import('../src/lib/config.js');
}

afterEach(() => {
  delete process.env.FINDME_ENABLED;
  delete process.env.FINDME_EVENT_ALLOWLIST;
});

describe('isFindMeEnabledForEvent', () => {
  it('defaults to enabled for every event (empty allowlist)', async () => {
    const { isFindMeEnabledForEvent, findMeEventAllowlist } = await loadConfig({});
    expect(findMeEventAllowlist).toEqual([]);
    expect(isFindMeEnabledForEvent('any-event')).toBe(true);
  });

  it('restricts to the allowlist when one is set', async () => {
    const { isFindMeEnabledForEvent, findMeEventAllowlist } = await loadConfig({
      FINDME_EVENT_ALLOWLIST: ' ev_pilot , ev_two ',
    });
    expect(findMeEventAllowlist).toEqual(['ev_pilot', 'ev_two']);
    expect(isFindMeEnabledForEvent('ev_pilot')).toBe(true);
    expect(isFindMeEnabledForEvent('ev_two')).toBe(true);
    expect(isFindMeEnabledForEvent('ev_other')).toBe(false);
  });

  it('is off for everything when FINDME_ENABLED=false (even allowlisted)', async () => {
    const { isFindMeEnabledForEvent } = await loadConfig({
      FINDME_ENABLED: 'false',
      FINDME_EVENT_ALLOWLIST: 'ev_pilot',
    });
    expect(isFindMeEnabledForEvent('ev_pilot')).toBe(false);
    expect(isFindMeEnabledForEvent('any')).toBe(false);
  });
});
