import { describe, expect, it } from 'vitest';
import { lightboxSaveState, lightboxSrc, originalsNeeded } from './lightboxSave.js';

describe('originalsNeeded', () => {
  it('is the selection plus an explicit save request', () => {
    expect(originalsNeeded(['a', 'b'], 'c')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('downloads nothing while merely browsing', () => {
    // The regression this module exists to prevent: opening a photo in the
    // lightbox must not, by itself, put its ~6 MB original on the wire.
    expect(originalsNeeded([], null).size).toBe(0);
  });

  it('does not duplicate a requested photo that is also selected', () => {
    expect(originalsNeeded(['a'], 'a')).toEqual(new Set(['a']));
  });
});

describe('lightboxSaveState', () => {
  const mobile = { canSavePhotos: true, cached: false, requested: false, failed: false };

  it('desktop always downloads, whatever the cache holds', () => {
    expect(lightboxSaveState({ ...mobile, canSavePhotos: false })).toBe('download');
    expect(lightboxSaveState({ ...mobile, canSavePhotos: false, cached: true })).toBe('download');
  });

  it('walks prepare → preparing → tapToSave on mobile', () => {
    expect(lightboxSaveState(mobile)).toBe('prepare');
    expect(lightboxSaveState({ ...mobile, requested: true })).toBe('preparing');
    expect(lightboxSaveState({ ...mobile, requested: true, cached: true })).toBe('tapToSave');
  });

  it('is one tap when the original is already cached (e.g. selected)', () => {
    expect(lightboxSaveState({ ...mobile, cached: true })).toBe('save');
  });

  it('a failed download returns to prepare so the next tap retries', () => {
    expect(lightboxSaveState({ ...mobile, requested: true, failed: true })).toBe('prepare');
  });
});

describe('lightboxSrc', () => {
  const base = { thumbUrl: 'thumb', webUrl: 'web', origUrl: 'orig' };

  it('shows a cached original on mobile, since it costs nothing extra', () => {
    expect(lightboxSrc({ ...base, canSavePhotos: true })).toBe('orig');
  });

  it('otherwise shows web, then the thumbnail', () => {
    expect(lightboxSrc({ ...base, canSavePhotos: true, origUrl: undefined })).toBe('web');
    expect(lightboxSrc({ canSavePhotos: true, thumbUrl: 'thumb' })).toBe('thumb');
  });

  it('never shows an original on desktop', () => {
    expect(lightboxSrc({ ...base, canSavePhotos: false })).toBe('web');
  });
});
