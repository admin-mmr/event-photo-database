# Find Me — Operations Runbook (M6.3)

Operate the "Find Me" face/person matching feature: **deploy, enable the pilot,
re-index, measure, respond to incidents, and delete user data.** This is the
launch-and-run companion to the design docs (`FACE_MATCHING_FEATURE_PRD.md`,
`FACE_MATCHING_DEV_PLAN.md`) and folds in the hard-won operational notes from
the repo-root `CLAUDE.md`, `AUTOMATED_INDEXING_RUNBOOK.md`, and
`FINDME_DEPLOY_CHECKLIST.md`.

> Most commands need `gcloud`/`firebase`/`clasp` + GCP/GitHub auth and must run
> from an operator's own terminal, not a sandbox.

---

## 1. System at a glance

| Component | What it is | How it deploys |
|---|---|---|
| **`event-photo-api`** | Node/Express on Cloud Run. All Find Me routes. **Publicly invokable** — the app does its own auth (see below). | CI (`deploy-api.yml`) on push to `main` touching `api/**` or `shared/**` |
| **web** | React/Vite SPA on Firebase Hosting (site `mmr-data-pipeline`). Rewrites `/api/**` → the api service. | CI (`deploy-web.yml`) on push touching `web/**`, `shared/**`, `firebase.json`, or `infra/*.rules`/indexes |
| **matcher** | Python Cloud Run service, **private** (no public invoke), CPU, scale-to-zero. Online query embeddings. | **Manual** — `infra/scripts/deploy-matcher.sh` (not in CI) |
| **`photo-indexer`** | Python Cloud Run **Job**. One execution = one event. Bulk embed + Drive→GCS mirror. | **Manual** — `infra/scripts/deploy-indexer.sh` (not in CI) |
| **gas-app** | Apps Script admin workflow. Fires `triggerEventIndex` (end of upload batch) and `triggerMetadataSync` (event/link creation). | **Manual** — `clasp push` |

**Constants**

| Thing | Value |
|---|---|
| Project | `mmr-data-pipeline` |
| Region | `us-central1` |
| Runtime SAs | `api-runtime@`, `matcher-runtime@`, `indexer-runtime@` (per-service, least privilege) |
| Buckets | `…-derivatives` (thumb/web/orig serving copies), `…-uploads` (reference selfies under `find_me_references/<uid>/<uploadId>.<ext>`), `…-models` (ONNX weights) |

**Firestore collections:** `events`, `photos`, `consents`, `match_runs`,
`match_feedback`, `find_me_uploads`, `rate_limits`.

**Auth model (enforced in-app, not by Cloud Run IAM):**

- `requireAuth` — Firebase ID token (any signed-in user).
- `requireAdmin` — email in `ADMIN_EMAILS` (default `admin@mmrunners.org`) **and** verified.
- `allowCronOrAdmin` — a Firebase admin **or** a machine caller presenting the
  `X-Sync-Token` secret (Cloud Scheduler / gas-app). Used by `/events/:id/index`,
  `/admin/index-scan`, `/admin/sync`.

> **Why the api is public.** Classic Firebase Hosting → Cloud Run rewrites send
> the browser's *Firebase* token, not an IAM credential. If the service were
> IAM-private, Cloud Run would reject that token with an **HTML 401 before the
> request reaches the app** (no app log line). The service must keep its
> `allUsers`/`run.invoker` binding. **Never deploy with
> `--no-allow-unauthenticated`** — it strips that binding and breaks the web app.

---

## 2. Deploy

### 2.1 Normal path — push to `main`

```bash
git push origin main
```

This fans out to three GitHub Actions (Workload Identity Federation, no static keys):

- **`ci.yml`** — typecheck / lint / test for `shared`+`api`+`web`, plus `matcher`
  and `indexer` pytest. The gate.
- **`deploy-api.yml`** — builds + pushes the container, `gcloud run deploy
  event-photo-api`, then a `/api/health` smoke test. Fires on `api/**`/`shared/**`.
- **`deploy-web.yml`** — builds web and `firebase deploy --only
  hosting,firestore:rules,firestore:indexes,storage`. Fires on `web/**`/`shared/**`/rules.

Watch with `gh run watch` and **wait for green before any manual step** — the
api must be live for the smoke test.

### 2.2 Environment-variable gotcha (read before setting any env)

`deploy-api.yml` deploys with **`--set-env-vars`**, listing only:
`NODE_ENV, GCP_PROJECT_ID, FIREBASE_PROJECT_ID, GIT_COMMIT_SHA, MATCHER_URL,
MASTER_SPREADSHEET_ID, SYNC_TRIGGER_TOKEN`.

Consequences:

1. Every other env var (`UPLOADS_BUCKET`, `REFERENCE_RETENTION_DAYS_*`,
   `FINDME_SEARCH_LIMIT`, `RECAPTCHA_*`, **`FINDME_ENABLED`**,
   **`FINDME_EVENT_ALLOWLIST`**, …) falls back to its **code default** in
   `api/src/lib/config.ts`. The defaults are production-safe.
2. To override a default at runtime, use **`gcloud run services update
   --update-env-vars`** (merge). **Never run a manual `--set-env-vars`** — it
   wipes `MATCHER_URL`/`SYNC_TRIGGER_TOKEN` and breaks search/sync.
3. ⚠️ **A value you set with `--update-env-vars` is erased on the next api
   deploy**, because the workflow's `--set-env-vars` only re-applies its own
   list. For anything that must survive deploys (e.g. the pilot allowlist, a
   reCAPTCHA key), add it as a **repo Variable/Secret and to the workflow's
   `--set-env-vars` line** — the same pattern `MATCHER_URL` already uses.

### 2.3 Manual deploys (not in CI)

**matcher** and **indexer** pull ~184 MB ONNX weights staged once in
`gs://mmr-data-pipeline-models` (Cloud Build pulls them in-cloud):

```bash
cd cloud-webapp
./infra/scripts/deploy-matcher.sh  mmr-data-pipeline us-central1
./infra/scripts/deploy-indexer.sh  mmr-data-pipeline us-central1
```

After the matcher is up, set its URL so the api can reach it (durably — repo
Variable `MATCHER_URL`, consumed by `deploy-api.yml`). Until `MATCHER_URL` is
set, `/api/findme/*` returns a clean `503`.

**gas-app** (instant metadata sync lives here, not in CI):

```bash
cd gas-app && clasp login && npm run push
```

---

## 3. Pilot enablement (M6.1) and rollout (M6.4)

Find Me search is gated by a two-knob feature flag, evaluated per search in
`runSearch` **before any biometric processing**:

| Env | Default | Effect |
|---|---|---|
| `FINDME_ENABLED` | `true` | Global kill switch. `false` → every search returns `403 feature_unavailable`. |
| `FINDME_EVENT_ALLOWLIST` | `""` (empty) | Comma-separated event IDs. Empty = **all** events allowed. Set = only those events accept search; others get `403 feature_unavailable`. |

**Defaults leave Find Me fully on**, so nothing changes until you opt into the gate.

**Turn the pilot on for one event** (durable — survives deploys):
`FINDME_EVENT_ALLOWLIST` is already wired into `deploy-api.yml` (it reads the
repo Variable `vars.FINDME_EVENT_ALLOWLIST` and passes it through
`--set-env-vars`, the same pattern as `MATCHER_URL`). So you only set the repo
Variable and let the next deploy pick it up:

```
GitHub → Settings → Secrets and variables → Actions → Variables →
  New repository variable: FINDME_EVENT_ALLOWLIST = <PILOT_EVENT_ID>
# then re-run deploy-api (push, or "Run workflow" on deploy-api.yml)
```

Unset = empty = all events allowed (default-permissive). For a quick (transient,
**wiped on the next api deploy**) test without touching the repo Variable:

```bash
gcloud run services update event-photo-api \
  --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=FINDME_EVENT_ALLOWLIST=<PILOT_EVENT_ID>
```

**Emergency stop** (fastest mitigation, no redeploy):

```bash
gcloud run services update event-photo-api \
  --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=FINDME_ENABLED=false
```

**General rollout (M6.4):** clear `FINDME_EVENT_ALLOWLIST` (empty = all events)
and remove the override.

---

## 4. Re-index an event

One Job execution embeds one event; the store/manifest are written only at the
**end** of a run, so a killed run makes no progress.

```bash
API=$(gcloud run services describe event-photo-api \
  --region=us-central1 --project=mmr-data-pipeline --format='value(status.url)')

# force:true re-runs from scratch (also clears a stale indexState:"running")
curl -fsS -X POST "$API/api/events/<EVENT_ID>/index" \
  -H "X-Sync-Token: <SYNC_TRIGGER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"force":true}'
```

- `Content-Type: application/json` is **mandatory** — `curl -d` defaults to form
  encoding and the body (`{"force":true}`) is silently ignored otherwise.
- A stale `indexState:"running"` from a crashed run blocks new triggers with
  `409 already_running`; the same `force:true` call clears it.
- Large events (~1600 photos, CPU) need ≥ **8 GiB** memory and modest
  `INDEX_CONCURRENCY` (~4) to avoid OOM; the Drive token refreshes on 401
  mid-run.
- Admins can also click **"Index event"** in the web admin UI (Firebase-auth path).

**Monitor** (per `CLAUDE.md`):

```bash
# tail logs live (needs: gcloud components install beta)
gcloud beta logging tail \
  'resource.type="cloud_run_job" AND resource.labels.job_name="photo-indexer"' \
  --project=mmr-data-pipeline --format='value(textPayload)'

# poll executions (macOS has no `watch`; use a loop)
while :; do clear; \
  gcloud run jobs executions list --job=photo-indexer \
    --region=us-central1 --project=mmr-data-pipeline --limit=3; \
  sleep 15; done
```

---

## 5. Metrics (M6.2)

### 5.1 Live roll-up endpoint

`GET /api/admin/metrics?eventId=<id>&sinceDays=90` (admin only) aggregates from
Firestore over the window:

```json
{
  "ok": true,
  "window": { "sinceDays": 90, "since": "…", "eventId": "ev1" },
  "searches": 0, "distinctSearchers": 0,
  "searchesByMode": { "fused": 0, "person": 0 },
  "minorSearches": 0,
  "consent": { "records": 0, "coverage": 1 },
  "feedback": { "confirmed": 0, "not_me": 0, "precision": null },
  "dataDeletions": 0
}
```

### 5.2 PRD §2 metric → where to read it

| PRD §2 goal | Source |
|---|---|
| Adoption (% who search & download ≥1) | `searches` / `distinctSearchers` from the endpoint. **Download count is not yet stored** — count `/api/download` requests in Cloud Run logs, or add a counter later. |
| Precision@20 ≥ 0.85 | `feedback.precision` (judged-precision proxy) + spot audits per `EVAL_FEEDBACK_LOOP.md`. |
| Recall ≥ 0.80 | Labeled holdout via `eval/run_eval.py` — out of band. |
| p95 latency ≤ 6 s | Cloud Monitoring request latency for `event-photo-api` + `matcher`. |
| Spend ≤ $40/mo | Billing / the budget alert (`infra/scripts/provision-budget-guardrails.sh`, M5.4). |
| Consent coverage 100%, 0 retention incidents | `consent.coverage` (consent is written before every search, so this should read `1.0`; a dip flags a search path that skipped consent). Incidents tracked manually. |
| ≥ 70% volunteer-request deflection | Qualitative — compare "find my photos" request volume before/after. |

---

## 6. Incident response

| Symptom | Likely cause | Action |
|---|---|---|
| Web app: blank / **HTML** 401 after sign-in, no app log line | `allUsers`/`run.invoker` binding stripped (a `--no-allow-unauthenticated` deploy, or DRS policy) | Re-add `allUsers` `run.invoker` (needs an Org Policy DRS exception). Never deploy with `--no-allow-unauthenticated`. |
| `/api/findme/*` → `503` | `MATCHER_URL` empty, or matcher down/cold | Confirm `MATCHER_URL` env; check the matcher service/logs; redeploy matcher if needed. |
| `/api/admin/sync` → `503` | `MASTER_SPREADSHEET_ID` empty, or Sheets scope not granted on the DWD client | Set the repo Variable; authorize `spreadsheets.readonly` on the DWD client (`SETUP_NOTES.md` G1). |
| search → `409 event_not_indexed` | Event not indexed / indexing in progress | Trigger an index (§4) and watch the Job. Message is retryable; results appear automatically. |
| `POST …/index` → `409 already_running` | Stale `indexState:"running"` from a crashed run | Re-trigger with `{"force":true}`. |
| search → `403 feature_unavailable` | Event not in `FINDME_EVENT_ALLOWLIST`, or `FINDME_ENABLED=false` | Expected during a gated pilot. Adjust the flag (§3) if unintended. |
| search → `403 guardian_required` | Minor subject without guardian attestation | Expected (D8). User must confirm guardian consent. |
| search → `403 consent_required` | `consent` flag not sent | Client bug — the consent gate must POST `consent=true`. |
| Bursts of `429` on search/download | Rate limit hit | Tune `FINDME_SEARCH_LIMIT` / `DOWNLOAD_LIMIT_PER_DAY` via `--update-env-vars`. The limiter **fails open** on Firestore errors, so 429s are real volume. |

**Error logs** (the real exception, not just the status):

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="event-photo-api" AND severity>=ERROR' \
  --project=mmr-data-pipeline --limit=5 \
  --format='value(jsonPayload.err.message, jsonPayload.msg, textPayload)'
```

> reCAPTCHA and the rate limiter are **defence-in-depth and fail open** on infra
> errors — they must never lock real attendees out. reCAPTCHA fails *closed*
> only on a genuinely bad verdict.

---

## 7. Data deletion / subject requests

**User self-service (live):**

- `DELETE /api/findme/me/data` (auth) — full erasure / consent revoke (M5.2).
  Cascades across `find_me_uploads` (**+ the GCS reference objects**),
  `consents`, `match_runs`, `match_feedback`, then writes a `data_deleted`
  **audit record** to `consents` (after the purge, so the trace survives).
  Returns per-collection counts.
- `DELETE /api/findme/uploads/:uploadId` (auth) — delete one saved selfie
  (record + GCS object). Owner-scoped; another user's id returns `404`.

**Automatic retention** (PRD §8.4 — 90 days adult / 30 days minor):

- Firestore TTL on `find_me_uploads.expiresAt` and `rate_limits.expireAt`
  (enable once with `gcloud firestore fields ttls update …`).
- A matching **object-lifecycle rule on the uploads bucket** removes the GCS
  bytes — the TTL only deletes the Firestore record. Use the **90-day reuse
  tier**, *not* the old 7-day working-copy rule (it would delete reusable
  references).

> ⚠️ **Open gap:** the coordinated M5.1 retention/deletion Job is **not built
> yet**, and there is **no admin "delete another user's data" endpoint**
> (`deleteAllUserData` is uid-scoped only; M5.2 deferred the admin variant).
> Until M5.1 lands, rely on the TTLs + bucket lifecycle for routine cleanup, and
> handle an operator-initiated erasure by running the user-scoped cascade. Track
> this as a launch caveat.

---

## 8. Rollback

- **Fastest mitigation:** `FINDME_ENABLED=false` (§3) disables all search
  instantly, no redeploy.
- **api:** shift traffic to a known-good revision —
  `gcloud run services update-traffic event-photo-api --region=us-central1
  --to-revisions=<REVISION>=100` — or revert the commit and push.
- **web:** `firebase hosting:rollback` (or redeploy the previous build).
- **matcher / indexer:** re-run the deploy script against the previous image tag.

---

## 9. Pre-launch checklist (M6 gate)

- [ ] **Legal sign-off on consent + minor-guardian wording (M5.6)** — the
      *mechanism* ships; the *copy* is the launch gate.
- [ ] matcher deployed and `MATCHER_URL` set (durably, as a repo Variable).
- [ ] uploads bucket exists; `api-runtime@` has `objectAdmin`; bucket lifecycle
      (90-day) + Firestore TTLs (`find_me_uploads.expiresAt`,
      `rate_limits.expireAt`) enabled.
- [ ] reCAPTCHA keyed (optional but recommended) and rate limits tuned.
- [ ] budget alert live (`provision-budget-guardrails.sh`); per-service runtime
      SAs verified (M5.4).
- [ ] pilot event fully indexed; B6 re-run done on already-indexed events.
- [ ] `FINDME_EVENT_ALLOWLIST` set to the single pilot event id.
- [ ] smoke test: create event/link in gas-app → name appears in seconds; run a
      search → `find_me_uploads` doc + GCS object appear; reuse a past selfie;
      "Save to phone"; outfit fallback; minor/guardian gate; `GET
      /api/admin/metrics` returns sane numbers.

---

## 10. Quick reference

| Task | Command |
|---|---|
| Deploy api + web | `git push origin main` (CI) |
| Deploy matcher / indexer | `./infra/scripts/deploy-{matcher,indexer}.sh mmr-data-pipeline us-central1` |
| Deploy gas-app | `cd gas-app && npm run push` |
| Re-index an event | `curl -X POST $API/api/events/<ID>/index -H 'X-Sync-Token: …' -H 'Content-Type: application/json' -d '{"force":true}'` |
| Enable pilot event (durable) | Set repo Variable `FINDME_EVENT_ALLOWLIST=<ID>` (already wired into `deploy-api.yml`), then re-run deploy. Transient: `gcloud run services update event-photo-api --region=us-central1 --update-env-vars=FINDME_EVENT_ALLOWLIST=<ID>` |
| Kill switch | `--update-env-vars=FINDME_ENABLED=false` |
| Metrics | `GET /api/admin/metrics?eventId=<ID>&sinceDays=90` (admin) |
| Tail indexer logs | `gcloud beta logging tail 'resource.type="cloud_run_job" AND resource.labels.job_name="photo-indexer"' --project=mmr-data-pipeline --format='value(textPayload)'` |
