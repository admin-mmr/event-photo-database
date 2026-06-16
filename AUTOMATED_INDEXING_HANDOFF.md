# Automated Indexing — Handoff Note

**Date:** 2026-06-15
**Author:** IT
**Scope:** Made photo indexing automatic ("no-touch"), added Events-page controls, and fixed a chain of deploy/auth/IAM issues uncovered along the way.

See also: `AUTOMATED_INDEXING_IMPLEMENTATION.md` (design), `AUTOMATED_INDEXING_RUNBOOK.md` (deploy/ops, incl. §0a Secret Manager and §0b DRS), `CLAUDE.md` (gotchas).

---

## TL;DR — where things stand

- **The core goal is done and verified.** The "Women mini 10k" event
  (`d2307147-0ccc-4dca-be20-2cb6af45cb8d`) is fully indexed: **1598 photos, 0
  skipped, `indexState.status = done`**. The automated trigger path works end to
  end (API → Cloud Run Job with env overrides → embeddings → Firestore).
- **The web app's auth is restored** via a DRS org-policy exception + `allUsers`
  invoker grant (verify with a reload — see "Verify").
- **All code changes are in the working tree.** Some are committed (`b90db9d`),
  the rest are **uncommitted** because of a stuck `.git/index.lock` on the dev
  machine — they must be committed and **pushed** (see "Must-do #1").

---

## Must-do next steps (in order)

1. **Commit + push to `main`.** This is the highest priority: until the fixed
   scripts are on `main`, every CI deploy runs the *old* scripts and re-breaks
   everything (wipes env, strips `allUsers`, fails the smoke test).
   ```bash
   rm -f .git/index.lock
   git add -A
   git commit -m "automated indexing + deploy/auth hardening"
   git push origin main
   ```

2. **Create the `SYNC_TRIGGER_TOKEN` secret** (the new `deploy-api.sh` sources it
   via `--set-secrets`, so the next deploy will FAIL if it doesn't exist):
   ```bash
   printf '%s' "$SYNC_TRIGGER_TOKEN" | gcloud secrets create SYNC_TRIGGER_TOKEN \
     --data-file=- --project=mmr-data-pipeline
   gcloud secrets add-iam-policy-binding SYNC_TRIGGER_TOKEN --project=mmr-data-pipeline \
     --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"
   ```
   (Current token value, set on the service this session:
   `19dc63608dc351e7da27d88fdcf2b32b0ad7b0db05f8dce68e72e3a6f7cf929b` — rotate if
   desired, but keep api + scheduler + gas-app in sync.)

3. **Verify** (see "Verify" below).

4. **Finish the rollout** (optional but completes the no-touch loop):
   - Deploy the web bundle so the Events-page controls show:
     `cd web && npm run build && firebase deploy --only hosting --project mmr-data-pipeline`
   - Provision the scheduled scan:
     `SYNC_TRIGGER_TOKEN=… ./infra/scripts/provision-index-scan-scheduler.sh mmr-data-pipeline us-central1`
   - Wire the gas-app end-of-batch trigger: set Script Properties `FINDME_API_URL`
     + `INDEX_TRIGGER_TOKEN`, grant the Apps Script identity `run.invoker` on the
     api, `clasp push`.

---

## What was built (code)

**Automated indexing trigger (the feature):**
- gas-app fires `POST /api/events/:id/index` at end of upload batch
  (`gas-app/src/services/indexTriggerClient.ts`, called from
  `routes/uploadHandlers.ts`; config getters in `config/superAdmins.ts`).
- Safety-net scan `POST /api/admin/index-scan` + Cloud Scheduler script
  (`api/src/routes/events.ts`, `infra/scripts/provision-index-scan-scheduler.sh`).
- Shared `allowCronOrAdmin` middleware (machine token OR Firebase admin):
  `api/src/middleware/cronAuth.ts`.
- Friendlier Find Me "not indexed yet" 409 with live `indexState`
  (`api/src/routes/findme.ts`).

**Indexer performance/robustness (`cloud-webapp/indexer/`):**
- Parallelized download/embed/upload via a thread pool (`job.py`,
  `INDEX_CONCURRENCY`), deterministic ordering preserved (idempotency intact).
- Drive token refresh on 401 in `drive.py` `download()` (long runs outlive the
  ~1h DWD token; without this, large events lost photos to 401s).
- `deploy-indexer.sh`: 8 GiB / 4 CPU / `INDEX_CONCURRENCY=4` / 7200s timeout
  (prevents the OOM "signal 9" seen at 12 workers).

**Events page UI (`web/src/pages/Events.tsx`, `styles.css`):**
- Per-event "Index now" button (admin-enforced, optimistic + polling).
- Event name, photo count, last-updated, colored status pill.
- New `indexState.updatedAt` (shared schema + stamped by indexer & api).

**Deploy hardening (`infra/scripts/deploy-api.sh`):**
- `--update-env-vars` (merge), not `--set-env-vars` (replace) — stops env wipes.
- `SYNC_TRIGGER_TOKEN` via `--set-secrets` (Secret Manager) — can't be blanked.
- `MATCHER_URL` auto-resolved from the `matcher` service — no shell var needed.
- No `--no-allow-unauthenticated` — stops stripping the `allUsers` binding.
- Smoke test treats 401/403 as "up & auth-gated"; only 5xx/unreachable fails CI.

**Tests:** api 47/47, web 2/2, indexer 10/10; web + gas-app typecheck clean.

---

## Infra/IAM state (hard-won this session)

- **`event-photo-api` must be publicly invokable** (`allUsers`/`run.invoker`).
  Classic Firebase Hosting → Cloud Run requires it; the app does its own auth.
  A private service returns an **HTML 401 from Cloud Run IAM** before reaching
  the app (no app log line). DRS blocked re-adding `allUsers`; a **project-scoped
  DRS exception** (`iam.allowedPolicyMemberDomains` → Allow All) was applied, then
  `allUsers` was granted. Runbook §0b.
- **`api-runtime@` has `roles/run.developer`** on the `photo-indexer` job — the
  API triggers with env overrides, which needs `run.jobs.runWithOverrides`
  (`run.invoker` only has plain `run.jobs.run`).
- `SYNC_TRIGGER_TOKEN` and `MATCHER_URL` are currently set on the live service;
  they had been repeatedly wiped by `--set-env-vars` redeploys (now fixed).

---

## Verify

```bash
URL=$(gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format='value(status.url)')

# 1. Web app: reload mmr-data-pipeline.web.app → events load; Find Me returns matches.
# 2. Index state of the demo event:
curl -s "https://firestore.googleapis.com/v1/projects/mmr-data-pipeline/databases/(default)/documents/events/d2307147-0ccc-4dca-be20-2cb6af45cb8d" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" | python3 -m json.tool
# 3. Machine trigger path (needs OIDC for IAM + token for the app gate):
curl -s -X POST "$URL/api/admin/index-scan" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "X-Sync-Token: $SYNC_TRIGGER_TOKEN" -d '{}'
```

---

## Known follow-ups (not done)

- **Incremental checkpointing** in the indexer: the store is written only at the
  END of a run, so a killed run (timeout/OOM) makes no progress. Large events
  benefit from periodic store writes so interrupted runs resume.
- **Instant metadata sync:** have the gas-app call `/api/admin/sync` on event/link
  creation so steps 1–2 don't wait for the daily reconciler. (Also: the daily
  `findme-drive-sync` scheduler may lack an OIDC token and never have worked
  against the private service — verify.)
- **Selfie reuse / enrollment (PRD D6/D7):** the reference selfie is still
  in-memory per request; "reuse my previous selfie" is not built.
- **Web UI polling:** consume the new `retryable`/`status` fields from the Find
  Me 409 to auto-retry while indexing is in progress.

---

## Key gotchas (full list in CLAUDE.md)

- macOS has no `watch`; use a `while` loop. Tail jobs with `gcloud beta logging tail`.
- `curl -d` defaults to form-encoding → pass `-H "Content-Type: application/json"`
  or Express ignores the body (e.g. `{"force":true}` silently became `false`).
- A stale `indexState:"running"` blocks new triggers (409); clear with `{"force":true}`.
- Don't test app-level Firebase auth via a raw `*.run.app` curl — Cloud Run
  consumes the `Authorization` bearer for IAM. Use the Hosting domain.
