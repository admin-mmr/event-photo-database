/**
 * inAppBrowser.ts — detect embedded in-app webviews (WeChat / WeCom / DingTalk /
 * QQ / Weibo / Feishu-Lark / Duolingo / Alipay …).
 *
 * Google's "Use secure browsers" policy returns "Error 403: disallowed_useragent"
 * when an OAuth flow runs inside these embedded webviews, so Firebase
 * `signInWithPopup` (and the redirect fallback) hard-fail there. WeChat
 * (MicroMessenger) is by far the most common entry point for this app — users
 * tap the link inside a WeChat chat — so the sign-in screen detects the webview
 * and surfaces a bilingual "open in Safari / Chrome" guide instead of sending
 * the user to an opaque Google error page.
 *
 * Detection is intentionally permissive — a false positive just shows a helpful
 * note, while a false negative leaves the user stuck on a dead-end error page.
 */

const IN_APP_MARKERS: readonly string[] = [
  'micromessenger', // WeChat / 微信
  'wxwork', // WeCom / 企业微信
  'dingtalk', // 钉钉
  'qq/', // QQ
  'qqbrowser', // QQ Browser
  'weibo', // Weibo / 微博
  'lark', // Feishu / Lark
  'feishu', // 飞书
  'duolingo', // Duolingo in-app browser
  'alipay', // Alipay / 支付宝
];

/** True when the current UA looks like an in-app webview where OAuth is blocked. */
export function isInAppBrowser(ua: string = getUserAgent()): boolean {
  const s = ua.toLowerCase();
  return IN_APP_MARKERS.some((marker) => s.includes(marker));
}

/** True specifically for WeChat — used to lead the warning with WeChat steps. */
export function isWeChat(ua: string = getUserAgent()): boolean {
  return ua.toLowerCase().includes('micromessenger');
}

function getUserAgent(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgent || '';
}
