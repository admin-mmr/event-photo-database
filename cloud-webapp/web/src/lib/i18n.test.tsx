import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectDefaultLang } from './i18n.js';

describe('detectDefaultLang', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('honors a saved choice over the browser language', () => {
    localStorage.setItem('eulb.lang', 'zh');
    vi.stubGlobal('navigator', { language: 'en-US' } as Navigator);
    expect(detectDefaultLang()).toBe('zh');
    vi.unstubAllGlobals();
  });

  it('defaults to 中文 for zh* browser languages', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' } as Navigator);
    expect(detectDefaultLang()).toBe('zh');
    vi.unstubAllGlobals();
  });

  it('defaults to English otherwise', () => {
    vi.stubGlobal('navigator', { language: 'en-GB' } as Navigator);
    expect(detectDefaultLang()).toBe('en');
    vi.unstubAllGlobals();
  });
});
