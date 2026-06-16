# Find Me ↔ GAS webapp: dependency & setup runbook

**Date:** 2026-06-15 · **Project:** `mmr-data-pipeline`
**Question this answers:** *"Does the new cloud-webapp Find Me feature need the gas-webapp to set something up? I didn't run anything manually to update GAS logic."*

## TL;DR

**No GAS code or logic changes are required, and none should be made.** You were
right not to touch Apps Script. Find Me is entirely a `cloud-webapp` feature. The
two systems are wired **one-way**: the GAS app stays the authoritative admin tool,
and the cloud webapp *pulls* from the data GAS already produces.

| System | Role for Find Me | Needs manual change? |
|---|---|---|
| **gas-app** (Apps Script) | Source of truth: writes events + upload-links to the master Google **Sheet**; photos land in **Drive** folders. | **No.** No script edit, no redeploy, no new trigger. |
| **cloud-webapp** | Reads the Sheet (Sync) + Drive folder (indexer), runs face match. | Yes — all the real setup is here (below). |

The integration is a cloud-side, read-only pull. Nothing pushes *from* GAS. The old
"GAS pushes to Firestore" approach (`gas-app/src/services/firestoreClient.ts`) was
**deleted** on 2026-06-15 and replaced by the cloud-side reconciler, which is why
there is nothing to run on the GAS side.

## How the data actually flows

```
   gas-app admin workflow
   ├── writes Events / Upload_Links rows ──► master Google Sheet ─┐
   └── photos uploaded ──────────────────► Drive event folder ──┐ │
                                                                 │ │  (read-only, cloud side)
                                                                 ▼ ▼
   cloud-webapp:
     POST /api/admin/sync (reconciler)  ── Sheets API (DWD) ──► Firestore `events`
     photo-indexer Cloud Run Job        ── Drive API  (DWD) ──► vectors in derivatives bucket
     POST /api/findme/search            ── matcher (cosine)  ──► signed result URLs
```

Drive/Sheets stays authoritative; the Firestore copy is **derived** and re-derivable.
The reconciler upserts with `merge: true`, so cloud-owned fields (`indexState`,
`visibility`) are never clobbered, and Sheet rows that disappear are reported as
`orphans`, never deleted.

## The one Google/Workspace-side action (not GAS)

Reading the master Sheet uses domain-wide delegation. The DWD client was originally
authorized for `drive` only (see `SETUP_NOTES.md` §G1). Find Me's Sync step also needs
the Sheets read scope:

- In the **Workspace Admin console** → Security → API controls → Domain-wide delegation,
  for the **same client id**, add scope:
  `https://www.googleapis.com/auth/spreadsheets.readonly`

This is a console toggle on an existing client. It is **not** an Apps Script change.

## Setup runbook (cloud-webapp side)

All steps below are in `cloud-webapp`. Skip any already done.

### 1. Deploy the matcher service (Find Me search backend)
```
./infra/scripts/deploy-matcher.sh mmr-data-pipeline us-central1
```
`MATCHER_URL` is auto-resolved by `deploy-api.sh`; if you pin it manually, set it to the
matcher's `*.run.app` URL. While `MATCHER_URL` is empty, `/api/findme/*` returns a clean
503 rather than failing oddly.

### 2. Set the api env vars
Set on the api Cloud Run service (via `deploy-api.sh`, which uses **`--update-env-vars`**
merge — do not use `--set-env-vars`, it blanks unlisted vars):

| Var | Value |
|---|---|
| `MASTER_SPREADSHEET_ID` | the gas-app master Sheet id (its `SPREADSHEET_ID` Script Property) |
| `MATCHER_URL` | matcher service URL (auto-resolved if unset) |
| `SYNC_TRIGGER_TOKEN` | *(optional)* shared secret for the scheduled sync; store in Secret Manager |

Defaults already cover `EVENTS_SHEET_NAME=Events`, `UPLOAD_LINKS_SHEET_NAME=Upload_Links`,
`DWD_SA`, `DWD_SUBJECT`, `INDEXER_JOB_NAME=photo-indexer`, `DERIVATIVES_BUCKET`.

### 3. Deploy the api (reconciler + findme routes)
```
git push           # CI deploys, or:
./infra/scripts/deploy-api.sh mmr-data-pipeline us-central1
```

### 4. One-time IAM for indexing (if not already applied)
From the `deploy-indexer.sh` header:
- `run.developer` on the `photo-indexer` job for `api-runtime@` (the api triggers the
  job with env overrides → needs `run.jobs.runWithOverrides`, not just `run.invoker`).
- `iam.serviceAccountTokenCreator`: `api-runtime@` on `indexer-runtime@`, **and
  `indexer-runtime@` on itself** (so the job can sign its own DWD JWT for Drive reads).

### 5. Pull events from the Sheet into Firestore
```
curl -X POST -H "Content-Type: application/json" -H "X-Sync-Token: <secret>" \
  https://<api>/api/admin/sync
```
(or click **Sync with Drive** as a Firebase admin). Optionally schedule it daily:
```
SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-sync-scheduler.sh mmr-data-pipeline us-central1
```

### 6. Index each event (build the face/person vectors)
```
gcloud run jobs execute photo-indexer --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=EVENT_ID=<id>,DRIVE_FOLDER_ID=<folder>
```
Once Sync has run, the `DRIVE_FOLDER_ID` override is unnecessary — the reconciler writes
it onto the event doc and the job reads it from Firestore. Re-running is idempotent
(md5 manifest diff; only new/changed photos re-embed). Indexing is also auto-triggered at
end-of-upload-batch + a scheduled scan, so "event_not_indexed" usually means a run is
in progress, not a missed manual step.

## Verify

```
# event is in Firestore and indexed
gcloud firestore documents get \
  "projects/mmr-data-pipeline/databases/(default)/documents/events/<EVENT_ID>" \
  --project=mmr-data-pipeline --format='value(fields.indexState)'
# indexState.status should be "done"

# indexer run completed
gcloud run jobs executions list --job=photo-indexer --region=us-central1 --project=mmr-data-pipeline
```

Then in the web app: open **Find Me**, pick the event, upload a reference selfie, check
the consent box → results return with signed thumbnail/web URLs. A `match_runs` doc is
written per search for the feedback loop.

## Common "did I forget a GAS step?" symptoms — all resolved cloud-side

| Symptom | Cause | Fix (no GAS) |
|---|---|---|
| Event missing in Find Me dropdown | Sync hasn't run since the row was added to the Sheet | run step 5 |
| `event_not_indexed` (409) | indexer hasn't finished for that event | wait / run step 6 |
| `/api/findme/*` → 503 | `MATCHER_URL` empty (matcher not deployed) | steps 1–3 |
| `/api/admin/sync` → 503 | `MASTER_SPREADSHEET_ID` empty | step 2 + redeploy |
| Sync fails reading the Sheet | DWD client lacks `spreadsheets.readonly` | add the scope (Workspace Admin console section above) |

## References
- `cloud-webapp/docs/SYNC_RECONCILER_HANDOFF.md` — the reconciler design + remaining human steps.
- `cloud-webapp/ARCHITECTURE.md` — why this is a migration *off* Apps Script.
- `cloud-webapp/api/src/routes/findme.ts`, `services/matcherClient.ts`, `services/reconcileService.ts`.
- `FACE_MATCHING_DEV_PLAN.md` §8 (cutover/ops), M1 (indexer), M2 (search).
- `SETUP_NOTES.md` §G1 (DWD client).
