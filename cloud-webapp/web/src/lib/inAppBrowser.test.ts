import { describe, it, expect } from 'vitest';
import { isInAppBrowser, isWeChat } from './inAppBrowser.js';

describe('isInAppBrowser', () => {
  it('flags WeChat / WeCom / DingTalk / Duolingo / Alipay UAs', () => {
    expect(isInAppBrowser('Mozilla/5.0 ... MicroMessenger/8.0.49')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 ... wxwork/4.1')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 ... DingTalk/6.5')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 ... Duolingo/6.0')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 ... AlipayClient/10.2')).toBe(true);
  });

  it('passes normal Safari / Chrome UAs', () => {
    expect(isInAppBrowser('Mozilla/5.0 ... Version/17 Safari/605')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 ... Chrome/124 Safari/537')).toBe(false);
  });
});

describe('isWeChat', () => {
  it('is true only for MicroMessenger UAs', () => {
    expect(isWeChat('Mozilla/5.0 ... MicroMessenger/8.0')).toBe(true);
    expect(isWeChat('Mozilla/5.0 ... DingTalk/6.5')).toBe(false);
    expect(isWeChat('Mozilla/5.0 ... Chrome/124 Safari/537')).toBe(false);
  });
});
