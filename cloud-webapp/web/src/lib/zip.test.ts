import { describe, it, expect } from 'vitest';
import { buildStoreZip } from './zip.js';

const enc = new TextEncoder();

function bytesOf(blob: Blob): Promise<Uint8Array> {
  // jsdom's Blob doesn't implement arrayBuffer(); read via FileReader instead.
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('buildStoreZip', () => {
  it('produces a valid STORE-method ZIP containing the entries', async () => {
    const blob = buildStoreZip([
      { name: 'IMG_001.jpg', data: enc.encode('ORIGINAL-BYTES-FOR-P1') },
      { name: '湘舍动.jpg', data: enc.encode('ORIGINAL-BYTES-FOR-P2') },
    ]);
    expect(blob.type).toBe('application/zip');

    const buf = await bytesOf(blob);
    const dv = new DataView(buf.buffer);

    // Local file header magic at the start, EOCD magic somewhere after.
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    const eocd = indexOf(buf, new Uint8Array([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);

    // EOCD records two entries.
    const ev = new DataView(buf.buffer, eocd);
    expect(ev.getUint16(8, true)).toBe(2); // entries on disk
    expect(ev.getUint16(10, true)).toBe(2); // total entries

    // Stored verbatim → both filenames and payloads appear in the archive.
    expect(indexOf(buf, enc.encode('IMG_001.jpg'))).toBeGreaterThan(-1);
    expect(indexOf(buf, enc.encode('湘舍动.jpg'))).toBeGreaterThan(-1);
    expect(indexOf(buf, enc.encode('ORIGINAL-BYTES-FOR-P1'))).toBeGreaterThan(-1);
    expect(indexOf(buf, enc.encode('ORIGINAL-BYTES-FOR-P2'))).toBeGreaterThan(-1);

    // UTF-8 filename flag (bit 11) set in the first local header.
    expect(dv.getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it('writes the correct CRC-32 into the local header', async () => {
    // crc32("hello") = 0x3610A686 (well-known IEEE 802.3 value).
    const blob = buildStoreZip([{ name: 'a.txt', data: enc.encode('hello') }]);
    const buf = await bytesOf(blob);
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(14, true)).toBe(0x3610a686);
    // Stored size == uncompressed size == 5 (no compression).
    expect(dv.getUint32(18, true)).toBe(5);
    expect(dv.getUint32(22, true)).toBe(5);
  });
});
