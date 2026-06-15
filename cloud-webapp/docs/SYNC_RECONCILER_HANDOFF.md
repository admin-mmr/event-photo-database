# Handoff — "Sync with Drive" reconciler + indexer deploy

**Date:** 2026-06-15 · **Project:** mmr-data-pipeline · **Implements:** dev plan §8 (cutover/ops) + M1 indexer deploy

This note covers three pieces of work and exactly what a human still needs to do
to take them fully live.

---

## 1. What shipped (code)

### "Sync with Drive" reconciler (dev plan §8)

Pulls the master Google Sheet → Firestore so the cloud webapp's gallery and Find
Me see the same events the gas-app admin workflow creates, without anyone
re-entering them. **Drive/Sheets stays authoritative; the Firestore copy is derived.**

| File | Purpose |
|---|---|
| `api/src/services/sheetsService.ts` | Keyless DWD read of the Sheets API (same pattern as `driveService.ts`, separate token cache for the Sheets scope). |
| `api/src/services/reconcileService.ts` | Parses the `Events` + `Upload_Links` tabs (column maps mirror gas-app `SheetColumns`), derives distinct per-event `tags`, upserts events. Pure helpers (`parseEventRows`, `parseTagsByEvent`, `contentEquals`) are unit-tested. |
| `api/src/routes/sync.ts` | `POST /api/admin/sync` — the "Sync with Drive" button. Authorized by a Firebase **admin**, *or* a `X-Sync-Token` header for machine callers (Cloud Scheduler). |
| `infra/scripts/provision-sync-scheduler.sh` | Daily Cloud Scheduler trigger (06:00) that POSTs the sync route with the shared token. |
| `shared/src/schemas/sync.ts`, `event.ts` | `SyncResponse` contract; `tags` added to `EventSummary`. |
| `api/src/lib/config.ts` | New env: `MASTER_SPREADSHEET_ID`, `EVENTS_SHEET_NAME`, `UPLOAD_LINKS_SHEET_NAME`, `SYNC_TRIGGER_TOKEN`. Wired through `deploy-api.sh` + `deploy-api.yml`. |

**Reconcile policy = report-only (decided 2026-06-15):**
- Each Sheet event row is upserted with `merge: true`, so cloud-owned fields the
  indexer/admin write (`indexState`, `visibility`) are **never clobbered**.
- Writes happen only when content actually changed → a no-op sync writes nothing
  (idempotent, no `lastSyncedAt` churn).
- Events in Firestore but **absent from the Sheet are reported as `orphans`, never
  deleted.**

### Indexer deploy (dev plan M1)

- `infra/scripts/deploy-indexer.sh` rewritten to match `deploy-matcher.sh`: ONNX
  weights (~184 MB) are staged in GCS once and pulled into the build context
  **in-cloud** by Cloud Build — no 184 MB laptop upload per deploy. Executable,
  with preflight + post-deploy guidance.
- `cloud-webapp/.gcloudignore` added so the api/indexer build context uploads
  code only (safe — both Dockerfiles rebuild deps internally).
- `indexer/Dockerfile`: the `model_files` `COPY` was switched from the fragile
  bracket-glob (`COPY matcher/model_file[s]/`) to a plain `COPY`. **The old glob
  fails on Cloud Build's legacy (non-BuildKit) Docker builder with "no source
  files were specified" even when the files are present** — this was the cause of
  the first failed deploy. `matcher/Dockerfile` already had this fix; the indexer
  was missed.

### Cleanup

- Deleted the orphan `gas-app/src/services/firestoreClient.ts` (the abandoned
  GAS-pushes-to-Firestore approach, superseded by this cloud-side pull
  reconciler). It was never imported anywhere and was untracked in git, so the
  deletion is on-disk only — no git change to review.

**Quality gate:** workspace typecheck + lint clean; vitest green (api 41 incl. 13
new, web 2). gas-app typechecks clean after the deletion.

---

## 2. Current live state

- **Indexer Cloud Run Job `photo-indexer` is deployed** (us-central1).
- First real index run kicked off for **Women mini 10k**:
  - `EVENT_ID = d2307147-0ccc-4dca-be20-2cb6af45cb8d`
  - `DRIVE_FOLDER_ID = 1uFoWUozAcsYewq6kdhrErru0hWMIbbix` (`2026-06-06_Women_mini_10k`)
- The **api has NOT yet been redeployed** with the reconciler code, so the "Sync
  with Drive" button (`POST /api/admin/sync`) is not live yet (see §3).

---

## 3. Remaining human steps

### To make the "Sync with Drive" button live
1. **Add the `spreadsheets.readonly` scope to the DWD client** in the Workspace
   Admin console (runbook §G1 authorized `drive` only). Same client id, one-time.
2. **Set `MASTER_SPREADSHEET_ID`** to the gas-app master Sheet id (the gas-app
   `SPREADSHEET_ID` Script Property). Optionally set `SYNC_TRIGGER_TOKEN` (repo
   secret) for the scheduled trigger.
3. **Redeploy the api** with the new code: `git push` to main (CI), or
   `./infra/scripts/deploy-api.sh mmr-data-pipeline us-central1`.
4. (Optional) Schedule the daily sync:
   `SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-sync-scheduler.sh mmr-data-pipeline us-central1`
5. Trigger a sync (admin Firebase token, or the cron token):
   `curl -X POST -H "X-Sync-Token: <secret>" https://<api>/api/admin/sync`

### To index more events (indexer)
One-time IAM (in `deploy-indexer.sh` header) if not already applied:
- `run.invoker` on the `photo-indexer` job for `api-runtime@` (so the api can
  trigger it once the admin "Index event" button is used).
- `iam.serviceAccountTokenCreator`: `api-runtime@` on `indexer-runtime@`, and
  **`indexer-runtime@` on itself** (so the job can sign its own DWD JWT on Cloud
  Run — required for Drive reads).

Then per event:
```
gcloud run jobs execute photo-indexer --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=EVENT_ID=<id>,DRIVE_FOLDER_ID=<folder>
```
Once the Sync button is live, the `DRIVE_FOLDER_ID` override is unnecessary — the
reconciler writes it to the event doc and the job reads it from Firestore.

**Re-index semantics:** re-running is idempotent (md5 manifest diff — only
new/changed photos are re-embedded; photos deleted from Drive are pruned). Bumping
`model_version` forces a full re-embed.

---

## 4. Verify a run

```
gcloud run jobs executions list --job=photo-indexer --region=us-central1 --project=mmr-data-pipeline
# COMPLETE = 1/1 when done; logs end with a "done: {photoCount, faces, persons}" line.

gcloud firestore documents get \
  "projects/mmr-data-pipeline/databases/(default)/documents/events/<EVENT_ID>" \
  --project=mmr-data-pipeline --format='value(fields.indexState)'
# indexState.status should be "done"; photoCount should reconcile with the Drive folder.
```

---

## 5. References
- `FACE_MATCHING_DEV_PLAN.md` §8 (cutover/ops — the sync design), M1 (indexer).
- `SETUP_NOTES.md` §G1 (DWD), Dev progress log.
- `infra/scripts/deploy-indexer.sh`, `deploy-matcher.sh`, `provision-sync-scheduler.sh`.
