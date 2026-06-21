/**
 * zip.ts — minimal, dependency-free ZIP writer (STORE method, no compression).
 *
 * Photos are already compressed (JPEG/PNG/HEIC), so we store them verbatim —
 * exactly what the old server-side ZIP did (`zlib level 0`). Building the ZIP in
 * the browser lets us fetch each original straight from its signed GCS URL, so
 * the heavy bytes never pass through Cloud Run + the Firebase Hosting `/api/**`
 * rewrite (which billed them as Hosting egress).
 *
 * Scope: classic 32-bit ZIP (no Zip64), which caps a single archive at ~4 GB
 * and each entry the same. The MAX_DOWNLOAD_PHOTOS selection cap plus the
 * in-memory blob keep us well under that; revisit with a streaming/Zip64 writer
 * if downloads ever need to exceed it.
 */

const textEncoder = new TextEncoder();

// Standard CRC-32 (IEEE 802.3), table-driven so large originals stay fast.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!)! & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Entry name as it should appear in the archive. */
  name: string;
  /** Raw bytes, stored uncompressed. */
  data: Uint8Array;
}

// Fixed, valid DOS timestamp (1980-01-01 00:00) — we don't carry real mtimes.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
// General-purpose bit 11: filenames are UTF-8.
const FLAG_UTF8 = 0x0800;

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  size: number;
  offset: number; // byte offset of this entry's local header
}

/**
 * Assemble `entries` into a single STORE-method ZIP and return it as a Blob.
 * Entry order is preserved; callers are responsible for de-duplicating names.
 *
 * Built into one contiguous output buffer (each original is copied in exactly
 * once), so the result is plain `ArrayBuffer`-backed and there's no intermediate
 * chunk list to keep alive.
 */
export function buildStoreZip(entries: ZipEntry[]): Blob {
  // Pass 1: CRC + sizes + offsets, and total output length.
  const prepared: PreparedEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    prepared.push({
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      size: entry.data.length,
      offset,
    });
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const centralOffset = offset;
  const centralSize = prepared.reduce((sum, p) => sum + 46 + p.nameBytes.length, 0);
  const total = centralOffset + centralSize + 22;

  // Pass 2: write everything into one buffer.
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let pos = 0;

  for (const p of prepared) {
    dv.setUint32(pos, 0x04034b50, true); // local file header signature
    dv.setUint16(pos + 4, 20, true); // version needed
    dv.setUint16(pos + 6, FLAG_UTF8, true);
    dv.setUint16(pos + 8, 0, true); // method: store
    dv.setUint16(pos + 10, DOS_TIME, true);
    dv.setUint16(pos + 12, DOS_DATE, true);
    dv.setUint32(pos + 14, p.crc, true);
    dv.setUint32(pos + 18, p.size, true); // compressed size
    dv.setUint32(pos + 22, p.size, true); // uncompressed size
    dv.setUint16(pos + 26, p.nameBytes.length, true);
    dv.setUint16(pos + 28, 0, true); // extra field length
    out.set(p.nameBytes, pos + 30);
    out.set(p.data, pos + 30 + p.nameBytes.length);
    pos += 30 + p.nameBytes.length + p.size;
  }

  for (const p of prepared) {
    dv.setUint32(pos, 0x02014b50, true); // central dir header signature
    dv.setUint16(pos + 4, 20, true); // version made by
    dv.setUint16(pos + 6, 20, true); // version needed
    dv.setUint16(pos + 8, FLAG_UTF8, true);
    dv.setUint16(pos + 10, 0, true); // method: store
    dv.setUint16(pos + 12, DOS_TIME, true);
    dv.setUint16(pos + 14, DOS_DATE, true);
    dv.setUint32(pos + 16, p.crc, true);
    dv.setUint32(pos + 20, p.size, true);
    dv.setUint32(pos + 24, p.size, true);
    dv.setUint16(pos + 28, p.nameBytes.length, true);
    dv.setUint16(pos + 30, 0, true); // extra length
    dv.setUint16(pos + 32, 0, true); // comment length
    dv.setUint16(pos + 34, 0, true); // disk number start
    dv.setUint16(pos + 36, 0, true); // internal attrs
    dv.setUint32(pos + 38, 0, true); // external attrs
    dv.setUint32(pos + 42, p.offset, true); // local header offset
    out.set(p.nameBytes, pos + 46);
    pos += 46 + p.nameBytes.length;
  }

  // End of central directory record.
  dv.setUint32(pos, 0x06054b50, true); // EOCD signature
  dv.setUint16(pos + 4, 0, true); // this disk
  dv.setUint16(pos + 6, 0, true); // disk with central dir
  dv.setUint16(pos + 8, prepared.length, true); // entries on this disk
  dv.setUint16(pos + 10, prepared.length, true); // total entries
  dv.setUint32(pos + 12, centralSize, true);
  dv.setUint32(pos + 16, centralOffset, true);
  dv.setUint16(pos + 20, 0, true); // comment length

  return new Blob([out], { type: 'application/zip' });
}
