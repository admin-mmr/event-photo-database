import { useEffect, useState } from 'react';

import { GUEST_BLOCKED_EVENT } from '../lib/api.js';
import { upgradeGuestToGoogle } from '../lib/firebase.js';
import { useStrings } from '../lib/i18n.js';
import { isInAppBrowser } from '../lib/inAppBrowser.js';

/**
 * "Sign in to continue" — the way past a bot-check false positive.
 *
 * The api turns a GUEST away with 403 `recaptcha_failed` (low reCAPTCHA score)
 * or 429 `guest_rate_limited` (per-IP guest limit). Real people trip both:
 * event-day data showed low scores coming from attendees saving many photos in
 * quick bursts. Google-signed-in users are exempt from both checks, so instead
 * of a dead-end error this offers a one-tap upgrade (lib/firebase.ts
 * `upgradeGuestToGoogle`, which keeps the guest's uid) and asks them to try
 * again. lib/api.ts fires GUEST_BLOCKED_EVENT for exactly those two codes.
 *
 * Mounted once in the app layout; renders nothing for signed-in users. Inside
 * an in-app browser (WeChat etc.) Google OAuth is blocked, so it says to open
 * the page in Safari / Chrome instead of offering a button that would fail.
 */

const STR = {
  en: {
    title: 'Please sign in to continue',
    body:
      "We couldn't confirm this request came from a person. That sometimes happens when saving lots of photos " +
      'quickly. Sign in with Google and try again — your selfies and choices stay with you.',
    inApp: 'Google sign-in does not work in this app’s browser. Follow the steps at the top of the page to open it in Safari or Chrome, then try again.',
    signIn: 'Sign in with Google',
    notNow: 'Not now',
    busy: 'Signing in…',
    done: "You're signed in. Please try again.",
    ok: 'OK',
    failed: "Sign-in didn't finish. Please try again.",
  },
  zh: {
    title: '请登录后继续',
    body: '我们无法确认此请求来自真人。快速保存大量照片时偶尔会出现这种情况。请使用 Google 登录后重试——您的自拍和选择都会保留。',
    inApp: 'Google 登录无法在此 App 的内置浏览器中使用。请按页面顶部的步骤在 Safari 或 Chrome 中打开此页面，然后重试。',
    signIn: '使用 Google 登录',
    notNow: '暂不',
    busy: '正在登录…',
    done: '您已登录，请重试。',
    ok: '好的',
    failed: '登录未完成，请重试。',
  },
};

type Phase = 'hidden' | 'open' | 'busy' | 'done' | 'error';

export function GuestSignInPrompt({ isGuest }: { isGuest: boolean }): JSX.Element | null {
  const t = useStrings(STR);
  const [phase, setPhase] = useState<Phase>('hidden');
  const [inApp] = useState(() => isInAppBrowser());

  useEffect(() => {
    if (!isGuest) return undefined;
    const open = (): void => setPhase((p) => (p === 'hidden' ? 'open' : p));
    window.addEventListener(GUEST_BLOCKED_EVENT, open);
    return () => window.removeEventListener(GUEST_BLOCKED_EVENT, open);
  }, [isGuest]);

  if (phase === 'hidden') return null;

  async function signIn(): Promise<void> {
    setPhase('busy');
    try {
      await upgradeGuestToGoogle();
      setPhase('done');
    } catch (err) {
      console.error('guest upgrade to Google failed', err);
      setPhase('error');
    }
  }

  const close = (): void => setPhase('hidden');

  return (
    <div className="guest-prompt-backdrop">
      <div className="guest-prompt" role="dialog" aria-modal="true" aria-labelledby="guest-prompt-title">
        <h2 id="guest-prompt-title">{t.title}</h2>
        {phase === 'done' ? (
          <>
            <p>{t.done}</p>
            <div className="guest-prompt-actions">
              <button type="button" className="btn btn-primary" onClick={close}>
                {t.ok}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>{t.body}</p>
            {inApp && <p className="muted">{t.inApp}</p>}
            {phase === 'error' && <p className="error-text">{t.failed}</p>}
            <div className="guest-prompt-actions">
              {!inApp && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={phase === 'busy'}
                  onClick={() => void signIn()}
                >
                  {phase === 'busy' ? t.busy : t.signIn}
                </button>
              )}
              <button type="button" className="btn btn-light" onClick={close} disabled={phase === 'busy'}>
                {t.notNow}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
