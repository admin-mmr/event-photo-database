/**
 * recaptcha.ts — client-side reCAPTCHA Enterprise token acquisition.
 *
 * Mirrors the server gate (api/src/services/recaptcha.ts): when no site key is
 * configured the helper is a no-op and returns `undefined`, so local dev and
 * the demo keep working without a key — the server's middleware also no-ops in
 * that case. When `VITE_RECAPTCHA_SITE_KEY` is set, we lazily load the
 * Enterprise script once and mint a per-call token for the given action.
 *
 * Usage: `const token = await getRecaptchaToken('volunteer_upload')` then send
 * it in the `X-Recaptcha-Token` header.
 */

const SITE_KEY = (import.meta.env as Record<string, string | undefined>)
  .VITE_RECAPTCHA_SITE_KEY;

interface GrecaptchaEnterprise {
  enterprise: {
    ready: (cb: () => void) => void;
    execute: (siteKey: string, opts: { action: string }) => Promise<string>;
  };
}

declare global {
  interface Window {
    grecaptcha?: GrecaptchaEnterprise;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Inject the Enterprise script once and resolve when `grecaptcha` is ready. */
function loadScript(siteKey: string): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.defer = true;
    el.onload = () => {
      if (window.grecaptcha?.enterprise) {
        window.grecaptcha.enterprise.ready(() => resolve());
      } else {
        reject(new Error('grecaptcha.enterprise unavailable after load'));
      }
    };
    el.onerror = () => reject(new Error('failed to load reCAPTCHA Enterprise script'));
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/**
 * Returns a fresh Enterprise token for `action`, or `undefined` when reCAPTCHA
 * is not configured or token minting fails. Never throws — a reCAPTCHA hiccup
 * must not block a real volunteer (the server fails open on infra errors too).
 */
export async function getRecaptchaToken(action: string): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  try {
    await loadScript(SITE_KEY);
    return await window.grecaptcha!.enterprise.execute(SITE_KEY, { action });
  } catch {
    return undefined;
  }
}
