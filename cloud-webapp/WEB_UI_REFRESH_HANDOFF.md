# WEB_UI_REFRESH_HANDOFF.md — status note

**Updated:** 2026-06-23 · scope: `cloud-webapp/web` only · branch: `main`

> **STATUS: COMPLETE (pending commit).** The mobile-first refresh + full EN/中文
> toggle migration is finished. `tsc --noEmit` is clean, the full vitest suite
> passes (79 tests across App, FeedbackAdmin, MyData, Pager, i18n, inAppBrowser,
> and the 9 lib suites), and `vite build` compiles (87 modules; CSS 19.5 kB /
> 4.6 kB gzip). The working-tree edits are **not yet committed** — review the
> diff and commit. The history below is retained as a record of the work.
>
> Note: `vite build` into the existing committed `dist/` hits an `EPERM` when
> wiping old assets on this mounted filesystem — build to a clean dir (or `rm
> -rf dist` first). Not a code issue.

Companion to `WEB_UI_REFRESH_DEV_PLAN.md`. This captures exactly what is DONE vs.
LEFT for the mobile-first refresh + full EN/中文 toggle.

## Where things stand

Working tree is **clean** — all work below is **committed** on `main`. Relevant
recent commits:

- `6349cde` web: EN/中文 language toggle across guest UI + Find Me fixes
- `e4c100c` web: M4 ZH localization (bilingual EN · 中文 across the UI)
- `633c3d2` new dev plan

`npm run typecheck` (tsc --noEmit) is **clean** as of the pause. The full
`npm test` run had **not** been confirmed end-to-end (sandbox timed out before
it finished) — re-run it first thing on resume (see Verification below).

## Done

- **Design system / mobile-first CSS** — `web/src/styles.css` fully rewritten
  phone-first with `:root` tokens (palette, type, radius, shadow, motion,
  safe-area insets); `@media (min-width: 768px)` enhances for desktop. (~1547
  lines now; team added to it after the initial rewrite.)
- **Fonts / meta** — `web/index.html` loads Inter via Google Fonts (preconnect +
  `display=swap`) and sets `theme-color` + `viewport-fit=cover`.
- **i18n core** — `web/src/lib/i18n.tsx`: `Lang`, `detectDefaultLang()`,
  `LanguageProvider`, `useLang()`, `useStrings(catalog)`, `LangToggle`. Defaults
  from `navigator.language` (`zh*` → 中文), persists to `localStorage`
  (`eulb.lang`). `useStrings` safely defaults to **English with no provider**, so
  unit tests that render a component bare get English. Wrapped at root in
  `main.tsx`. Test: `web/src/lib/i18n.test.tsx`.
- **In-app browser warning** — `web/src/lib/inAppBrowser.ts`
  (`isInAppBrowser`, `isWeChat`) + test; `web/src/components/InAppBrowserWarning.tsx`.
  Rendered on the sign-in screen; hides the Google button in a webview. This
  component is **intentionally always bilingual** (中文 + English) regardless of
  the toggle — do NOT migrate it. WeChat is the most common entry point.
- **Sign-in screen + sticky header + toggle** — `web/src/App.tsx`: sticky header
  with inline-SVG `BrandMark`, `LangToggle`, branded `.signin-card`, i18n nav.
- **Migrated to the toggle (single-language via `useStrings`):** `App.tsx`;
  components `LoadMore`, `SortSelect`, `PageSizeSelect`, `SelectBar`, `Pager`,
  `Lightbox`; pages `Events`, `Gallery`, `MyData`, `FindMe`.

## Left to do (resume here)

### 1. Finish the i18n migration — these files still use inline `· 中文` dual labels
Migrate each to the co-located catalog pattern (see "Pattern" below):

- `web/src/pages/VolunteerUpload.tsx`
- `web/src/pages/EmailPrefs.tsx`
- `web/src/pages/FeedbackAdmin.tsx`  **(+ update `FeedbackAdmin.test.tsx`)**
- Admin pages (all have tables → also need step 2): `AdminUsers.tsx`,
  `AdminClubs.tsx`, `AdminEvents.tsx`, `AdminLinks.tsx`, `AdminAudit.tsx`,
  `AdminMetrics.tsx`, `AdminSummary.tsx`, `DeletedFiles.tsx`
- `web/src/pages/FindMe.tsx` still shows a few `·` — these are **band-label ·
  percentage** formatting separators, NOT dual labels. Verify, then leave.
- `web/src/components/InAppBrowserWarning.tsx` — leave bilingual (by design).

### 2. Portrait tables — add `data-label` attrs (M2)
The stacked-card CSS already exists in `styles.css` (phones hide `<thead>` and
render each `<td>`'s column name via `content: attr(data-label)`; classic table
returns at ≥768px). For every `<td>` in a `.data-table` body row in the admin
pages + `FeedbackAdmin`, add `data-label={t.<sameLabelAsTheColumnHeader>}`. Do
NOT add `data-label` to full-width actions/empty cells. Without this, those
tables show unlabeled values when stacked on a phone.

### 3. Verification (M5)
From `cloud-webapp/web`:
- `npm run typecheck`  (tsc --noEmit)
- `npm test`           (vitest — confirm full run; sandbox timed out at pause)
- `npm run build`      (vite)
Manual portrait-phone pass of every route; confirm no table scrolls sideways and
no stray legacy hex remains.

## Migration pattern (apply per file)

```tsx
import { useStrings } from '../lib/i18n.js';      // pages & components are 1 level under src/

const STR = {
  en: { title: 'Users', save: 'Save', count: (n: number) => `${n} users` },
  zh: { title: '用户',   save: '保存', count: (n: number) => `${n} 个用户` },
};

function AdminUsers() {
  const t = useStrings(STR);            // top of body with the other hooks; never conditional
  // `Foo · 福` → {t.foo};  English-only 'Save' → {t.save};
  // interpolated `${n} users` → function entry t.count(n)
  // localize aria-label / title / placeholder / alt too
}
```

### Hard rules
- **`en` values MUST equal the current English text exactly** (words, casing,
  punctuation) — existing tests assert English substrings.
- **`zh` values reuse the Chinese half of the existing `· 中文` labels verbatim**
  where present; otherwise translate naturally.
- Strings only — no logic / JSX-structure / className / props / route / hook-order
  changes; don't touch fetch URLs, API field names, `console.*`, or comments.
- `en`/`zh` objects must have identical key shapes and matching value types.

### Tests that assert OLD bilingual strings (update to English-only when migrating)
Because migrated pages render single-language (English by default in tests):
- `FeedbackAdmin.test.tsx` — e.g. `Wrong match · 匹配错误` → `Wrong match`,
  `That's me · 是我` → `That's me`.
- (`MyData.test.tsx` was handled with the MyData migration — confirm it's green.)
Change only the asserted string literals; keep all other test logic identical.

## Suggested resume order
1. Re-run `npm test` to confirm the committed baseline is green.
2. Migrate the admin pages (i18n + `data-label`) — they're the bulk and similar
   to each other; can be parallelized one file per worker (distinct files, no
   conflicts).
3. Migrate `VolunteerUpload`, `EmailPrefs`, `FeedbackAdmin` (+ its test).
4. Run typecheck → test → build; fix fallout.
