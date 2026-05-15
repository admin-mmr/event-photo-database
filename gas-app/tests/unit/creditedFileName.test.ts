import {
  buildCreditedFileName,
  sanitiseComponent,
  stripIllegal,
  truncatePreservingExtension,
} from '../../src/utils/creditedFileName';

describe('buildCreditedFileName', () => {
  describe('happy path', () => {
    it('prepends "<Club>_<Photographer>_" to a plain filename', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane Doe',
          originalFileName: 'IMG_4231.JPG',
        })
      ).toBe('MMR_JaneDoe_IMG_4231.JPG');
    });

    it('preserves CJK characters in club and photographer name', () => {
      expect(
        buildCreditedFileName({
          clubShortName: '湘舍动',
          photographerName: '小王',
          originalFileName: 'DSC00123.ARW',
        })
      ).toBe('湘舍动_小王_DSC00123.ARW');
    });

    it('collapses internal whitespace in the photographer name (CamelCase effect)', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Sean   O Brien',
          originalFileName: 'photo.heic',
        })
      ).toBe('MMR_SeanOBrien_photo.heic');
    });

    it('strips path-illegal characters from prefix components', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MM/R\\',
          photographerName: 'Jane:Doe?',
          originalFileName: 'a.jpg',
        })
      ).toBe('MMR_JaneDoe_a.jpg');
    });
  });

  describe('fallback', () => {
    it('uses fallbackName when photographerName is empty', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: '',
          originalFileName: 'IMG_0001.JPG',
          fallbackName: 'jane.doe',
        })
      ).toBe('MMR_jane.doe_IMG_0001.JPG');
    });

    it('uses fallbackName when photographerName is just whitespace', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: '   ',
          originalFileName: 'IMG_0001.JPG',
          fallbackName: 'jane.doe',
        })
      ).toBe('MMR_jane.doe_IMG_0001.JPG');
    });

    it('prefers photographerName when both are present', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane Doe',
          originalFileName: 'IMG.jpg',
          fallbackName: 'jane.doe',
        })
      ).toBe('MMR_JaneDoe_IMG.jpg');
    });
  });

  describe('empty prefix segments', () => {
    it('emits only "<Club>_" when both name fields are empty', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: '',
          originalFileName: 'IMG.jpg',
        })
      ).toBe('MMR_IMG.jpg');
    });

    it('emits only "<Name>_" when club is empty', () => {
      expect(
        buildCreditedFileName({
          clubShortName: '',
          photographerName: 'Jane Doe',
          originalFileName: 'IMG.jpg',
        })
      ).toBe('JaneDoe_IMG.jpg');
    });

    it('returns the sanitised original when all components are empty', () => {
      expect(
        buildCreditedFileName({
          clubShortName: '',
          photographerName: '',
          originalFileName: 'IMG 0001.jpg',
        })
      ).toBe('IMG_0001.jpg');
    });
  });

  describe('idempotency', () => {
    it('does not stack the prefix when the original already starts with it', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane Doe',
          originalFileName: 'MMR_JaneDoe_IMG_4231.JPG',
        })
      ).toBe('MMR_JaneDoe_IMG_4231.JPG');
    });

    it('still prepends when the file only starts with the club name (no name component)', () => {
      // "MMR_dashboard.jpg" starts with "MMR_" but NOT with "MMR_JaneDoe_",
      // so it should still be credited.
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane Doe',
          originalFileName: 'MMR_dashboard.jpg',
        })
      ).toBe('MMR_JaneDoe_MMR_dashboard.jpg');
    });

    it('is exactly idempotent when applied twice', () => {
      const once = buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: 'Jane Doe',
        originalFileName: 'IMG.jpg',
      });
      const twice = buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: 'Jane Doe',
        originalFileName: once,
      });
      expect(twice).toBe(once);
    });
  });

  describe('truncation', () => {
    it('caps total length at the default of 240, preserving the extension', () => {
      const long = 'A'.repeat(300) + '.JPG';
      const result = buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: 'Jane',
        originalFileName: long,
      });
      expect(result.length).toBeLessThanOrEqual(240);
      expect(result.endsWith('.JPG')).toBe(true);
      expect(result.startsWith('MMR_Jane_')).toBe(true);
    });

    it('respects a custom maxLength', () => {
      const result = buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: 'Jane',
        originalFileName: 'AAAAAAAAAA.jpg',
        maxLength: 20,
      });
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result.endsWith('.jpg')).toBe(true);
    });

    it('truncates raw (no extension) cleanly', () => {
      const result = buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: 'Jane',
        originalFileName: 'B'.repeat(300),
      });
      expect(result.length).toBe(240);
    });

    it('caps the prefix component at MAX_COMPONENT_LENGTH (40)', () => {
      const longName = 'A'.repeat(80);
      const result = buildCreditedFileName({
        clubShortName: 'MMR',
        photographerName: longName,
        originalFileName: 'photo.jpg',
      });
      // 40 A's + delimiters + filename
      expect(result).toBe(`MMR_${'A'.repeat(40)}_photo.jpg`);
    });
  });

  describe('special inputs', () => {
    it('keeps dashes, dots and underscores in the original filename', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane',
          originalFileName: 'finish-line_2026.05.15.jpg',
        })
      ).toBe('MMR_Jane_finish-line_2026.05.15.jpg');
    });

    it('replaces path-illegal characters in the original with underscores', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane',
          originalFileName: 'a/b\\c:d?.jpg',
        })
      ).toBe('MMR_Jane_a_b_c_d_.jpg');
    });

    it('collapses runs of whitespace in the original to a single underscore', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane',
          originalFileName: 'photo   (1).heic',
        })
      ).toBe('MMR_Jane_photo_(1).heic');
    });

    it('handles an empty originalFileName by returning just the prefix', () => {
      expect(
        buildCreditedFileName({
          clubShortName: 'MMR',
          photographerName: 'Jane',
          originalFileName: '',
        })
      ).toBe('MMR_Jane_');
    });
  });
});

describe('sanitiseComponent', () => {
  it('returns empty string for empty input', () => {
    expect(sanitiseComponent('')).toBe('');
  });

  it('keeps Unicode letters and digits', () => {
    expect(sanitiseComponent('Jane123')).toBe('Jane123');
    expect(sanitiseComponent('湘舍动')).toBe('湘舍动');
  });

  it('strips path-illegal characters', () => {
    expect(sanitiseComponent('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('caps at 40 characters', () => {
    expect(sanitiseComponent('A'.repeat(100)).length).toBe(40);
  });
});

describe('stripIllegal', () => {
  it('replaces path-illegal characters with underscores', () => {
    expect(stripIllegal('a/b\\c')).toBe('a_b_c');
  });

  it('collapses whitespace to underscore', () => {
    expect(stripIllegal('hello   world')).toBe('hello_world');
  });
});

describe('truncatePreservingExtension', () => {
  it('is a no-op when within budget', () => {
    expect(truncatePreservingExtension('short.jpg', 100)).toBe('short.jpg');
  });

  it('keeps the extension when truncating', () => {
    expect(truncatePreservingExtension('A'.repeat(100) + '.jpg', 20)).toBe(
      'A'.repeat(16) + '.jpg'
    );
  });

  it('treats long ".xxxxxxxxxx" tails as not-an-extension', () => {
    expect(truncatePreservingExtension('A'.repeat(50) + '.notanextension', 30)).toBe(
      ('A'.repeat(50) + '.notanextension').slice(0, 30)
    );
  });
});
