# Development Plan — Migrate gas-app Functions into cloud-webapp (then azure-webapp)

**Project:** 湘舍动公益文件系统 (Event Photo Database)
**Prepared for:** IT Department, Youth4AM / mmrunners
**Date:** June 21, 2026
**Status:** Draft for review
**Builds on:** `cloud-webapp/` (live), `gas-app/` (current control plane), `azure-webapp/` (migration target), `Azure_Migration_Plan.docx`, `FACE_MATCHING_DEV_PLAN.md`, `STORAGE_AND_DATABASE_OPTIONS.md`

---

## 0. How to read this plan

The goal: **make `cloud-webapp` the complete system** so the Google Apps Script app (`gas-app`) can be retired, then carry that same feature set to `azure-webapp`. Volunteer photo upload already works in `cloud-webapp` — this plan covers everything else that still lives only in `gas-app`.

It is organized as: current ownership map → a feature-by-feature gap analysis → the one architectural decision everything hinges on (Sheets → Firestore) → a phased, ticket-level build sequence (milestones **G0–G6**) → Azure forward-compatibility rules → what to retire. Every ticket names concrete files so an engineer can start without guessing.

### 0.1 Locked decisions for this plan

- **D1 — cloud-webapp first, Azure second.** All new development lands in `cloud-webapp` (GCP). Once feature-complete and stable, port to `azure-webapp` per `Azure_Migration_Plan.docx` (SDK swaps only, no new features). Do **not** build features twice.
- **D2 — The Google Sheet stays the source of truth (SSOT) for control-plane data.** *(Confirmed by Cathy, 2026-06-21.)* The Sheet is human-viewable by anyone with the link and lives in **Google Workspace — the one layer that does not move when compute migrates GCP→Azure.** So we anchor data there. To retire `gas-app` we move the *write* paths (create/update user, club, event, link) into `cloud-webapp` via the **Sheets API (DWD auth, already used in `sheetsService.ts`)**. Firestore stays a **derived read cache/index** kept in sync from the Sheet — today's `reconcileService.ts` direction is preserved, just extended. **No SSOT flip, no risky one-shot import, no second database of record.**
- **D3 — Drive stays the photo SSOT.** Consistent with `FACE_MATCHING_DEV_PLAN.md` D6 and the Azure plan's recommended scope. Originals live in Drive; `cloud-webapp` mirrors derivatives to Cloud Storage for serving. **Google Workspace (Drive + Sheets) is the fixed substrate across both clouds** — we are not migrating it.
- **D4 — Keep Firebase Auth on GCP.** Auth is cloud-agnostic and already wired. The Entra/MSAL swap is an Azure-phase concern only (`Azure_Migration_Plan.docx` §3), not part of the gas-app retirement.
- **D5 — Retire, don't port, what the new model makes obsolete.** The public-index Google Sheet, Drive `Photos_NNN` shortcut consolidation, the upload-prep sidebar, and Photos-Library-API code are superseded by the Cloud Storage gallery + indexer. See §7.
- **D6 — Every new module must be data-layer-portable.** No GCP SDK calls scattered through route handlers; go through the existing service adapters (`firestore.ts`, `gcsService.ts`) so the Azure swap stays mechanical. See §6.

---

## 1. Current state — who owns what (June 2026)

Three apps share one Google Drive (photo SSOT) and, today, one Google Sheet (control-plane SSOT).

| App | Stack | Role today |
|---|---|---|
| **gas-app** | Apps Script + Sheets + Drive | **Control plane.** Admin UI for users/clubs/events/links, email, audit, duplicates, reporting, partner REST API. Sheets = database. |
| **cloud-webapp** | React + Cloud Run + Firestore + GCS + Firebase | **Public + Find Me plane.** Volunteer upload, gallery, downloads, Find Me search, indexing, event *read* sync. Live and production-ready for these flows. |
| **azure-webapp** | Container Apps + Cosmos + Blob + Entra | **Future target.** Infra scripts + full code structure ported; data-layer SDKs (Firestore→Cosmos, GCS→Blob) **not yet swapped** (~40% done per `AZURE_MIGRATION_PROGRESS.md`). |

The seam: `cloud-webapp` reads events/links from the Sheet that `gas-app` writes. **gas-app cannot be retired until those write paths move into cloud-webapp.**

---

## 2. Gap analysis — gas-app feature → cloud-webapp status

Legend: ✅ done in cloud-webapp · 🟡 partial · ❌ gas-app only (must migrate) · 🗑️ retire (don't port)

| # | gas-app feature | Files (gas-app) | cloud-webapp status | Action |
|---|---|---|---|---|
| 1 | Google OAuth login / session | `authService.ts`, `sessionService.ts` | ✅ Firebase Auth | none |
| 2 | **User management** (CRUD, roles, club assignment) | `userService.ts`, `userHandlers.ts` | ❌ only `ADMIN_EMAILS` allowlist | **migrate (G2)** |
| 3 | **Club management** (CRUD, activate) | `clubService.ts`, `eventHandlers.ts` | ❌ | **migrate (G2)** |
| 4 | **Event creation + Drive folder provisioning** | `eventService.ts`, `specialFoldersService.ts` | 🟡 reads events from Sheet; no create/folder-gen | **migrate (G3)** |
| 5 | **Upload-link generate / rotate / revoke** | `uploadLinkService.ts`, `linkHandlers.ts` | 🟡 validates tokens (reads Sheet); no mgmt | **migrate (G3)** |
| 6 | Volunteer upload (public link) | `volunteerRoutes.ts` | ✅ resumable GCS + async queue | none |
| 7 | Admin authenticated upload | `uploadHandlers.ts` | 🟡 volunteer path covers it | confirm parity (G3) |
| 8 | **Email notifications** (alerts + digests + prefs) | `emailService.ts`, `emailTemplates.ts`, `emailTriggers.ts` | ❌ | **migrate (G4)** |
| 9 | **Audit log** (9 categories, search, CSV export) | `auditLogService.ts`, `reportHandlers.ts` | 🟡 Firestore audit for Find Me/admin only | **migrate/extend (G4)** |
| 10 | **Duplicate cleanup lifecycle** (soft-delete/restore/purge) | `duplicateCleanupService.ts`, `deleteService.ts` | 🟡 indexer dedups by hash; no restore UI | **migrate (G5)** |
| 11 | **Summary & reporting** (CSV) | `summaryService.ts` | 🟡 `/api/metrics` placeholder | **migrate (G5)** |
| 12 | **Partner REST API** (rate-limited upload) | `apiClientHandlers.ts`, `rateLimitService.ts` | ❌ | **migrate (G5)** |
| 13 | RBAC: club-scoping + masquerade | `roleGuard.ts`, `authMiddleware.ts` | 🟡 admin/non-admin only | **migrate (G2)** |
| 14 | Input validation / EXIF strip | `inputValidator.ts`, `exifStripper.ts` | ✅ Zod + indexer | none |
| 15 | Cloud Run image conversion | `cloudRunClient.ts` → `cloud-run/` | ✅ indexer derivatives | none |
| 16 | Public folder index (Google Sheet) | `publicSpreadsheetService.ts` | 🗑️ gallery replaces it | **retire (§7)** |
| 17 | Special folders `Photos_NNN`/`Videos`/`Album` (Drive) | `specialFoldersService.ts`, `driveShortcutClient.ts` | 🗑️ GCS gallery replaces serving role | **retire serving; keep Drive archive (§7)** |
| 18 | Upload-prep sidebar (batch convert) | `uploadPrepRoutes.ts` | 🗑️ superseded by indexer | **retire (§7)** |
| 19 | Photos-Library-API sharing workaround | `drivePermissionsService.ts`, `PUBLIC_SHARING.md` | 🗑️ obsolete (API deprecated 2025-03) | **retire (§7)** |

**Net new build in cloud-webapp:** items 2, 3, 4, 5, 8, 9, 10, 11, 12, 13. Everything else is already done or should be retired.

---

## 3. Architecture — give cloud-webapp the Sheet write paths

Per D2, the Sheet stays SSOT. So this is **not** a data migration — it is handing `cloud-webapp` the write paths `gas-app` has today, while keeping Firestore as the fast read/index layer it already is.

Today:
```
gas-app        --writes-->  Google Sheet (SSOT: Users, Clubs, Events, Upload_Links, Audit_Log, …)
cloud-webapp   --reads-->   Sheet → Firestore cache (reconcileService.ts)
```

Target (gas-app retired):
```
cloud-webapp   --writes-->  Google Sheet (SSOT, via Sheets API + DWD)
cloud-webapp   --reads-->   Sheet → Firestore cache (reconciler, SAME direction)
public         --views-->   Sheet directly (unchanged — that's the point)
```

**No SSOT flip, no one-shot importer, no parallel database of record.** The reconciler keeps running exactly as it does now; we only add Sheet-write adapters and the admin UI on top.

Sheet tabs stay authoritative. `cloud-webapp` gets a write adapter per tab; Firestore caches only what a route needs to read fast/filtered:

| Sheet tab (SSOT) | cloud-webapp needs | Firestore cache? |
|---|---|---|
| Users | write (CRUD, roles, club) | yes — for admin list + auth lookups |
| Clubs | write (CRUD, activate) | yes — for filters |
| Events | write (create + Drive folder) | **already cached** (extend with `createdBy`) |
| Upload_Links | write (generate/rotate/revoke) | yes — volunteer-upload validation reads cache, falls back to Sheet |
| Audit_Log | append-only write | optional — search can read Sheet directly or cache |
| Deleted_Files | write (soft-delete lifecycle) | yes — for restore UI |
| Rate_Limit | write (counters) | **keep in Firestore/cache** (high-churn; mirror to Sheet lazily or not at all) |
| Email_Preferences | write (opt-in flags) | optional |

**RBAC is now more important, not less:** a Sheet has no row-level security, so every write must pass `requireAuth`/`requireClubScope` *before* it touches the Sheet. Porting `gas-app`'s `roleGuard` (and `infra/firestore.rules` checks) into middleware is the single biggest correctness item — do it in G1, not later.

**Concurrency note:** Sheets API has no transactions. Use a single writer per tab (serialize admin writes through the API service), and during the G6 parallel-run freeze `gas-app` writes so two apps never write the same tab at once.

---

## 4. Phased build sequence (milestones G0–G6)

Each milestone is independently deployable. Roughly **30–45 dev-days** for one engineer who knows the codebase; G1–G2 dominate.

> **⚠️ STATUS (2026-06-22) — G6 prepared; G1–G5 code-complete.** All gas-app control-plane functions now exist in `cloud-webapp` (api 289 + web 58 tests green). G6 is operational, not code: **`CUTOVER_RUNBOOK.md`** is the ordered sequence — Phase A provision (DWD scopes `spreadsheets`/`drive`/`gmail.send`, env + `PARTNER_API_KEYS` secret, Firestore indexes, 3 schedulers, deploy) → B parity matrix → C freeze gas-app writes (single-writer) → D 48h dual-run cutover → E retire §7 pieces + tag `gas-app-final`. `gas-app/DEPRECATED.md` marks the old tree read-only (code NOT deleted — it stays as reference until the operator completes cutover); `cloud-webapp/README.md` + root `CLAUDE.md` updated to the new reality. **The actual freeze/flip/decommission are deliberate operator steps and are intentionally not automated here.**

> **⚠️ STATUS (2026-06-22) — G5 landed in code.** Duplicates lifecycle, reporting, and the partner REST API are implemented + tested in `cloud-webapp`. **Deleted-files (G5.1):** `services/deletedFilesStore.ts` (Deleted_Files tab SSOT) + `driveService` untrash/permanent-delete + `routes/adminDeletedFiles.ts` (soft-delete trashes+ledgers, restore untrashes within retention, `POST /admin/deleted-files/purge` cron hard-deletes expired); club-scoped + audited (FILE_DELETED/RESTORED/PURGED). Web `pages/DeletedFiles.tsx` (list + restore). **Reporting (G5.2):** `services/summaryService.ts` (Upload_Log aggregation) + `routes/summary.ts` (`GET /admin/summary`, club-scoped) + `pages/AdminSummary.tsx` (totals/by-club + client CSV). **Partner API (G5.3):** `middleware/partnerAuth.ts` (API keys in env/Secret Manager — NOT the world-viewable Sheet; validated against active `api_client` Users rows) + per-client Firestore rate limit + `routes/partner.ts` (`GET /partner/events`, `POST /partner/links` pinned to the client's club, reusing G3 `linkStore`). New config: `PARTNER_API_KEYS`, `PARTNER_RATE_LIMIT`, `SOFT_DELETE_RETENTION_DAYS`. Nav/routes added; all pages mobile-friendly. Suite: api 289/289, web 58/58; tsc + eslint clean both. New ops steps: set `PARTNER_API_KEYS` (Secret Manager) + register api_client users; schedule the purge job via Cloud Scheduler. **Next: G6** (parallel-run + cutover + gas-app retirement).

> **⚠️ STATUS (2026-06-21) — G4 landed in code.** Email notifications + audit-log UI are implemented + tested in `cloud-webapp`. **Email** (cloud-neutral, Gmail API via the same keyless DWD client — ports to Azure unchanged; gated OFF by `EMAIL_ENABLED` so dev/test/demo never send): `services/emailService.ts` (`sendEmail`/`sendToMany`, RFC-822 builder), `emailTemplates.ts` (welcome / user-created / event-created / daily-digest), `emailPrefsStore.ts` (Email_Preferences tab, Sheet SSOT, transactional-ON/digest-OFF defaults), `routes/emailPrefs.ts` (self GET/PATCH) + `routes/emailDigest.ts` (`POST /admin/email/daily`, allowCronOrAdmin, summarizes 24h of Audit_Log). Welcome + new-user and new-event notices are wired into the G2/G3 create paths (best-effort, never block). **Audit**: `routes/audit.ts` (`GET /admin/audit`, super-admin only, date/actor/action/type filters over `auditStore.listAudit`). Web: `pages/AdminAudit.tsx` (filters + client-side CSV export) and `EmailPrefs.tsx` (opt-in toggles); nav + routes in `App.tsx`, mobile-friendly. New config: `EMAIL_ENABLED`, `EMAIL_FROM`, `APP_BASE_URL`, `EMAIL_PREFERENCES_SHEET_NAME`. Suite: api 270/270, web 58/58; tsc + eslint clean both. New ops step for live mail: authorize the `gmail.send` DWD scope + set `EMAIL_ENABLED=true`/`EMAIL_FROM`; schedule the daily digest via Cloud Scheduler. **Next: G5** (duplicates lifecycle, reporting, partner REST API).

> **⚠️ STATUS (2026-06-21) — G3 landed in code.** Events + upload-link write paths are implemented + tested in `cloud-webapp`. API: `services/eventStore.ts` + `routes/adminEvents.ts` (create event → provision Drive folder via `getOrCreateSubfolder` → append Events row → upsert Firestore cache → queue indexer, audited), and `services/linkStore.ts` + `routes/adminLinks.ts` (generate idempotent-per-(event,club,tag) / revoke / rotate v+1 / findByToken, club-scoped, audited). `linkStore` closes the G1 deferral. The reconciler is unchanged (Sheet→cache), per D2. Shared contracts extended in `schemas/admin.ts`; new config `EVENTS_ROOT_FOLDER_ID`, `USERS/CLUBS/AUDIT_LOG_SHEET_NAME`. Web: `pages/AdminEvents.tsx` (create + list) and `AdminLinks.tsx` (per-event link mgmt with copy-URL/rotate/revoke), nav + routes in `App.tsx`. **All UX reuses the responsive `feedback-filters`/`table-wrap`/`gallery-header` classes + the `@media(max-width:640px)` block, so admin pages are mobile-friendly** (forms wrap, tables scroll, header stacks). Suite: api 253/253, web 58/58; tsc + eslint clean both. **G3.4** (admin authenticated-upload parity) is covered by the existing volunteer-upload path, which keeps validating tokens against the Sheet (SSOT) — `linkStore.findByToken` is available to migrate that read to the cache later if desired, but was left as-is to avoid destabilizing the live upload flow. Same remaining ops step (DWD read/write `spreadsheets` + `drive` scopes; set `EVENTS_ROOT_FOLDER_ID`). **Next: G4** (email + audit-log UI).

> **⚠️ STATUS (2026-06-21) — G2 landed in code.** Users & Clubs admin is implemented + tested in `cloud-webapp` (api + web). API: `routes/adminUsers.ts`, `adminClubs.ts`, `adminMasquerade.ts` (+ `adminShared.ts`), wired in `server.ts`, behind `requireAuth`+`attachRole`+`requireSuperAdmin`/`requireAnyAdmin`; all writes go through the G1 Sheet adapters and are audited via `auditStore`. Club-scoped listing + super-admin masquerade (`X-Masquerade-Club`, honored only for super_admins) included. Shared contracts in `shared/src/schemas/admin.ts`. Web: `pages/AdminUsers.tsx` + `AdminClubs.tsx` (create/edit-role/rename/activate, forbidden-state), nav + routes in `App.tsx`, `apiPatch` added to `lib/api.ts`. Suite: api 238/238, web 58/58; tsc + eslint clean both packages. Same remaining ops step as G1 (authorize the read/write spreadsheets DWD scope). **Next: G3** (events + upload-link write paths; `linkStore`).

> **⚠️ STATUS (2026-06-21) — G0 + G1 landed in code.** G0 (Firestore cache indexes for `users`/`clubs`/`uploadLinks`/`auditLog` in `infra/firestore.indexes.json`) and the G1 keystone are implemented + unit-tested (CI-green, 225/225) in `cloud-webapp/api`: `sheetsService.updateSheetValues` (in-place row edits), `sheetTable.ts` (read/address/serialize-per-tab), Sheet-write adapters `userStore.ts` / `clubStore.ts` / `auditStore.ts` (Sheet SSOT + best-effort Firestore mirror), and RBAC middleware `rbac.ts` (`attachRole` resolving roles from the Users sheet via a 60s TTL cache, `requireRole`/`requireSuperAdmin`/`requireAnyAdmin`, `requireClubScope`). **Remaining for G1:** one ops step — authorize the `https://www.googleapis.com/auth/spreadsheets` (read/write) scope on the DWD client in the Workspace Admin console (read scope already granted; see `sheetsService.ts` header). `linkStore` is deferred to G3 (links need event context). Next: G2 admin routes + React pages wired behind `attachRole`+`requireRole`.

### G0 — Foundations & decision lock (~1.5 days)
- 0.1 Confirm D1–D6 with stakeholders. *(D2 = Sheet stays SSOT — confirmed.)*
- 0.2 Snapshot current Sheet schema; grant the cloud-webapp SA **Sheets write scope** via DWD (read scope already in use). Verify a test write round-trips.
- 0.3 Extend Firestore cache + composite indexes (`infra/firestore.indexes.json`) for the read paths in §3. No importer needed.
- **DoD:** SA can write the Sheet via DWD; cache indexes deploy clean.

### G1 — Sheet write adapters + RBAC (~6 days) — *keystone*
- 1.1 `api/src/services/` Sheet-write adapters: `userStore.ts`, `clubStore.ts`, `linkStore.ts`, `auditStore.ts` — append/update rows via Sheets API, then refresh the Firestore cache. Mirror gas-app service semantics (validation, soft-delete, version bump).
- 1.2 Single-writer discipline per tab (serialize writes) — see §3 concurrency note.
- 1.3 Port `roleGuard` → `requireAuth`/`requireAdmin` + **`requireClubScope`** middleware; club_admin sees only their club. Every Sheet write goes through it.
- 1.4 Port `infra/firestore.rules` access checks into middleware (server-enforced).
- **DoD:** cloud-webapp can write every control-plane tab through RBAC-guarded adapters; reconciler still syncs Sheet→cache (unit-tested).

### G2 — Admin UI: users & clubs (~6 days)
- 2.1 API routes `api/src/routes/adminUsers.ts`, `adminClubs.ts` (CRUD + activate/deactivate, audited).
- 2.2 React pages `web/src/pages/AdminUsers.tsx`, `AdminClubs.tsx` (match gas-app admin pages).
- 2.3 Super-admin masquerade (audited `MASQUERADE_START/END`).
- **DoD:** an admin manages users/clubs entirely in cloud-webapp; gas-app user/club pages no longer needed.

### G3 — Events & upload links write-path (~6 days)
- 3.1 `adminEvents.ts`: create event → provision Drive folder (reuse `driveService.ts` DWD auth) → write **Events tab** → refresh cache → kick indexer.
- 3.2 `adminLinks.ts`: generate/rotate/revoke links → write **Upload_Links tab** (Sheet stays SSOT); volunteer-upload validation reads the Firestore cache with Sheet fallback.
- 3.3 **Keep the reconciler** (Sheet→cache) running — direction unchanged. No export job needed; the Sheet is already the human-viewable SSOT.
- 3.4 Admin authenticated-upload parity check vs volunteer path.
- **DoD:** events + links are created/managed in cloud-webapp, written straight to the Sheet; the Sheet stays authoritative and viewable.

### G4 — Email + audit log UI (~7 days)
- 4.1 Email: replace GAS `MailApp` with a provider (Gmail API via DWD, or SendGrid). `api/src/services/emailService.ts` + templates; events on Cloud Tasks/Scheduler for daily/weekly digests + retry. Port `Email_Preferences` UI.
- 4.2 Audit log: extend `auditStore.ts` to all 9 categories; `api/src/routes/audit.ts` (search by date/actor/action, CSV export); `web/src/pages/AdminAudit.tsx`.
- **DoD:** transactional + digest emails send from cloud-webapp; full audit log searchable + exportable.

### G5 — Duplicates, reporting, partner API (~6 days)
- 5.1 Duplicate cleanup lifecycle: soft-delete → `deletedFiles` + Drive trash; restore within retention; daily purge job (Cloud Scheduler). UI `web/src/pages/Duplicates.tsx`.
- 5.2 Reporting: implement `/api/metrics` + summary CSV (`summaryService.ts` port); `web/src/pages/AdminSummary.tsx`.
- 5.3 Partner REST API: `api/src/routes/partner.ts` with API-key auth (`users` role=`api_client`) + Firestore-backed rate limiting (`rateLimits`).
- **DoD:** duplicate management, reporting, and partner upload all run in cloud-webapp.

### G6 — Cutover & gas-app retirement (~4 days)
- 6.1 Parallel-run: keep gas-app read-only for one event cycle; verify parity on every admin flow. **Freeze gas-app writes** so only cloud-webapp writes the Sheet (single-writer, per §3).
- 6.2 Flip all admin traffic to cloud-webapp. The Sheet keeps being the SSOT — only the writer changed.
- 6.3 Retire obsolete pieces per §7; archive `gas-app/` (tag final commit).
- 6.4 Update `CLAUDE.md`, `cloud-webapp/README.md`, `ARCHITECTURE.md` to the single-app reality.
- **DoD:** gas-app receives no production traffic; cloud-webapp is the sole writer of the Sheet SSOT; the Sheet stays publicly viewable.

---

## 4A. Consolidated outstanding work (pulled from all active plans)

This is the single roadmap. Besides the gas-app migration (G0–G6 above), these are the *already-planned-but-unfinished* items scattered across the other docs. Status legend matches `FACE_MATCHING_DEV_PLAN.md`: ✅ done/live · 🟢 code-complete, not deployed · 🟡 partial · ⬜ to do.

### 4A.1 Find Me — deploy the code-complete backlog (source: `FACE_MATCHING_DEV_PLAN.md` §5A, `FINDME_DEPLOY_CHECKLIST.md`)
All of B1–B8 are 🟢 **code-complete but not deployed** — one deploy (api + web + gas-app `clasp push`) plus a B6 indexer re-run away from live.

| Item | Status | What |
|---|---|---|
| B1 original-res ZIP download | 🟢 | `download.ts` zip of `orig` derivatives |
| B2 selection UI | 🟢 | `selection.ts`/`useSelection`/`SelectBar` |
| B3 switch active selfie | 🟢 | per-selfie result sets in `FindMe.tsx` |
| B4 Gallery back-nav | 🟢 | breadcrumb + event header |
| B5 real event names | 🟢 | indexer backfills `events.name` from Drive |
| B6 content-hash dedup | 🟢 | md5 de-dup; **needs indexer re-run** `{"force":true}` |
| B7 wrong-match feedback | 🟢 | `feedback.ts` + per-result buttons |
| B8 instant metadata sync | 🟢 | gas-app `triggerMetadataSync()` → `POST /api/admin/sync` |

### 4A.2 Find Me — remaining milestones M4–M6 (source: `FACE_MATCHING_DEV_PLAN.md`, `FACE_MATCHING_FEATURE_PRD.md`, `EVAL_FEEDBACK_LOOP.md`)

| Item | Status | Where it lands |
|---|---|---|
| M4 — ZH localization | ⬜ | folds into G2/G4 UI work |
| M4.4 — eval feedback loop wiring (export → `run_eval.py --judged-only`) | 🟡 | after B7 deploy |
| M5.3 — per-user rate limits (download/original) | 🟡 | cloud-webapp gap, see 4A.4 |
| M5.x — reCAPTCHA Enterprise setup (keys/env) | 🟡 | deploy step |
| M5.6 — minor/guardian attestation legal review | ⬜ | needs legal, not eng |
| M6 — polish/observability | ⬜ | after cutover |

### 4A.3 Indexing & capture-time — deploy + harden (source: `AUTOMATED_INDEXING_HANDOFF.md`, `CAPTURE_TIME_SORT_DESIGN.md`, `CLAUDE.md` indexer notes)

| Item | Status | What |
|---|---|---|
| Commit + push automated-indexing work; create `SYNC_TRIGGER_TOKEN` secret; verify | 🟢→deploy | end-of-batch + 10-min scan triggers |
| Capture-time sort: backfill `takenAt` on indexed events + deploy | 🟢→deploy | `infra/scripts/backfill-capture-time` |
| Incremental checkpointing (resume killed runs) | ⬜ | from `CLAUDE.md` indexer notes |
| Task-sharding / polling-UI for large events | ⬜ | follow-up |

### 4A.4 cloud-webapp known gaps (source: cloud-webapp code scan)

| Item | Status | What |
|---|---|---|
| `GET /api/metrics` implementation | 🟡 placeholder | wire to G5.2 reporting |
| `POST /api/telemetry` client error capture | 🟡 placeholder | client error reporting |
| Per-user (not shared) rate limits for download/original | 🟡 | M5.3 |

### 4A.5 Azure migration remainder (~60%) — see §5 and `AZURE_MIGRATION_PROGRESS.md`
Infra scripts done (✅); remaining is code porting (⬜): Firestore→Cosmos *cache*, GCS→Blob (api/indexer/matcher), rules→middleware, indexer-trigger API, bootstrap + Key Vault secrets, deploy + smoke-test, `--min-replicas=0` audit, README/ARCHITECTURE/DEPLOYMENT prose update, Azure CI/CD with Entra federation. **Note:** with D2 (Sheet stays SSOT), the Cosmos work shrinks to caches only.

---

## 5. Azure follow-on (after cloud-webapp is feature-complete)

No new features — this is the SDK swap already scoped in `Azure_Migration_Plan.docx` and `AZURE_MIGRATION_PROGRESS.md`. Because D2 keeps the **Sheet as SSOT**, the Azure move gets simpler:
- **The control-plane SSOT does not move.** Users/clubs/events/links/audit stay in the Google Sheet, which Azure reaches with the *same* Sheets API + DWD code — no Cosmos modeling, no partition keys, no data export for control-plane data. The Sheet-write adapters (G1) are cloud-neutral and carry over unchanged.
- Only the **derived caches** move: Firestore→Cosmos and GCS→Blob, behind the §6 adapters, so it stays mechanical.
- Email provider choice should be cloud-neutral (Gmail API via DWD works on both; SendGrid likewise) so G4 doesn't need redoing on Azure.

Sequence: finish G0–G6 on GCP, stabilize, then run the Azure phases (cache→Cosmos, storage→Blob, deploy) — the Sheet and Drive layers ride along untouched.

---

## 6. Forward-compatibility rules (so Azure stays a swap, not a rewrite)

1. **No direct SDK calls in routes.** All Firestore access via `lib/firestore.ts` adapter; all storage via `gcsService.ts`. Azure swaps the adapter, not 12 routes.
2. **No vendor lock in business logic.** Keep `@google-cloud/*` imports confined to `lib/` and `services/`.
3. **Auth claims, not Firebase types, in handlers.** Pass a normalized `{ email, role, clubId }` so an Entra swap touches only the verifier.
4. **Config via env + Secret Manager / Key Vault.** No hardcoded project IDs or bucket names.
5. **Cost policy holds on both clouds** (`CLAUDE.md`): scale-to-zero, signed-URL/SAS photo delivery only, never proxy bytes through the hosting rewrite.

---

## 7. Retire — do not port

| Item | Why | Action |
|---|---|---|
| Public-index Google Sheet (`publicSpreadsheetService.ts`) | Cloud Storage gallery replaces public browsing | Drop at G6; remove scheduled refresh triggers |
| `Photos_NNN` / `Videos` / `Album` Drive consolidation + shortcuts | GCS derivatives serve the gallery; Drive stays cold archive only | Stop building shortcuts; keep originals in Drive |
| Upload-prep sidebar (`uploadPrepRoutes.ts`) + `UPLOAD_PREP_FEATURE_SPEC.md` | Indexer converts non-JPEG → derivatives automatically | Retire (spec already archived) |
| Photos-Library-API sharing (`drivePermissionsService.ts`, `PUBLIC_SHARING.md`) | Google deprecated the API 2025-03-31 | Retire; gallery handles sharing |
| Standalone `cloud-run/` image-convert service | Indexer absorbs conversion | Retire once gas-app upload-prep is gone |

---

## 8. Documentation hygiene done in this pass

**Moved to `archive/`** (stale — one-off task docs or superseded specs describing gas-app's old state):
`CODE_QUALITY_ASSESSMENT.md` (Apr snapshot), `FIX_PHOTOS_AUTH.md` (dead Photos API fix), `HEADER_REFACTORING.md` (completed GAS UI task), `TEST_COVERAGE_PROMPT.md` (completed one-off prompt), `UPLOAD_PREP_FEATURE_SPEC.md` (superseded by indexer).

**Kept but flagged as gas-app-only / migration sources** (still describe live behavior to be ported, or are foundational reference): `DESIGN_DECISIONS.md`, `EMAIL_SERVICE.md`, `PUBLIC_SHARING.md`, `系统用例文档_ZH.md`, `UX_AND_GCP_ASSESSMENT.md`, `STORAGE_AND_DATABASE_OPTIONS.md`.

**Stale prose noted (not moved — inside actively-worked dirs):** `azure-webapp/README.md`, `azure-webapp/ARCHITECTURE.md`, `azure-webapp/docs/DEPLOYMENT.md` still describe the GCP stack and are marked as needing the Azure rewrite in `AZURE_MIGRATION_PROGRESS.md`.

---

## 9. Risks

- **R1 — Concurrent Sheet writes.** With the Sheet as SSOT and no transactions, two writers (gas-app + cloud-webapp) can clobber rows during parallel-run. Mitigate: single-writer per tab (§3), freeze gas-app writes at G6.1.
- **R2 — Sheets API quota/latency.** Admin writes now go through the Sheets API (per-minute quotas, ~hundreds of ms). Batch where possible; keep high-churn data (rate limits) in the cache, not the Sheet.
- **R3 — RBAC parity.** A Sheet has no row-level security, so middleware is the *only* guard. Club-scoping + masquerade are easy to under-implement; unit-test middleware against gas-app `roleGuard` cases.
- **R4 — Email deliverability.** GAS `MailApp` "just works" on Workspace; a new provider needs SPF/DKIM. Pick Gmail-API-via-DWD to stay on the Workspace domain.
- **R5 — Double work on Azure.** Mitigated by D6 adapters, the Sheet-SSOT staying put, and a cloud-neutral email choice.
