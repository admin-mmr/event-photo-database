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

**The Gmail API must also be enabled on the GCP project** — the DWD scope
authorizes the impersonation, but the API itself is a separate switch. When
disabled, digest/notice sends fail with a non-fatal
`Gmail send 403 … SERVICE_DISABLED` warning in the api logs while the endpoint
still returns 200 (found live 2026-07-18):

```bash
gcloud services enable gmail.googleapis.com --project=mmr-data-pipeline
```

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

| Scheduler job | Target | Cron (TZ `America/New_York`) |
|---|---|---|
| `findme-index-scan` | `POST /api/admin/index-scan` | `*/10 * * * *` (every ~10 min during events) |
| `findme-email-daily` | `POST /api/admin/email/daily` | `0 7 * * *` (once daily) |
| `findme-deleted-purge` | `POST /api/admin/deleted-files/purge` | `30 3 * * *` (once daily) |

All three share the `allowCronOrAdmin` gate (`middleware/cronAuth.ts`): a machine
caller presents `X-Sync-Token: $SYNC_TRIGGER_TOKEN` (no Firebase login needed),
humans fall through to `requireAuth → requireAdmin`.

**Provisioning.** First export the token from Secret Manager so it's never pasted
literally:

```bash
export SYNC_TRIGGER_TOKEN="$(gcloud secrets versions access latest --secret=SYNC_TRIGGER_TOKEN --project=mmr-data-pipeline)"
```

Each job has a maintained, idempotent script (re-running updates in place —
the header flag is picked by verb, `--headers` on create / `--update-headers`
on update):

```bash
./infra/scripts/provision-index-scan-scheduler.sh mmr-data-pipeline us-central1
./infra/scripts/provision-email-daily-scheduler.sh mmr-data-pipeline us-central1
./infra/scripts/provision-deleted-purge-scheduler.sh mmr-data-pipeline us-central1
```

**OIDC is required, not just the header.** Even though the app authorizes on
`X-Sync-Token`, Cloud Run's IAM layer runs first, so every scheduler job must also
attach a Google OIDC token or Cloud Run returns an HTML `403` before the token
gate ever runs. Use the same identity the existing `findme-drive-sync` job uses
(`api-runtime@mmr-data-pipeline.iam.gserviceaccount.com`, which holds
`run.invoker` on the service) and set the audience to the service URL:

```
  --oidc-service-account-email=api-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
  --oidc-token-audience="$API_URL"
```

All three scripts add these automatically (they inherit the SA from
`findme-drive-sync`). If `findme-drive-sync` itself has no OIDC token (it
predates the OIDC convention — it worked anyway because the service is publicly
invokable), the scripts fail with `no OIDC service account found`; export the
SA explicitly and re-run:

```bash
export OIDC_SA=api-runtime@mmr-data-pipeline.iam.gserviceaccount.com
```

**Keep them OFF until parity sign-off (Phase B).** Newly created jobs are
`ENABLED` by default, so pause each immediately after creating it (a paused job
can still be triggered manually with `jobs run` for verification):

```bash
for J in findme-index-scan findme-email-daily findme-deleted-purge; do
  gcloud scheduler jobs pause "$J" --location=us-central1 --project=mmr-data-pipeline
done
```

**Also pause `findme-drive-sync` during parity.** This pre-existing daily
reconciler (`POST /api/admin/sync`, the §8 "Sync with Drive" job from
`provision-sync-scheduler.sh`) is NOT part of A4, but it writes the master Sheet,
so leaving it `ENABLED` during Phase B would mutate the SSOT underneath your
parity diffs. Pause it too until sign-off:

```bash
gcloud scheduler jobs pause findme-drive-sync --location=us-central1 --project=mmr-data-pipeline
```

Verify the full set reads `PAUSED` before moving on:

```bash
gcloud scheduler jobs list --location=us-central1 --project=mmr-data-pipeline \
  --format='table(name.basename(), schedule, state, httpTarget.uri)'
```

Re-enable everything (all four) after Phase B with `gcloud scheduler jobs resume <job> …`.

### A5. Deploy

```bash
cd cloud-webapp
./infra/scripts/deploy-api.sh mmr-data-pipeline
./infra/scripts/deploy-web.sh mmr-data-pipeline
```

(Both scripts require the project id as `$1`; `deploy-api.sh` takes an optional
region as `$2`, default `us-central1`.)

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

**Automated harness.** `infra/scripts/parity-check.mjs` exercises this matrix
against the deployed API (dependency-free, Node 18+). Read-only smoke + shape +
RBAC by default; `--write` adds a reversible create→readback→deactivate cycle
for clubs/users/links/masquerade; `--email` / `--partner-key` gate the rest. It
needs an admin Firebase ID token (grab from DevTools while signed in — see
`--help`):

```bash
ADMIN_ID_TOKEN=<jwt> node cloud-webapp/infra/scripts/parity-check.mjs
ADMIN_ID_TOKEN=<jwt> node cloud-webapp/infra/scripts/parity-check.mjs --write --event=<eventId>
```

A green run means the API round-trips; the authoritative parity check is still
eyeballing each Sheet tab (printed per flow) against gas-app.

**Go/no-go:** every row verified on a real (non-production-critical) event for at
least one full event cycle. Now `resume` the Phase A4 schedulers **and**
`findme-drive-sync` (all four were paused for parity — see A4).

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

- [x] A1 scopes authorized (spreadsheets, drive, gmail.send) — proven live 2026-07-18: parity `--write` wrote the Sheet, event create made a Drive folder, digest email delivered (after also enabling the Gmail *API* on the project — scope and API enable are separate switches)
- [x] A2 env + secrets set; partners registered as api_client — verified 2026-07-18: `PARTNER_API_KEYS` in Secret Manager + mounted; disposable parity api_client exercised both partner endpoints, then deactivated (key confirmed 403)
- [x] A3 indexes deployed — verified 2026-07-18: 9/9 composite indexes `READY`, matching `cloud-webapp/infra/firestore.indexes.json`
- [x] A4 schedulers created + paused (index-scan, digest, purge); `findme-drive-sync` also paused for parity — verified 2026-07-18, all five jobs (incl. folder-rebuild) `PAUSED`, OIDC (`api-runtime@`) attached to all
- [x] A5 deployed; `/api/health` green — verified 2026-07-18 (commit `cdbba07`)
- [x] B parity matrix fully verified over one event cycle — signed off 2026-07-18: automated harness green (read-only 12/12, `--write` 17/0, `--email`, `--partner-key`), Cathy eyeballed the master + Managed Albums sheets, digest email received (mojibake subject fixed in PR #3). All five schedulers resumed same evening.
- [x] C gas-app writes frozen (web app unpublished, triggers removed) — done 2026-07-18: all gas-app triggers removed and the web app deployment archived; cloud-webapp is the single writer
- [ ] D 48h clean dual-run — IN PROGRESS. Watch surfaced + fixed a
  `findme-folder-rebuild` regression on 2026-07-19: (1) the drain query needed a
  `folderRebuildBatches` composite index that was never in
  `infra/firestore.indexes.json` (drain 500'd every 2 min with
  `FAILED_PRECONDITION`) — index added + created live; (2) once draining, a large
  event's `migrate-shortcuts` rebuild exceeded the 60s Cloud Run request timeout
  → HTTP 504, zero progress — raised the api timeout to 300s (`deploy-api.sh`).
  The stuck 10-event batch then completed (10/10). Fixes shipped in PR #6. The
  48h clean-log clock effectively restarts from this fix.
- [ ] E obsolete pieces retired; `gas-app-final` tag pushed
- [ ] Docs updated (README / CLAUDE.md / this runbook archived)
