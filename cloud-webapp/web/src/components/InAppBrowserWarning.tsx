import { useState } from 'react';
import { isWeChat } from '../lib/inAppBrowser.js';

/**
 * Bilingual in-app-browser warning. Sign-in screen only. Google blocks OAuth in
 * embedded webviews (403 disallowed_useragent), so steer the user to Safari /
 * Chrome. Intentionally **always bilingual** (中文 + English) regardless of the
 * language toggle — a stranded user hasn't necessarily picked a language, and
 * this is the most safety-critical text in the app.
 */
export function InAppBrowserWarning(): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const wechat = isWeChat();

  async function copyPageLink(): Promise<void> {
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopied('ok');
        setTimeout(() => setCopied('idle'), 3000);
        return;
      }
    } catch {
      /* fall through to legacy path */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(ok ? 'ok' : 'fail');
      if (ok) setTimeout(() => setCopied('idle'), 3000);
    } catch {
      setCopied('fail');
    }
  }

  return (
    <div className="inapp-warning" role="alert">
      <div className="inapp-title">
        <span aria-hidden="true">⚠️</span>
        <span>无法在当前浏览器登录 · Sign-in not available here</span>
      </div>
      <p>
        {wechat
          ? '您正在微信内置浏览器中打开此页面，Google 出于安全原因会拒绝登录（错误 403：disallowed_useragent）。'
          : '您正在 App 的内置浏览器（如微信 / 钉钉 / QQ / Duolingo）中打开此页面，Google 出于安全原因会拒绝登录（错误 403：disallowed_useragent）。'}
        <br />
        {wechat
          ? 'You opened this page inside WeChat’s in-app browser. Google blocks sign-in here for security reasons (Error 403: disallowed_useragent).'
          : 'You opened this page inside an app’s in-app browser (e.g. WeChat, DingTalk, Duolingo). Google blocks sign-in here for security reasons (Error 403: disallowed_useragent).'}
      </p>
      <p className="inapp-howto">解决方法 · How to fix</p>
      <ol>
        <li>
          点击右上角「···」菜单 — Tap the <strong>“···”</strong> menu in the top-right corner
        </li>
        <li>
          选择「在 Safari 中打开」或「在浏览器中打开」 — Choose <strong>“Open in Safari”</strong> (iPhone) or{' '}
          <strong>“Open in Browser”</strong> (Android)
        </li>
        <li>
          建议使用<strong>无痕 / 隐身窗口</strong>登录 — Sign in using a{' '}
          <strong>private / Incognito window</strong> to avoid account conflicts
        </li>
      </ol>
      <hr className="inapp-divider" />
      <p>
        如果菜单中没有该选项，请复制此链接，在 Safari 或 Chrome 的<strong>无痕 / 隐身窗口</strong>中粘贴打开。
        <br />
        If that option is missing, copy this link and open it in a{' '}
        <strong>private / Incognito window</strong> in Safari or Chrome.
      </p>
      <div className="copy-link-row">
        <button type="button" className="copy-link-btn" onClick={() => void copyPageLink()}>
          复制链接 · Copy link
        </button>
        {copied === 'ok' && <span className="copy-status">已复制 · Copied</span>}
        {copied === 'fail' && (
          <span className="copy-status copy-status-fail">复制失败，请长按选择 · Long-press to select</span>
        )}
      </div>
    </div>
  );
}
