/**
 * imageType — a selfie's type from its bytes when the browser's label is
 * missing or wrong (Windows Chrome sends an iPhone HEIC as octet-stream).
 */
import { describe, it, expect } from 'vitest';

import { resolveSelfieType, sniffImageType } from '../src/lib/imageType.js';

const ftyp = (brand: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);

describe('sniffImageType', () => {
  it('recognises the formats the matcher decodes', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImageType(ftyp('heic'))).toBe('image/heic');
    expect(sniffImageType(ftyp('mif1'))).toBe('image/heif');
  });

  it('refuses what the matcher cannot read', () => {
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(ftyp('avif'))).toBeNull(); // AVIF: the page converts it to JPEG instead
    expect(sniffImageType(ftyp('mp42'))).toBeNull(); // a video
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('resolveSelfieType', () => {
  it('trusts an accepted label and sniffs anything else', () => {
    expect(resolveSelfieType('image/png', Buffer.from('whatever'))).toBe('image/png');
    expect(resolveSelfieType('application/octet-stream', ftyp('heic'))).toBe('image/heic');
    expect(resolveSelfieType('', Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(resolveSelfieType('image/gif', Buffer.from('GIF89a'))).toBeNull();
  });
});
