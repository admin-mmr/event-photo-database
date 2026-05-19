# UX Assessment + Google Cloud Migration Recommendation

**Project:** 湘舍动公益文件系统 (Event Photo Database)
**Prepared for:** IT Department, Youth4AM / mmrunners
**Date:** May 19, 2026
**Scope:** Two reported UX issues (mobile login card, action-card clickability) + feasibility and cost of moving off Google Apps Script to Google Cloud Platform under the nonprofit credit program.

---

## TL;DR

| Item | Finding | Action taken |
|---|---|---|
| Login card "not full-screen on mobile, have to expand" | Root cause is the Apps Script outer wrapper (`script.google.com`) missing a viewport meta tag. The inner template's `<meta name="viewport">` doesn't reach the outer iframe host. | Added `.addMetaTag('viewport', 'width=device-width, initial-scale=1')` to every `HtmlOutput` builder; added a `@media (max-width: 480px)` block that turns the login card into a full-screen layout on phones. |
| Action cards "not clearly clickable" | Default chevron color was `#9fa8da` (too light); hover-only affordances (lift, color shift) never fire on touch devices, so mobile users had no static clickability cue. | Darkened the chevron to match the accent stripe, added a soft circular icon background that fills on hover, added a tactile `:active` press-down state for touch, exposed a reusable `.tile-open-pill` for templates that want an even louder "Open →" affordance. |
| Should we move to Google Cloud? | Yes — and at this org's scale the **$10,000/year GCP nonprofit credit covers the realistic monthly cost roughly 50× over**. The bigger wins are architectural: no more `script.google.com` iframe, no more 6-minute execution cap, real custom domain, faster cold starts, proper CI/CD. | Recommendation and cost bands below. |
| Hidden gotcha for the migration | The Google Photos Library API scopes (`photoslibrary.readonly`, `.sharing`) were **removed March 31, 2025**. Any feature that reads shared albums has to be redesigned around the Picker API or by moving photos into Cloud Storage. | Flagged below; scope this before committing to a migration timeline. |

---

## 1. UX Assessment

### 1.1 Issue: Login card is not full-screen on mobile; users have to pinch-zoom

**Where it lives:** `gas-app/src/ui/templates/login.html` (lines 16–31 for the layout, 1–13 for the head). The card already has a `<meta name="viewport" content="width=device-width, initial-scale=1.0">` tag, `width: 100%`, `max-width: 440px`, and `min-height: 100vh` on the container.

**Why "good viewport meta + width: 100%" still rendered tiny on phones.** Apps Script web apps are served as a *nested* iframe: the user navigates to `script.google.com/macros/s/.../exec`, that outer page is built by Google and contains an iframe to `<id>.script.googleusercontent.com` which is where our `login.html` actually renders. **A viewport meta tag inside the inner iframe has no effect on the outer document** — the outer page is the one the mobile browser uses to compute the layout viewport. With no viewport directive on the outer page, mobile browsers fall back to a ~980 CSS-pixel desktop layout viewport, the inner iframe gets squeezed into a fraction of that, and users see a doll-house version of the page until they pinch-zoom.

This is one of the most-reported Apps Script papercuts and the canonical fix is server-side: call `.addMetaTag('viewport', ...)` on the `HtmlOutput` returned by `doGet`. That call **injects the viewport meta into the outer `script.google.com` wrapper page**, not just the inner iframe.

**Fix applied (server-side, every page):** `gas-app/src/routes/pageRoutes.ts → renderTemplate()`. Same fix replicated in `volunteerRoutes.ts → renderVolunteerTemplate()` and in the two inline `HtmlService.createHtmlOutput(...)` builders inside `router.ts` (OAuth-callback "signed in" interstitial + healthcheck page) so the entire app gets device-width rendering on phones.

```ts
return template
  .evaluate()
  .setTitle('湘舍动公益文件系统')
  .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
  // NEW — applies viewport to the OUTER script.google.com wrapper page.
  .addMetaTag('viewport', 'width=device-width, initial-scale=1');
```

**Fix applied (client-side, login layout):** the existing card had `padding: 40px 48px` and `max-width: 440px` which is fine on tablets but cramped on a 320px iPhone SE viewport. I added a mobile-only block that makes the login card behave like a full-screen page on phones (edge-to-edge, no shadow, vertical-centered content), which matches the platform conventions users expect from a sign-in screen:

```css
@media (max-width: 480px) {
  .login-container { padding: 0; align-items: stretch; }
  .login-card {
    max-width: 100%;
    min-height: 100vh;
    border-radius: 0;
    box-shadow: none;
    padding: 28px 20px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
}
```

**How to verify after deploy.** Open the deployment URL on a phone (or DevTools mobile emulation). Before the fix, the entire card sits inside a roughly half-width column and content text wraps tightly. After the fix, the card fills the screen, "Sign in with Google" is a full-width tappable button, and the in-app browser warning banner reads at a comfortable 16px without zoom.

### 1.2 Issue: Action cards (dashboard tiles) don't look clickable

**Where it lives:** `.tile` class in `gas-app/src/ui/css/styles.html` lines 184–257; consumed by the quick-action grid in `dashboard.html` lines 161–232.

**Why the existing tiles read as info panels, not buttons.** The pre-fix tile had three affordances and all three were hover-only:

1. `transform: translateY(-2px)` lift on `:hover`
2. `box-shadow` intensification on `:hover`
3. `chevron` color shift from `#9fa8da` (very light indigo) to `#3f51b5` on `:hover`

On a desktop with a pointing device that's fine. On a phone — which is where most volunteers actually use this — there is no `:hover` event, so users see only the static state: a white card with a thin gray border, a very light chevron that reads as decorative, and no other "tap me" cue. The card was effectively static for the majority audience.

**Fix applied** (`styles.html`, `.tile` block rewritten):

- **Chevron color** changed from `#9fa8da` → `#3f51b5` so the arrow now reads as a navigation cue even at rest.
- **Icon now sits in a soft `#e8eaf6` circular background** that becomes filled indigo on hover/focus. The static state already signals "this is an icon button," matching how Material You and modern Drive UI present action tiles.
- **`:active` state** (which fires on touch) now lowers the card and shifts the background to `#eef0ff` — gives touch users the same "I tapped something" feedback desktop users get from `:hover`.
- **Heavier border** (`1.5px solid #c5cae9` + `5px` indigo left stripe vs. the previous gray border) so the card reads as a distinct button at first glance.
- **`-webkit-tap-highlight-color: transparent`** to suppress the iOS blue tap-rectangle since we now provide a deliberate `:active` style.
- **`:focus-visible`** ring for keyboard users (no ring on mouse click).
- **Mobile min-height (72px)** + smaller icon — ensures every tile clears the 44pt tappable-target guideline even on a 320px-wide screen.
- **Optional `.tile-open-pill`** — an indigo capsule with "Open →" that templates can drop in for tiles where extra emphasis helps (e.g. high-stakes admin actions). Defined in CSS but not added to every tile by default, so it stays available without making the dashboard feel like every tile is screaming for attention.

The card structure in `dashboard.html` did not need to change — the new styles attach to the existing `.tile`, `.tile-icon`, `.tile-chevron` classes.

### 1.3 Lower-priority UX items I noticed but did not fix

These came up while reading the code. Recording here so the team can decide whether to schedule them:

- **Welcome banner gradient** (`dashboard.html` lines 88–101) uses inline styles instead of a class. Hard to theme later; consider extracting.
- **Nav dropdown opens via JS `ResizeObserver`** (clever) but on slow Android phones the first-load nav can flicker between inline and collapsed. A pure-CSS `@media (max-width: 768px)` fallback would prevent that.
- **Build stamp on login page** (lines 282–288) is visible to unauthenticated users. Fine for now, but if the system ever exposes anything sensitive in the commit hash, lock it behind admin.
- **In-app browser warning banner** (lines 188–214) is excellent — well-localized, helpful, and uses red/orange contrast that reads as a real warning. Worth holding up as a model for future warning UIs.

---

## 2. Google Cloud Migration Recommendation

### 2.1 Nonprofit credit program (2026 figures)

Verified 501(c)(3) nonprofits (and international equivalents) qualify for **up to $10,000/year in Google Cloud credits**, allocated as an annual calendar-year budget. The credit is applied automatically against most GCP SKUs once granted, doesn't roll over, and isn't subject to per-product caps inside the $10k. Validation is now run through Goodstack (TechSoup remains a parallel path in some countries) and typically takes 2–14 business days; once validated, the GCP credit grant itself is approved in roughly 3 business days.

Google Workspace for Nonprofits is **fully separate from the GCP credit** and remains free (Gmail, Drive, Docs, Sheets, 100 TB pooled storage, up to 2,000 seats, Gemini + NotebookLM included). Using your free Workspace doesn't burn any of the $10k.

Apply: [google.com/nonprofits](https://www.google.com/nonprofits) → after Goodstack/TechSoup verification, request Cloud credits at the [Google for Nonprofits Cloud credit page](https://support.google.com/nonprofits/answer/16245748).

### 2.2 Service mapping — what each Apps Script piece would become on GCP

| Today (Apps Script) | GCP replacement | 2026 free tier | Est. cost at this org's scale |
|---|---|---|---|
| HTML served via `doGet()` | **Firebase Hosting** (preferred over raw GCS+CDN — simpler, free TLS, custom domain) | 10 GB storage, 360 MB/day egress | **$0** |
| `doPost` + business logic in TypeScript | **Cloud Run** (preferred over Cloud Functions in 2026 — Functions is now branded "Cloud Run Functions" with the same billing) | 2M requests, 360k GiB-sec memory, 180k vCPU-sec, 1 GB egress/mo | **$0–$2/mo** |
| Google Sheets as system-of-record | **Firestore** (recommended — serverless, document-shaped, similar mental model to a sheet) | 50k reads, 20k writes, 20k deletes, 1 GB storage / day | ~10k reads/day → 300k/mo → **~$0.15/mo**. Cloud SQL `db-f1-micro` is a heavier alternative at ~$10/mo. Sheets-as-DB stays free but keeps you behind the 6-min Apps Script cap. |
| `Session.getActiveUser()` + custom email allowlist | **Firebase Auth** (auto-upgrades to Identity Platform when needed) | 50,000 MAU free | **$0** (you have ~50 active users) |
| Drive folder for assets | **Cloud Storage** Standard | 5 GB-month us-region | 100 GB stored = $2/mo @ $0.020/GB; internet egress is $0.12/GB and is the line item to watch |
| Google Photos integration | **⚠️ Picker API only** — the Library API scopes (`photoslibrary.readonly`, `.sharing`) were removed **March 31, 2025**. Apps can only see media they themselves uploaded. **This is a real blocker** for any feature today that reads shared albums. | n/a | The cost isn't dollars, it's redesign work. Detail below. |

### 2.3 Realistic monthly cost

Sized for ~50 active users, mostly read-heavy, ~10k DB reads/day, ~100 GB photo storage:

| Scenario | Without nonprofit credit | With $10k/yr credit |
|---|---|---|
| **Low** — Firestore + Firebase Hosting + Cloud Run; photos stay in Google Photos via Picker | **$3–6/mo** | **$0** (credit covers ~150 years) |
| **Mid** — same plus 100 GB in Cloud Storage replacing Photos for primary serving + modest egress | **$10–18/mo** | **$0** |
| **High** — Cloud SQL Postgres instead of Firestore, regular thumbnail re-serves, occasional bulk export | **$25–45/mo** | **$0** |

The $10k/yr credit ceiling is $833/mo — roughly 25–50× the realistic spend, so it absorbs even a misconfiguration spike. That said: **set a hard budget alert at $50/mo and cap Cloud Run max-instances at e.g. 10**. Egress is the historic source of nonprofit "billing surprise" stories on Reddit and Hacker News, and Google doubled peering egress on May 1, 2025.

### 2.4 What materially improves vs. Apps Script

- **The mobile-iframe problem disappears.** Once you're not behind `script.google.com`, your own viewport meta tag works as written — no need for the workaround we just shipped.
- **The 6-minute execution cap goes away.** Cloud Run defaults to a 60-minute request timeout, with Cloud Run Jobs supporting up to 24 hours. The "rebuild reconciliation report" and "scan Drive folder tree" jobs the codebase already has stop being a fight against the clock.
- **Custom domain.** `photos.mmrunners.org` instead of a 50-character `script.google.com/macros/...` URL. Free TLS. Vastly more legitimate-looking to volunteers and partner clubs.
- **Cold start drops from ~2–5 seconds (Apps Script) to ~200–800 ms** on warm Cloud Run. Login feels instantaneous.
- **Real deployment workflow.** `gcloud run deploy` from GitHub Actions, with rollbacks, staging environments, and PR preview URLs. The `clasp push`-then-pray loop the team uses today is replaced by a normal release pipeline.
- **Observability.** Cloud Logging, Error Reporting, Cloud Trace, and Cloud Profiler are first-class. Apps Script's logging is functional but thin in comparison.

### 2.5 What gets harder, costs more, or carries risk

- **Ops burden.** Someone owns IAM, billing alerts, service accounts, secret rotation, and CI/CD. Apps Script needs none of that. At a volunteer-staffed nonprofit, factor this into the sustainability calculation — make sure at least two people on the team are comfortable in the GCP console before cutting over.
- **No built-in `SpreadsheetApp` / `DriveApp` / `GmailApp` shortcuts.** Every Drive/Sheets/Gmail call becomes an authenticated REST or SDK call with explicit scopes, quotas, and retry handling. The Apps Script convenience tax is real and it goes away here.
- **Billing-surprise vector: egress.** Cloud Storage internet egress at $0.12/GB plus the May 2025 peering-egress doubling means careless full-resolution photo serving can balloon. Always serve user-facing photo content through a signed-URL + CDN combo, or keep Google Photos as the actual serving layer with GCS only for thumbnails.
- **Photos API blocker (most important).** The current app integrates with shared albums via `routes/photosHandlers.ts` and `services/photosService.ts` — if those rely on Library API scopes (`photoslibrary.readonly`, `.sharing`), they stop working as designed on any account once the org migrates because Google revoked those scopes for third-party apps on March 31, 2025. **Before scoping a migration timeline, an engineer should spend a day mapping every use of the Photos API and confirming whether each one can move to (a) the Picker API, (b) Cloud Storage as the photo home, or (c) a hybrid where Photos stays as the canonical store but the app no longer needs to *enumerate* shared albums.** This is the single item that could turn a "weekend port" into a real redesign.
- **Need real auth.** Apps Script piggybacks on Google's login for free. Firebase Auth + email allowlist is the natural replacement and the wiring is well-documented, but it's a new system to configure.

### 2.6 Recommended migration order (if the team decides to go)

1. **File Photos-API blocker first.** Confirm the redesign cost — this gates everything.
2. **Apply for Google for Nonprofits** through Goodstack if not already verified. Request the $10k Cloud credit at the same time.
3. **Stand up Firebase Hosting + Cloud Run + Firestore in parallel with the live Apps Script app.** Move the read-only paths (dashboard, drive tree, public album index) first. Keep Apps Script as the system of record.
4. **Migrate write paths (admin pages, upload links, audit log).** Mirror writes to both backends for a week to catch parity bugs.
5. **Cut over auth and DNS.** Point the new custom domain at Cloud Run. Decommission Apps Script.
6. **Keep Workspace for Nonprofits** for Gmail/Drive/Sheets-as-spreadsheet-tools. The decommission is only of the Apps Script *web app*, not of the org's Workspace.

Realistic timeline at typical volunteer-team velocity: **6–10 weeks of part-time work**, plus whatever the Photos-API scoping reveals.

---

## 3. Code changes summary

| File | Change |
|---|---|
| `gas-app/src/routes/pageRoutes.ts` | Added `.addMetaTag('viewport', 'width=device-width, initial-scale=1')` to `renderTemplate()` — fixes mobile rendering for every page that uses HtmlTemplate (login, dashboard, drive tree, every admin page). |
| `gas-app/src/routes/volunteerRoutes.ts` | Same viewport meta added to `renderVolunteerTemplate()` (volunteer upload flow) and to the inline OAuth interstitial. |
| `gas-app/src/routes/router.ts` | Same viewport meta added to the OAuth-callback "signed in" interstitial and to the healthcheck page. |
| `gas-app/src/ui/templates/login.html` | Added `@media (max-width: 480px)` block making the login card full-screen on phones; added `padding: 16px` + `box-sizing: border-box` to the container so the card has breathing room on mid-size devices. |
| `gas-app/src/ui/css/styles.html` | Rewrote `.tile` and related classes: darker chevron, soft circular icon background that fills on hover, `:active` press-down for touch, heavier border, `focus-visible` ring, mobile min tap height, suppressed iOS tap highlight, new optional `.tile-open-pill` for templates that want a louder "Open →" affordance. |

After deploying, no template markup changes are needed — both fixes attach to existing classes.

---

## Sources

- [About Google Cloud Credits — Google for Nonprofits Help](https://support.google.com/nonprofits/answer/16245748)
- [Google for Nonprofits eligibility (US)](https://support.google.com/nonprofits/answer/3215869)
- [Google Workspace Offers for Nonprofits](https://www.google.com/nonprofits/workspace/compare/)
- [Firebase Pricing (Spark vs Blaze)](https://firebase.google.com/pricing)
- [Firebase Hosting usage, quotas & pricing](https://firebase.google.com/docs/hosting/usage-quotas-pricing)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing)
- [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
- [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
- [Updates to the Google Photos APIs (Mar 2025 Library API restrictions)](https://developers.google.com/photos/support/updates)
- [Google Photos Picker API launch announcement](https://developers.googleblog.com/en/google-photos-picker-api-launch-and-library-api-updates/)
- [Apps Script quotas (6-min execution limit)](https://developers.google.com/apps-script/guides/services/quotas)
- [GCP egress pricing increases — May 2025](https://akave.com/blog/google-cloud-is-doubling-its-peering-egress-rates-on-may-1)
- [Apps Script `HtmlOutput.addMetaTag` reference](https://developers.google.com/apps-script/reference/html/html-output#addmetatagname,-content)
