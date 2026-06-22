# WEB_UI_REFRESH_DEV_PLAN.md — cloud-webapp/web visual refresh + in-app browser warning

**Status:** Proposed (not yet implemented — written while parallel bug-fix
threads are active, so nothing here has been merged).
**Scope:** `cloud-webapp/web` (the React SPA only). No API, indexer, matcher, or
infra changes.
**Author:** IT Department AI · 2026-06-22

---

## 1. Why

Two problems with the new `cloud-webapp/web` SPA, compared with the deprecated
`gas-app`:

1. **It looks unfinished.** The styling is a flat, ad-hoc stylesheet
   (`web/src/styles.css`, ~1120 lines) with hard-coded hex values repeated
   throughout, a single blue (`#2563eb`), the default `system-ui` font, and a
   **bare sign-in screen** — two unstyled buttons and one line of text
   (`App.tsx` lines 106–116). `gas-app`'s login, by contrast, is a polished,
   centered, branded card. First impression matters most on the screen every
   user hits first.

2. **No in-app browser guard.** `gas-app/src/ui/templates/login.html` detects
   embedded webviews (WeChat / DingTalk / QQ / Weibo / Feishu-Lark / Duolingo /
   Alipay) and shows a bilingual "open in Safari / Chrome" warning, because
   Google returns **`Error 403: disallowed_useragent`** for OAuth inside those
   webviews. `cloud-webapp` signs in with Firebase `signInWithPopup`
   (`web/src/lib/firebase.ts`) which **hard-fails the exact same way** in those
   webviews — but there is currently **no detection at all**, so a large slice
   of the (predominantly Chinese-app) user base hits an opaque Google dead-end.

This plan covers a **fresh, modern visual language applied app-wide** plus a
**sign-in-only bilingual in-app-browser warning** ported from `gas-app`.

### Decisions locked in (from product)

- **Refresh scope:** whole app, page by page (every route gets the new look).
- **Visual direction:** *fresh modern* — a new palette and typography, distinct
  from `gas-app`'s Material-Design-Lite indigo. Not a 1:1 copy of `gas-app`.
- **In-app warning placement:** **sign-in screen only** (that's where Google
  OAuth runs and hard-fails; the public volunteer-upload page does not OAuth).

### Non-goals

- No dark mode in this pass (leave a token seam for it; ship light only).
- No routing / data-flow / component-API changes. Pure presentation + one new
  isolated module + one localized `App.tsx` edit.
- No new runtime dependencies, no CSS framework. Stay with hand-written CSS so
  there is nothing to compile and the bundle stays tiny.
- No bilingual rewrite of the whole UI. Only the **warning** is bilingual
  (required); the rest of the UI stays English as it is today.

---

## 2. Design language — "fresh modern"

### 2.1 Principles

- **Token-first.** Every color, radius, shadow, and font lands in CSS custom
  properties on `:root`. Components reference tokens, never raw hex. This is the
  single highest-leverage change: it restyles every page at once and makes
  future theming (incl. dark mode) a token swap.
- **Calm, high-contrast neutrals + one confident accent.** Slate-gray text on
  near-white surfaces; a single indigo→violet accent for primary actions and
  focus. Color is used sparingly and meaningfully (status badges, selection).
- **Soft depth, not borders.** Replace flat 1px gray boxes with subtle shadows
  and hairline borders; rounded corners (10–16px). Cards lift slightly on hover
  where they are interactive.
- **Reuse existing class names.** The refresh is delivered almost entirely by
  rewriting `styles.css`. Because every page already uses shared classes
  (`.btn`, `.event-card`, `.data-table`, `.photo-grid`, `.select-bar`,
  `.badge`, …), restyling those classes refreshes all pages with **zero JSX
  churn** — which is also what keeps this from colliding with the bug-fix
  threads (see §6).

### 2.2 Design tokens (proposed values)

```css
:root {
  /* Type */
  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;

  /* Surfaces / neutrals (slate scale) */
  --bg: #f5f6fa;            /* app background        */
  --surface: #ffffff;       /* cards, bars, tables   */
  --surface-2: #f1f3f9;     /* image placeholders, inset rows */
  --border: #e6e8ef;        /* hairline borders (also consumed by AdminMetrics inline style) */
  --border-strong: #cdd2df;

  /* Text */
  --text: #0f172a;
  --text-muted: #5b6577;
  --text-subtle: #8a93a6;

  /* Brand / accent */
  --primary: #4f46e5;       /* indigo-600 */
  --primary-hover: #4338ca;
  --primary-weak: #eef2ff;  /* tints, active tabs */
  --on-primary: #ffffff;
  --brand-grad: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);

  /* Status */
  --success: #047857; --success-bg: #ecfdf5;
  --warn: #b45309;    --warn-bg: #fff7ed;
  --danger: #b42318;  --danger-bg: #fef3f2;

  /* Focus ring */
  --ring: 0 0 0 3px rgba(79, 70, 229, 0.35);

  /* Radius */
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-full: 999px;

  /* Elevation */
  --shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.06);
  --shadow-md: 0 4px 14px rgba(16, 24, 40, 0.08);
  --shadow-lg: 0 16px 40px rgba(16, 24, 40, 0.16);

  /* Motion */
  --t: 150ms ease;

  font-family: var(--font-sans);
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
}
```

> **Free token win:** `web/src/pages/AdminMetrics.tsx` already writes
> `border: '1px solid var(--border, #ddd)'` inline. Today `--border` is
> undefined so it falls back to `#ddd`. Simply *defining* `--border` upgrades
> that page with no edit to it — evidence the token approach reaches pages we
> don't touch.

### 2.3 Typography

- Load **Inter** (variable, weights 400/500/600/700) via `index.html` — either a
  `<link>` to Google Fonts or, preferred for the cost/perf posture in
  `CLAUDE.md`, self-host the woff2 in `web/public/` so there's no third-party
  request. Fallback chain includes `PingFang SC` / `Microsoft YaHei` so the
  bilingual warning renders cleanly on CN systems.
- Scale: h1 22→24px/700, section headers 16–18px/600, body 15px/400, meta
  13px/500, mono 12px. Tighten heading letter-spacing slightly (-0.01em).

### 2.4 Component specs (what changes, by class)

| Area | Classes | Change |
|---|---|---|
| App background | `:root`, `body` | Token bg; optional faint top radial tint behind header. |
| Header | `.app-header`, `.app-title`, `.user-box`, `.nav-link` | Add a brand mark (inline SVG, no asset) left of the title; nav links become pill hovers with `--primary-weak`; sticky header with `--shadow-sm` and a hairline bottom border. |
| Buttons | `.btn`, `.btn-primary`, `.btn-light`, `.btn-danger`, `.btn-sm`, `.btn-feedback` | Token colors; `--primary` solid for primary with hover-darken + subtle lift; `:focus-visible` ring; consistent 10/18 padding; `transition: var(--t)`. |
| Cards | `.event-card`, `.mydata-card`, `.consent-card`, `.card`, `.metric-card` | `--surface`, hairline `--border`, `--r-md`, `--shadow-sm`; interactive cards (`.event-card:hover`) get `--shadow-md` + 1px translateY. |
| Events list | `.event-row`, `.event-name`, `.event-date`, `.event-id`, `.event-stat` | Stronger title weight, muted metadata, mono event id chip on `--surface-2`. |
| Badges | `.badge`, `.badge-ok/-warn/-err` | Token status bg/fg, `--r-full`, 12px/600. |
| Tables | `.table-wrap`, `.data-table` | Sticky header row, zebra `--surface-2`, hover row highlight, uppercase muted `th`. |
| Photo grid + lightbox | `.photo-grid`, `.photo-cell`, `.result-cell`, `.score-chip`, `.lightbox*` | Placeholder `--surface-2`; selection ring uses `--primary` + `--ring`; lightbox backdrop slightly darker with blur; round nav buttons with hover state. |
| Toolbars / selects | `.gallery-actions`, `.results-toolbar`, `.page-size-select`, `.feedback-input`, `.select-bar` | Token borders/radius, focus ring, 16px font on mobile (keep the existing iOS-zoom guard). |
| Find Me ref picker | `.ref-tab`, `.ref-current`, `.ref-tab.active` | Active tab uses `--primary` border + `--primary-weak` fill. |
| Status / spinners | `.status-text`, `.spinner`, `.searching` | Token success styling; spinner top-color `--primary`; keep `prefers-reduced-motion` rule already present. |
| Danger zone | `.danger-zone` | Token danger bg/border. |
| Sign-in | (new) `.signin-screen`, `.signin-card`, `.brand-mark` | See §4. |
| In-app warning | (new) `.inapp-warning` + children | See §3. |

### 2.5 Accessibility & polish

- All text/background pairs target **WCAG AA** (≥4.5:1 body, ≥3:1 large).
- Add a global `:focus-visible { outline: none; box-shadow: var(--ring); }` so
  keyboard focus is always visible (today there is none defined).
- Keep the existing `@media (prefers-reduced-motion: reduce)` block; extend it
  to the new hover-lift transitions.
- Leave a `@media (prefers-color-scheme: dark)` seam commented in `:root` for a
  future dark pass (out of scope now).

---

## 3. In-app browser warning (sign-in screen only)

### 3.1 Behavior

On the **signed-out sign-in screen**, detect embedded webviews via user agent.
When detected:

- **Hide** the "Sign in with Google" button (it would only lead to Google's
  `403 disallowed_useragent` dead-end).
- **Show** a bilingual warning card explaining how to reopen in Safari/Chrome,
  with a **"复制链接 / Copy link"** button (clipboard API + legacy
  `execCommand` fallback, since most in-app browsers lack the async clipboard).
- **Keep** "Continue as guest" available — anonymous Firebase sign-in does *not*
  hit Google OAuth, so guests can still browse from within the webview. (Confirm
  in QA; if a given webview also blocks anonymous auth, hide it too.)

Everywhere else (the signed-in app, the public `/upload/:token` page) is
unaffected.

### 3.2 Detection (ported from gas-app)

Same permissive UA-marker list as `gas-app/src/ui/templates/login.html` so the
two apps behave identically during/after cutover. A false positive only shows a
helpful note; a false negative strands the user — so we err toward showing it.

Markers (lower-cased UA `includes`): `micromessenger` (WeChat), `wxwork`
(WeCom), `dingtalk`, `qq/`, `qqbrowser`, `weibo`, `lark`, `feishu`, `duolingo`,
`alipay`.

New module `web/src/lib/inAppBrowser.ts` (full code in Appendix A) — a pure,
unit-testable `isInAppBrowser(ua?)` plus a small `<InAppBrowserWarning/>`
component (Appendix B) rendered conditionally from `App.tsx`.

### 3.3 Test consideration

`web/src/App.test.tsx` asserts the sign-in screen shows both "Sign in with
Google" and "Continue as guest". jsdom's default UA contains none of the markers
so `isInAppBrowser()` is `false` there and both buttons render — the existing
test passes unchanged. **Add** one focused test that stubs
`navigator.userAgent` with a WeChat UA and asserts the warning appears and the
Google button is hidden.

---

## 4. Sign-in screen + header polish

Replace the bare `App.tsx` signed-out block with a centered, branded card:

- `.signin-screen` — full-height flex centering container.
- `.signin-card` — `--surface`, `--r-lg`, `--shadow-lg`, max-width ~440px,
  generous padding; collapses to near-edge-to-edge under 480px (mirrors the
  responsive treatment `gas-app` uses).
- Brand mark (inline SVG folder+lens glyph, `--brand-grad`), product title, a
  one-line tagline, then: **Continue as guest** (primary), **Sign in with
  Google** (light, with the Google "G" glyph), and the `signInError` slot.
- When `isInAppBrowser()` → render `<InAppBrowserWarning/>` above the buttons and
  drop the Google button (per §3.1).

Header: same brand mark + title as a home link; nav links restyled as pill
hovers. This is the only change to `App.tsx` (the routing block is untouched).

`index.html`: add the Inter font, a `<meta name="theme-color">`, and keep the
existing `<title>湘舍动公益文件系统</title>`.

---

## 5. Dev plan — milestones

Each milestone is independently shippable and reviewable. Recommended order
puts the zero-conflict, highest-impact CSS work first.

### M1 — Design tokens + base (CSS only) · ~0.5 day
- Add the `:root` token block and base element styles (`body`, `*`,
  `:focus-visible`, `img`, `pre`).
- Refactor existing rules to consume tokens **without changing the visual result
  yet** where possible, then dial in the new palette.
- **Files:** `web/src/styles.css`.
- **Done when:** build is green; every page renders with the new neutrals;
  AdminMetrics inline `--border` now resolves to the token.

### M2 — Component restyle (CSS only) · ~1–1.5 days
- Work through the §2.4 table: buttons, cards, header, badges, tables, photo
  grid + lightbox, toolbars/selects, ref picker, status/spinner, danger zone.
- Re-check the `@media (max-width: 640px)` block against the new spacing.
- **Files:** `web/src/styles.css` only.
- **Done when:** a visual pass of every route (see §7 matrix) looks cohesive;
  no class was renamed (so no `.tsx` needs editing).

### M3 — In-app browser warning · ~0.5 day
- Add `web/src/lib/inAppBrowser.ts` (Appendix A) + test.
- Add `<InAppBrowserWarning/>` (Appendix B); wire it into `App.tsx` sign-in
  block; hide the Google button when detected.
- **Files:** `web/src/lib/inAppBrowser.ts` (new),
  `web/src/lib/inAppBrowser.test.ts` (new), `web/src/App.tsx`,
  `web/src/styles.css` (warning styles).
- **Done when:** stubbed-UA test passes; manual check in a real WeChat/Duolingo
  webview shows the warning and a working Copy-link.

### M4 — Sign-in screen + header + fonts · ~0.5 day
- New `.signin-screen` / `.signin-card` / `.brand-mark` markup in `App.tsx`;
  brand mark in header; Inter + theme-color in `index.html`.
- **Files:** `web/src/App.tsx`, `web/index.html`, `web/src/styles.css`,
  (optional) `web/public/inter-*.woff2`.
- **Done when:** sign-in screen matches §4; `App.test.tsx` still green.

### M5 — Verify & ship · ~0.5 day
- `npm --workspace @cloud-webapp/web run typecheck` (`tsc --noEmit`).
- `npm --workspace @cloud-webapp/web test` (vitest).
- `npm --workspace @cloud-webapp/web run build` (vite).
- Manual device/route matrix (§7); a11y contrast + keyboard pass.
- Deploy preview via Firebase Hosting; spot-check on a phone.

**Total:** ~3–3.5 days, front-loaded into low-risk CSS.

---

## 6. Coordination with the parallel bug-fix threads

The refresh is deliberately structured to **minimize merge conflicts** with
in-flight logic fixes:

- **M1–M2 touch only `styles.css`.** Bug fixes almost never touch the
  stylesheet, and `styles.css` is append/replace-by-selector, so conflicts are
  unlikely and trivial to resolve. Land these first, on their own branch, and
  rebase often.
- **No class renames, no JSX moves.** Because we restyle existing selectors, the
  `.tsx` files are left alone in M1–M2 — exactly the files bug-fix threads are
  most likely editing. This is the key conflict-avoidance lever.
- **M3 is almost all new files** (`inAppBrowser.ts`, its test) plus a small,
  localized edit to the `App.tsx` signed-out block. `App.tsx`'s routing section
  (the part most likely to be touched by a bug fix) is untouched.
- **M4 edits `App.tsx` header + sign-in block and `index.html`.** Coordinate the
  `App.tsx` edits with whoever owns auth/routing fixes; if a thread is mid-flight
  in `App.tsx`, sequence M4 after their merge.
- **Suggested sequencing:** land M1+M2 immediately (safe), hold M3+M4 until the
  bug-fix threads merge or explicitly green-light the `App.tsx` touch.
- Keep each milestone a separate small PR so reviewers can diff CSS vs. logic
  cleanly.

---

## 7. Verification & acceptance

**Automated (must pass before merge):**
- `tsc --noEmit` clean.
- `vitest` green, including the existing `App.test.tsx` and the new
  in-app-warning test.
- `vite build` succeeds; bundle size delta is ~CSS only (no new JS deps).

**Manual route matrix** (desktop + a ~390px phone): sign-in (normal **and**
WeChat/Duolingo UA), Events catalog, Gallery + lightbox, Find Me (ref picker,
results, feedback), My data, Volunteer upload, and the admin pages (Events,
Users, Clubs, Feedback, Metrics, Report, Trash, Audit, Email settings).

**Acceptance criteria:**
1. Every route uses the new tokens (no stray legacy `#2563eb`/`#f7f8fa`).
2. Sign-in screen is a centered branded card; keyboard focus is visible app-wide.
3. In a detected in-app webview: warning shows, Google button hidden, Copy-link
   works, "Continue as guest" still works.
4. No JSX class renames in M1–M2; `App.test.tsx` unchanged and green.
5. AA contrast on all text; `prefers-reduced-motion` honored.

**Cost/perf note (per `CLAUDE.md`):** this is presentation-only and does not
touch how photo bytes are served (still signed GCS URLs), so it has no bearing on
the Hosting-egress concerns. The only added network cost is the font; self-host
woff2 to keep it off the Hosting bill and avoid a third-party request.

---

## Appendix A — `web/src/lib/inAppBrowser.ts`

```ts
/**
 * inAppBrowser.ts — detect embedded in-app webviews (WeChat / DingTalk / QQ /
 * Weibo / Feishu-Lark / Duolingo / Alipay …).
 *
 * Google's "Use secure browsers" policy returns "Error 403: disallowed_useragent"
 * when an OAuth flow runs inside these embedded webviews, so Firebase
 * `signInWithPopup` (and the redirect fallback) hard-fail there. This mirrors the
 * detection that gas-app's login.html does, so the cloud-webapp sign-in screen can
 * surface the same bilingual "open in Safari / Chrome" guidance instead of sending
 * the user to an opaque Google error page.
 *
 * Detection is intentionally permissive — a false positive just shows a helpful
 * note, while a false negative leaves the user stuck on a dead-end error page.
 */

const IN_APP_MARKERS: readonly string[] = [
  'micromessenger', // WeChat
  'wxwork',         // WeCom / 企业微信
  'dingtalk',       // 钉钉
  'qq/',            // QQ
  'qqbrowser',      // QQ Browser
  'weibo',          // Weibo
  'lark',           // Feishu / Lark
  'feishu',
  'duolingo',       // Duolingo in-app browser
  'alipay',         // Alipay / 支付宝
];

/** True when the current UA looks like an in-app webview where OAuth is blocked. */
export function isInAppBrowser(ua: string = getUserAgent()): boolean {
  const s = ua.toLowerCase();
  return IN_APP_MARKERS.some((marker) => s.includes(marker));
}

function getUserAgent(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgent || '';
}
```

### `web/src/lib/inAppBrowser.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { isInAppBrowser } from './inAppBrowser.js';

describe('isInAppBrowser', () => {
  it('flags WeChat / DingTalk / Duolingo UAs', () => {
    expect(isInAppBrowser('Mozilla/5.0 ... MicroMessenger/8.0')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 ... DingTalk/6.5')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 ... Duolingo/6.0')).toBe(true);
  });
  it('passes normal Safari / Chrome UAs', () => {
    expect(isInAppBrowser('Mozilla/5.0 ... Version/17 Safari/605')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 ... Chrome/124 Safari/537')).toBe(false);
  });
});
```

## Appendix B — `<InAppBrowserWarning/>` (for `web/src/App.tsx`)

```tsx
import { useState } from 'react';

/**
 * Bilingual in-app-browser warning. Sign-in screen only. Google blocks OAuth in
 * embedded webviews (403 disallowed_useragent), so steer the user to Safari /
 * Chrome. Mirrors gas-app/src/ui/templates/login.html.
 */
export function InAppBrowserWarning(): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

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
        <span>无法在当前浏览器登录 / Sign-in not available here</span>
      </div>
      <p>
        您正在微信 / 钉钉 / QQ / Duolingo 等 App 的内置浏览器中打开此页面，Google 出于安全原因会拒绝登录（错误
        403：disallowed_useragent）。
        <br />
        You opened this page inside an app&rsquo;s in-app browser (e.g. WeChat,
        Duolingo). Google blocks sign-in here for security reasons (Error 403:
        disallowed_useragent).
      </p>
      <p className="inapp-howto">解决方法 / How to fix:</p>
      <ol>
        <li>点击右上角「···」菜单 — Tap the <strong>“···”</strong> menu in the top-right corner</li>
        <li>
          选择「在 Safari 中打开」或「在浏览器中打开」 — Choose <strong>“Open in Safari”</strong> (iPhone)
          or <strong>“Open in Browser”</strong> (Android)
        </li>
        <li>
          建议使用<strong>无痕 / 隐身模式</strong>登录 — Sign in using a{' '}
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
          复制链接 / Copy link
        </button>
        {copied === 'ok' && <span className="copy-status">已复制 / Copied</span>}
        {copied === 'fail' && (
          <span className="copy-status copy-status-fail">复制失败，请长按选择 / Long-press to select</span>
        )}
      </div>
    </div>
  );
}
```

### Wiring in `App.tsx` (signed-out block)

```tsx
// near the top of App():
const [inApp] = useState(() => isInAppBrowser());

// replace the current signed-out <div className="consent-card signin-card"> with:
<div className="signin-screen">
  <div className="signin-card">
    <span className="brand-mark brand-mark-lg" aria-hidden="true">{/* SVG glyph */}</span>
    <h2>Event Photo Database</h2>
    <p className="muted">Browse event photos and find yourself with Find&nbsp;Me.</p>

    {inApp && <InAppBrowserWarning />}

    <button className="btn btn-primary" onClick={() => void guest()}>Continue as guest</button>
    {!inApp && (
      <button className="btn btn-light btn-google" onClick={() => void signInWithGoogle()}>
        {/* Google G glyph */} Sign in with Google
      </button>
    )}
    {signInError && <p className="error-text">{signInError}</p>}
  </div>
</div>
```

## Appendix C — warning + sign-in CSS (add to `styles.css`)

```css
/* ── Sign-in screen ─────────────────────────────────────────────────────── */
.signin-screen {
  min-height: 70vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}
.signin-card {
  width: 100%;
  max-width: 440px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  padding: 36px 32px;
  display: grid;
  gap: 14px;
  text-align: center;
}
.signin-card h2 { margin: 4px 0 0; font-size: 22px; }
.brand-mark {
  display: inline-flex; width: 28px; height: 28px; color: var(--primary);
}
.brand-mark-lg {
  width: 56px; height: 56px; margin: 0 auto;
  padding: 12px; border-radius: var(--r-md);
  background: var(--primary-weak); color: var(--primary);
}
.btn-google { display: inline-flex; align-items: center; justify-content: center; gap: 10px; }

/* ── In-app browser warning ─────────────────────────────────────────────── */
.inapp-warning {
  text-align: left;
  background: var(--warn-bg);
  border: 1px solid #f0c98a;
  border-left: 6px solid var(--warn);
  border-radius: var(--r-md);
  padding: 16px 18px;
  color: #7c3a06;
  line-height: 1.6;
  font-size: 14px;
}
.inapp-title {
  display: flex; align-items: center; gap: 8px;
  font-weight: 800; font-size: 16px; color: #9a3412; margin-bottom: 8px;
}
.inapp-howto { font-weight: 700; margin: 8px 0 4px; }
.inapp-warning ol { margin: 6px 0 6px 20px; padding: 0; }
.inapp-warning li { margin: 4px 0; }
.inapp-divider { border: 0; border-top: 1px dashed #f0c98a; margin: 12px 0; }
.copy-link-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.copy-link-btn {
  background: var(--warn); color: #fff; border: none; border-radius: var(--r-sm);
  padding: 9px 16px; font-size: 14px; font-weight: 700; cursor: pointer;
}
.copy-status { font-size: 13px; font-weight: 700; color: var(--success); }
.copy-status-fail { color: var(--danger); }

@media (max-width: 480px) {
  .signin-card { padding: 28px 20px; border-radius: var(--r-md); }
}
```

---

## 8. Open questions

1. **Inter delivery:** self-host woff2 (preferred per cost posture) vs. Google
   Fonts `<link>` (simpler). Default to self-host unless told otherwise.
2. **Guest button inside webviews:** confirm anonymous Firebase auth actually
   succeeds inside WeChat/Duolingo; if any webview blocks it, hide it there too.
3. **Brand mark:** ship the inline-SVG folder+lens placeholder, or is there an
   existing 湘舍动 logo asset to drop in?
4. **Dark mode:** confirm out of scope for this pass (seam left in tokens).
