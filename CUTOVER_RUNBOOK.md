# Cutover Runbook — Retire gas-app, run the control plane on cloud-webapp

**Implements:** `GAS_MIGRATION_DEV_PLAN.md` §4 milestone **G6**
**Audience:** Operator (Cathy / IT)
**Precondition:** G0–G5 are merged (control-plane code lives in `cloud-webapp/`).
**Date:** 2026-06-22

This is the operational sequence to move the admin/control plane from `gas-app`
to `cloud-webapp` and retire the Apps Script app. **The Google Sheet stays the
source of truth (SSOT) the whole way through** (dev-plan D2) — only the *writer*
changes from gas-app to cloud-webapp. There is no data migration.

Work top-to-bottom: **A** provision → **B** verify parity → **C** parallel-run +
freeze → **D** cut over → **E** retire. Each phase has a clear go/no-go.

---

## Phase A — One-time provisioning (the deferred ops steps from G1–G5)

These are the manual steps each milestone left for an operator. None can be done
from application code.

### A1. Domain-wide-delegation scopes (Workspace Admin console)

The cloud-webapp SA (`indexer-runtime@…`, `DWD_SA`) impersonates
`admin@mmrunners.org` (`DWD_SUBJECT`). Authorize **all** of these scopes on that
client id (Admin console → Security → API controls → Domain-wide delegation).
Drive read was granted during Find Me; add the rest:

| Scope | Needed by | Milestone |
|---|---|---|
| `https://www.googleapis.com/auth/spreadsheets` | Sheet read **and write** (all *Store adapters) | G1 |
| `https://www.googleapis.com/auth/drive` | create event folders, trash/untrash/delete files | G3, G5 |
| `https://www.googleapis.com/auth/gmail.send` | transactional + digest email | G4 |

Until a scope propagates, the matching calls return `403 PERMISSION_DENIED`.

### A2. Service config / secrets (Cloud Run env + Secret Manager)

Set on the `event-photo-api` service (`deploy-api.sh --update-env-vars`, or
`--set-secrets` for secrets):

```
MASTER_SPREADSHEET_ID=<the gas-app master Sheet id>
EVENTS_ROOT_FOLDER_ID=<Drive folder where YYYY-MM-DD_Event folders are created>
ADMIN_EMAILS=<comma-separated bootstrap super-admins>
EMAIL_ENABLED=true
EMAIL_FROM=admin@mmrunners.org
APP_BASE_URL=https://mmr-data-pipeline.web.app
SYNC_TRIGGER_TOKEN=<existing cron secret>
```

Secrets (Secret Manager, never in the world-viewable Sheet):

```
PARTNER_API_KEYS=<email:key,email2:key2>   (only if partner API is used)
```

Then register each partner as an **active `api_client`** user (with their club)
via the Users admin page so `partnerAuth` accepts them.

### A3. Firestore cache indexes

```bash
firebase deploy --only firestore:indexes --project mmr-data-pipeline
```

(Adds the `users` / `clubs` / `uploadLinks` / `auditLog` composite indexes from
`infra/firestore.indexes.json`.)

### A4. Schedulers (Cloud Scheduler → POST with `X-Sync-Token`)

| Job | Target | Cadence |
|---|---|---|
| index scan (existing) | `POST /api/admin/index-scan` | every ~10 min during events |
| daily email digest | `POST /api/admin/email/daily` | once daily |
| deleted-files purge | `POST /api/admin/deleted-files/purge` | once daily |

All honour the machine `X-Sync-Token` (`SYNC_TRIGGER_TOKEN`) so no Firebase
login is needed. Keep them OFF until after parity sign-off (Phase B).

### A5. Deploy

```bash
cd cloud-webapp
./infra/scripts/deploy-api.sh
./infra/scripts/deploy-web.sh
```

Confirm `GET /api/health` returns the new commit SHA.

**Go/no-go:** a smoke `GET /api/admin/clubs` as a bootstrap admin returns `200`
(not `503 not_configured` → A2 missing; not `403` → A1 Sheets scope missing).

---

## Phase B — Parity verification (parallel, read-only)

With cloud-webapp deployed but gas-app still the writer, exercise every admin
flow in cloud-webapp and confirm it matches gas-app. The Sheet is SSOT, so a
cloud-webapp write shows up in the same Sheet gas-app reads — diff the tab after
each test.

| gas-app feature | cloud-webapp surface | Check |
|---|---|---|
| User CRUD + roles | `/admin/users` → `adminUsers` | create/edit/deactivate writes Users tab; RBAC blocks club_admin |
| Club CRUD | `/admin/clubs` → `adminClubs` | create/rename/deactivate writes Clubs tab |
| Masquerade | super-admin "act as club" | `X-Masquerade-Club` scopes lists; audited |
| Event create + Drive folder | `/admin/events` → `adminEvents` | row in Events tab + folder under `EVENTS_ROOT_FOLDER_ID` + index queued |
| Upload links | `/admin/events/:id/links` → `adminLinks` | generate/rotate/revoke write Upload_Links; volunteer URL works |
| Email notices + digest | `/me/email`, `POST /admin/email/daily` | welcome/new-user/new-event send; digest lists 24h audit |
| Audit log | `/admin/audit` → `audit` | every write above appears; CSV exports |
| Duplicates / trash | `/admin/deleted` → `adminDeletedFiles` | soft-delete trashes + ledgers; restore untrashes |
| Reporting | `/admin/summary` → `summary` | totals match Upload_Log |
| Partner API | `GET /partner/events`, `POST /partner/links` | key auth works; link pinned to client club |

**Go/no-go:** every row verified on a real (non-production-critical) event for at
least one full event cycle. Now enable the Phase A4 schedulers.

---

## Phase C — Parallel-run + freeze gas-app writes

The Sheet has **no transactions**, so two writers can clobber rows. Establish a
**single writer** before cutover:

1. Announce a short admin freeze window.
2. In gas-app, stop all write paths — simplest: unpublish / disable the gas-app
   web app deployment and remove its time-based triggers
   (`removeEmailTriggers`, public-sheet refresh, purge) so it can no longer
   write the Sheet or Drive. gas-app may remain readable for reference.
3. From this point, **cloud-webapp is the only writer** of the Sheet + Drive.

**Rollback (during the window):** re-publish gas-app, re-install its triggers;
because the Sheet is SSOT and unchanged, gas-app resumes exactly where it was.

---

## Phase D — Cutover

1. Point admins at the cloud-webapp URL (`APP_BASE_URL`) for all control-plane
   work; retire the gas-app bookmark.
2. Watch for 48h: Cloud Logging `severity>=ERROR` on `event-photo-api`, the
   audit log (`/admin/audit`), and Sheet integrity.
3. Confirm the schedulers fire (digest email arrives; purge logs a run).

**Go/no-go:** 48h with no parity regressions and clean error logs.

---

## Phase E — Retire (dev plan §7)

Only after Phase D is stable. These are intentionally **not** done by app code —
execute deliberately:

- **Public-index Google Sheet** (`publicSpreadsheetService`): stop its refresh
  trigger (already removed in C2); the cloud gallery replaces public browsing.
- **`Photos_NNN` / `Videos` / `Album` Drive consolidation + shortcuts**: stop
  building them; originals stay in Drive as cold archive.
- **Upload-prep sidebar** + **Photos-Library-API sharing** code: dead; leave in
  the archived gas-app tree.
- **Standalone `cloud-run/` image-convert service**: retire once gas-app
  upload-prep is gone (the indexer does conversion). `gcloud run services delete`.
- **Archive gas-app:** tag the final commit and stop deploying it.

```bash
git tag gas-app-final -m "Last gas-app deploy before cloud-webapp cutover"
git push origin gas-app-final
```

Keep the gas-app source in-repo (read-only reference) for ~1 release, then move
it under `archive/` if desired. `cloud-webapp/README.md` and root `CLAUDE.md`
now describe the single-app reality.

---

## Decommission checklist (sign-off)

- [ ] A1 scopes authorized (spreadsheets, drive, gmail.send)
- [ ] A2 env + secrets set; partners registered as api_client
- [ ] A3 indexes deployed
- [ ] A4 schedulers created (index-scan, digest, purge)
- [ ] A5 deployed; `/api/health` green
- [ ] B parity matrix fully verified over one event cycle
- [ ] C gas-app writes frozen (web app unpublished, triggers removed)
- [ ] D 48h clean dual-run
- [ ] E obsolete pieces retired; `gas-app-final` tag pushed
- [ ] Docs updated (README / CLAUDE.md / this runbook archived)
