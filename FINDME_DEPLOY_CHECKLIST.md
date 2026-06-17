# Find Me — Deploy Checklist (run on your machine)

Walks the handoff §3 checklist with exact commands. **Nothing here can run from
the Cowork sandbox** (no `gcloud`/`clasp`/git creds) — run these in your own
terminal where your GitHub + GCP auth live.

Constants used below:

| Thing | Value |
|---|---|
| Project | `mmr-data-pipeline` |
| Region | `us-central1` |
| API service | `event-photo-api` |
| Runtime SA | `api-runtime@mmr-data-pipeline.iam.gserviceaccount.com` |
| Uploads bucket | `mmr-data-pipeline-uploads` (config default) |

**Pre-flight already done in this session (no action needed):** api `87/87`,
web `25/25`, gas-app typecheck + touched-file tests green; `shared`/`api`/`web`
all build clean; new env vars have safe defaults; no new Firestore composite
indexes required (admin-feedback orders single-field + filters in memory;
uploads list is a single-field equality query).

---

## 1. Push → CI + auto-deploy of api & web

The commit (`63686aa`) is already made locally. Your `main` is **3 commits
ahead** of `origin/main`. Just push:

```bash
git push origin main
```

This triggers three GitHub Actions automatically:

- **`ci.yml`** — typecheck / lint / test / matcher / indexer (gate).
- **`deploy-api.yml`** — builds the container, deploys Cloud Run `event-photo-api`
  (fires because `api/**` + `shared/**` changed). Ends with a `/api/health` smoke test.
- **`deploy-web.yml`** — builds web + `firebase deploy` hosting / firestore rules /
  indexes / storage (fires because `web/**` + `shared/**` changed).

Watch them: `gh run watch` (or the Actions tab). **Wait for green before the
manual steps below** — the api must be live for the smoke test.

> Note: `deploy-api.yml` uses `--set-env-vars` and does **not** list this
> session's new vars (`UPLOADS_BUCKET`, retention, rate-limit, reCAPTCHA). That's
> fine — the code defaults to the right values. Only set them explicitly if you
> want to override a default (see steps 5–6).

## 2. Deploy gas-app (B8 — not in CI)

The instant metadata-sync (`triggerMetadataSync`) lives in the Apps Script
bundle, which CI does not deploy:

```bash
cd gas-app
clasp login          # if not already authed
npm run push         # build + stamp + clasp push  (scriptId already in .clasp.json)
```

No new Script Properties needed — `FINDME_API_URL` + `INDEX_TRIGGER_TOKEN` are
already set for the existing index trigger.

## 3. Uploads bucket + SA grant (required for reference reuse)

Reference selfies (M3.4 reuse) are persisted to `mmr-data-pipeline-uploads`.
Create it if missing and grant the runtime SA object read/write:

```bash
# create only if it doesn't exist
gcloud storage buckets create gs://mmr-data-pipeline-uploads \
  --project=mmr-data-pipeline --location=us-central1 --uniform-bucket-level-access

# object read+write for the API runtime SA
gcloud storage buckets add-iam-policy-binding gs://mmr-data-pipeline-uploads \
  --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

V4 signing of reference URLs reuses the SA's existing
`serviceAccountTokenCreator`-on-itself binding (already present for the
derivatives bucket) — no extra grant needed.

## 4. Firestore TTL policies (one-time, operational)

So counters and reference records self-delete:

```bash
gcloud firestore fields ttls update expireAt \
  --collection-group=rate_limits --project=mmr-data-pipeline --enable-ttl

gcloud firestore fields ttls update expiresAt \
  --collection-group=find_me_uploads --project=mmr-data-pipeline --enable-ttl
```

Add a matching **object-lifecycle rule** on the uploads bucket so the GCS bytes
are removed too (the Firestore TTL only deletes the record). Use the
**90/30-day reuse tier — do NOT apply the old 7-day working-copy rule**, it
would delete reusable references. Example (90-day delete):

```bash
cat > /tmp/uploads-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}
JSON
gcloud storage buckets update gs://mmr-data-pipeline-uploads \
  --lifecycle-file=/tmp/uploads-lifecycle.json
```

(Or wait for the M5.1 deletion job, which is still open.)

## 5. reCAPTCHA Enterprise (optional, recommended)

The search gate **no-ops until all three are set** — the demo keeps working
either way. To enable:

```bash
gcloud run services update event-photo-api \
  --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=RECAPTCHA_PROJECT_ID=mmr-data-pipeline,RECAPTCHA_SITE_KEY=<site_key>,RECAPTCHA_API_KEY=<api_key>
```

Also set the web site key in the SPA. Client sends the token in
`X-Recaptcha-Token` for `action: findme_search`. Fails **open** on infra error,
**closed** only on a genuinely bad verdict.

> Use `--update-env-vars` (merge) here, never `--set-env-vars` — the latter
> wipes every var the deploy workflow set (MATCHER_URL, SYNC_TRIGGER_TOKEN, …).

## 6. Rate-limit tuning (optional)

Defaults: `FINDME_SEARCH_LIMIT=20`, `FINDME_SEARCH_WINDOW_SEC=60`,
`DOWNLOAD_LIMIT_PER_DAY=50`. `0` disables a bucket; limiter **fails open** on any
Firestore error. Override with `--update-env-vars` as in step 5 if needed.

## 7. B6 — re-index existing events (collapse dupes, populate contentHash)

Outstanding from the earlier backlog. After the api is live, trigger each
already-indexed event with `force:true`. Machine path uses the sync token
(`X-Sync-Token`); `Content-Type: application/json` is mandatory or the body is
ignored:

```bash
API=$(gcloud run services describe event-photo-api \
  --region=us-central1 --project=mmr-data-pipeline --format='value(status.url)')

curl -fsS -X POST "$API/api/events/<EVENT_ID>/index" \
  -H "X-Sync-Token: <SYNC_TRIGGER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"force":true}'
```

(Or click "Index event" in the web admin UI, which auths as a Firebase admin.)
A stale `indexState:"running"` from a crashed run is cleared by the same
`force:true` call. Monitor the job per `CLAUDE.md` (Cloud Run job logs / poll
loop).

## 8. Smoke test (post-deploy)

1. Create an event/upload-link in gas-app → the name appears in the web app
   **within seconds** (B8 instant sync).
2. Run a Find Me search → confirm a `find_me_uploads` doc **and** a
   `gs://mmr-data-pipeline-uploads/...` object appear.
3. Reopen Find Me → the selfie shows in the reuse picker; pick it for a
   *different* event → it returns its own result set.
4. "📲 Save to phone" → share sheet on mobile, file download on desktop.
5. Outfit fallback: a no-face selfie offers "Search by outfit instead".
6. Minor flow: "under 18?" → guardian attestation required before search.
7. `GET /api/admin/feedback` (as admin) returns the feedback queue with counts.

---

## Still NOT covered by this deploy (handoff §4, open)

My Data self-service screen + delete cascade (M3.4 mgmt half), EN/ZH
localization (M3.5), admin feedback **UI** page (M4.4 — API only), retention/
deletion **jobs** (M5.1), consent-revoke cascade (M5.2), budget/SA audit (M5.4),
security-rules tightening + audit logging (M5.5), **legal sign-off on consent +
minor wording (M5.6 — launch gate)**, and M6 pilot/launch. The minor-guardian
*mechanism* ships now; the *copy* is not legally approved.
