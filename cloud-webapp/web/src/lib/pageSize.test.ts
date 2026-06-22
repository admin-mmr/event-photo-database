import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  PAGE_SIZE_OPTIONS,
  FINDME_PAGE_SIZE_OPTIONS,
  DEFAULT_PAGE_SIZE,
  usePageSize,
  useFindMePageSize,
} from './pageSize.js';

beforeEach(() => {
  localStorage.clear();
});

describe('page-size options', () => {
  it('Find Me caps its largest option at the download batch limit (200, not 500)', () => {
    expect(PAGE_SIZE_OPTIONS[PAGE_SIZE_OPTIONS.length - 1]).toBe(500);
    expect(FINDME_PAGE_SIZE_OPTIONS[FINDME_PAGE_SIZE_OPTIONS.length - 1]).toBe(200);
    // No Find Me option may exceed MAX_DOWNLOAD_PHOTOS (200).
    expect(FINDME_PAGE_SIZE_OPTIONS.every((n) => n <= 200)).toBe(true);
  });
});

describe('usePageSize', () => {
  it('defaults to DEFAULT_PAGE_SIZE and persists the choice', () => {
    const { result } = renderHook(() => usePageSize());
    expect(result.current.pageSize).toBe(DEFAULT_PAGE_SIZE);
    act(() => result.current.setPageSize(100));
    expect(result.current.pageSize).toBe(100);
    expect(localStorage.getItem('gallery.pageSize')).toBe('100');
  });

  it('ignores a persisted value that is not a valid option', () => {
    localStorage.setItem('gallery.pageSize', '999');
    const { result } = renderHook(() => usePageSize());
    expect(result.current.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe('useFindMePageSize', () => {
  it('uses a separate storage key from the gallery', () => {
    const { result } = renderHook(() => useFindMePageSize());
    act(() => result.current.setPageSize(200));
    expect(localStorage.getItem('findme.pageSize')).toBe('200');
    expect(localStorage.getItem('gallery.pageSize')).toBeNull();
  });

  it('rejects 500 (a gallery-only option) from its persisted value', () => {
    localStorage.setItem('findme.pageSize', '500');
    const { result } = renderHook(() => useFindMePageSize());
    expect(result.current.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });
});
