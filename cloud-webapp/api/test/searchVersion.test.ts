import { describe, it, expect } from 'vitest';
import type { SearchConfig } from '@cloud-webapp/shared';

import { configFingerprint, deriveSearchVersion } from '../src/services/searchVersion.js';

const CONFIG: SearchConfig = {
  modelVersion: 'm',
  indexModelVersion: 'm',
  tnorm: true,
  cutoff: 4.5,
  wFace: 0.85,
  wPerson: 0.15,
  timeConditional: false,
  faceQualityWeight: 0,
  anchorPersonMode: 'replace',
};

describe('search version fingerprint (Item 23)', () => {
  it('keeps the generation as a prefix, so --search-version filters still match', () => {
    expect(deriveSearchVersion('2026.09-x', CONFIG)).toMatch(/^2026\.09-x\+[0-9a-f]{8}$/);
  });

  it('ignores field order and changes with every field', () => {
    const reordered = Object.fromEntries(Object.entries(CONFIG).reverse()) as SearchConfig;
    expect(configFingerprint(reordered)).toBe(configFingerprint(CONFIG));
    const variants: Partial<SearchConfig>[] = [
      { cutoff: 5 }, { wPerson: 0.2 }, { tnorm: false }, { indexModelVersion: 'other' },
      { faceQualityWeight: 0.5 }, { timeConditional: true }, { anchorPersonMode: 'blend' },
    ];
    for (const v of variants) {
      expect(configFingerprint({ ...CONFIG, ...v })).not.toBe(configFingerprint(CONFIG));
    }
  });
});
