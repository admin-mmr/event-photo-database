import { describe, it, expect } from 'vitest';

import {
  buildCreditedFileName,
  sanitiseComponent,
  stripIllegal,
  truncatePreservingExtension,
} from '../src/lib/creditedFileName.js';

describe('buildCreditedFileName', () => {
  it('builds <Club>_<Photographer>_<original>', () => {
    expect(
      buildCreditedFileName({ clubShortName: 'MMR', photographerName: 'Jane Doe', originalFileName: 'IMG_4231.JPG' }),
    ).toBe('MMR_JaneDoe_IMG_4231.JPG');
  });

  it('handles non-ASCII club + photographer (UTF-8 kept)', () => {
    expect(
      buildCreditedFileName({ clubShortName: '湘舍动', photographerName: '小王', originalFileName: 'DSC00123.ARW' }),
    ).toBe('湘舍动_小王_DSC00123.ARW');
  });

  it('is idempotent — does not double-prefix an already-credited file', () => {
    expect(
      buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: 'Jane Doe',
        originalFileName: 'MMR_JaneDoe_IMG_4231.JPG',
      }),
    ).toBe('MMR_JaneDoe_IMG_4231.JPG');
  });

  it('uses the club-only prefix when no photographer/fallback is given', () => {
    expect(
      buildCreditedFileName({ clubShortName: 'MMR', photographerName: '', originalFileName: 'shot.jpg' }),
    ).toBe('MMR_shot.jpg');
  });

  it('falls back to fallbackName when photographer is blank', () => {
    expect(
      buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: '',
        originalFileName: 'shot.jpg',
        fallbackName: 'jane',
      }),
    ).toBe('MMR_jane_shot.jpg');
  });

  it('returns a sanitised original (no prefix) when club is blank', () => {
    expect(
      buildCreditedFileName({ clubShortName: '', photographerName: '', originalFileName: 'a b/c.jpg' }),
    ).toBe('a_b_c.jpg');
  });
});

describe('helpers', () => {
  it('sanitiseComponent strips illegal chars + whitespace and caps length', () => {
    expect(sanitiseComponent('Jane Doe')).toBe('JaneDoe');
    expect(sanitiseComponent('a/b:c*?')).toBe('abc');
  });

  it('stripIllegal replaces path-illegal chars with underscores', () => {
    expect(stripIllegal('a/b c.jpg')).toBe('a_b_c.jpg');
  });

  it('truncatePreservingExtension keeps the extension', () => {
    const out = truncatePreservingExtension('x'.repeat(300) + '.jpg', 20);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(out.length).toBe(20);
  });
});
