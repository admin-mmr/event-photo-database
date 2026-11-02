import { describe, expect, it } from 'vitest';

import { completeBody, fileKey, newFilesOnly, unflushed } from './uploadFlush.js';

const f = (name: string, size = 10, lastModified = 1) => ({ name, size, lastModified });
const r = (uploadId: string) => ({ uploadId, objectName: `vol/ev/b/${uploadId}.jpg`, bytes: 10 });

describe('newFilesOnly', () => {
  it('drops a photo already in the list, and repeats within one pick', () => {
    const existing = [f('IMG_0270.JPG')];
    const incoming = [f('IMG_0270.JPG'), f('IMG_0571.JPG'), f('IMG_0571.JPG')];
    expect(newFilesOnly(existing, incoming).map(fileKey)).toEqual([fileKey(f('IMG_0571.JPG'))]);
  });

  it('keeps two different photos that happen to share a name', () => {
    expect(newFilesOnly([f('IMG_1.JPG', 10)], [f('IMG_1.JPG', 20)])).toHaveLength(1);
  });
});

describe('unflushed', () => {
  it('returns only what has not been handed to the server', () => {
    expect(unflushed([r('a'), r('b'), r('c')], new Set(['a', 'c']))).toEqual([r('b')]);
  });
});

describe('completeBody', () => {
  it('carries this flush as items and the whole session as sessionTotal', () => {
    const body = completeBody('tok', 'b1', [r('a')], 250, () => 'a.jpg');
    expect(body).toEqual({
      token: 'tok',
      batchId: 'b1',
      items: [{ uploadId: 'a', objectName: 'vol/ev/b/a.jpg', fileName: 'a.jpg', bytes: 10 }],
      sessionTotal: 250,
    });
  });
});
