/**
 * origExtParity.test.ts — the api's MIME→extension table must match the
 * indexer's exactly.
 *
 * The indexer writes `orig/<photoId>.<ext>` using `ORIG_EXT_BY_MIME` in
 * `indexer/job.py`; the api reconstructs that same key to sign the original. A
 * MIME the indexer knows but the api doesn't falls through to `bin`, so the api
 * signs a URL for an object that was never written and every download of that
 * photo 404s. That is exactly what happened to `image/bmp` and `image/avif`:
 * they were added to the indexer and the api's copy was never updated.
 *
 * Parsing the Python source keeps the two honest without a shared artifact.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ORIG_EXT_BY_MIME } from '../src/services/gcsService.js';

/** Pull the literal out of `ORIG_EXT_BY_MIME = { ... }` in indexer/job.py. */
function indexerTable(): Record<string, string> {
  const jobPy = fileURLToPath(new URL('../../indexer/job.py', import.meta.url));
  const src = readFileSync(jobPy, 'utf8');
  const start = src.indexOf('ORIG_EXT_BY_MIME');
  expect(start, 'ORIG_EXT_BY_MIME not found in indexer/job.py').toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  const close = src.indexOf('}', open);
  const body = src.slice(open + 1, close);

  const table: Record<string, string> = {};
  for (const [, mime, ext] of body.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    table[mime!] = ext!;
  }
  return table;
}

describe('ORIG_EXT_BY_MIME parity with the indexer', () => {
  it('covers every MIME the indexer writes, with the same extension', () => {
    const indexer = indexerTable();
    expect(Object.keys(indexer).length).toBeGreaterThan(0);
    expect(ORIG_EXT_BY_MIME).toMatchObject(indexer);
  });

  it('claims no MIME the indexer does not write', () => {
    // The reverse direction matters too: an api-only entry would sign
    // `<id>.<ext>` for an object the indexer stored under a different name.
    expect(Object.keys(ORIG_EXT_BY_MIME).sort()).toEqual(Object.keys(indexerTable()).sort());
  });
});
