# Automated Indexing — Deploy & Ops Runbook

Companion to `AUTOMATED_INDEXING_IMPLEMENTATION.md`. Conventions follow `FACE_MATCHING_SETUP_RUNBOOK.md`: project `mmr-data-pipeline`, region `us-central1`. All steps are keyless. Run from `cloud-webapp/` unless noted.

> Order matters: deploy the indexer and api first, then set the gas-app Script Properties, then provision the scheduler. The system degrades safely at every intermediate step — an unconfigured trigger no-ops; the daily sync and manual indexing keep working throughout.

## 0. Prerequisites (one-time, verify)

- `api-runtime@mmr-data-pipeline.iam.gserviceaccount.com` has `roles/run.developer` on the `photo-indexer` job. The API triggers the job with per-execution env overrides (`EVENT_ID`), so the platform requires `run.jobs.runWithOverrides` — which `roles/run.invoker` does NOT grant (it only has plain `run.jobs.run`). Use `run.developer`:

  ```bash
  gcloud run jobs add-iam-policy-binding photo-indexer --region=us-central1 \
    --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
    --role="roles/run.developer" --project=mmr-data-pipeline
  ```

  (If your org doesn't evaluate `run.developer` at job scope, grant it at project level: `gcloud projects add-iam-policy-binding mmr-data-pipeline --member="serviceAccount:api-runtime@…" --role="roles/run.developer"`.)

- A shared secret exists. Reuse the **same** `SYNC_TRIGGER_TOKEN` already deployed for `findme-drive-sync`. Retrieve it (Secret Manager or your records) and keep it handy as `$TOKEN`. If you don't have one yet, generate: `openssl rand -hex 32`.
- `cloudscheduler.googleapis.com` is enabled (it is, from the daily sync).

> **The api is private (`--no-allow-unauthenticated`).** Cloud Run's IAM layer
> rejects unauthenticated calls *before* the `X-Sync-Token` gate runs — a raw
> `curl` (or a scheduler/gas-app call with only the header) gets an **HTML "403
> Forbidden" from Google**, not our JSON. Every machine caller must also present
> a Google **OIDC token** whose identity has `roles/run.invoker` on
> `event-photo-api`. This affects steps 3 (gas-app), 4 (scheduler), and any
> manual `curl` verification.

Pick the OIDC identity the schedulers will authenticate as and grant it invoker (reuse the daily-sync SA if it already has one):

```bash
# What does the daily sync use today? (empty = it has no OIDC and likely doesn't work against the private service yet)
gcloud scheduler jobs describe findme-drive-sync --location=us-central1 --project=mmr-data-pipeline \
  --format='value(httpTarget.oidcToken.serviceAccountEmail)'

# Grant that SA (or a dedicated one) invoker on the api:
gcloud run services add-iam-policy-binding event-photo-api --region=us-central1 \
  --member="serviceAccount:<oidc-sa-email>" --role="roles/run.invoker" --project=mmr-data-pipeline
```

Verify the endpoint manually with BOTH tokens (your user needs invoker — owners have it):

```bash
URL=$(gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format='value(status.url)')
curl -s -X POST "$URL/api/admin/index-scan" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "X-Sync-Token: $TOKEN" -d '{}'
```

## 0a. SYNC_TRIGGER_TOKEN in Secret Manager (one-time)

The shared machine-caller secret is sourced from Secret Manager via
`deploy-api.sh`'s `--set-secrets`, so every deploy (manual or CI) sets it
automatically and it can never be blanked by a shell/CI env that lacks it.
Create it once and grant the api runtime access:

```bash
# Use your existing token value, or generate one: openssl rand -hex 32
printf '%s' "$SYNC_TRIGGER_TOKEN" | gcloud secrets create SYNC_TRIGGER_TOKEN \
  --data-file=- --project=mmr-data-pipeline
gcloud secrets add-iam-policy-binding SYNC_TRIGGER_TOKEN --project=mmr-data-pipeline \
  --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

To rotate later: `printf '%s' "<new>" | gcloud secrets versions add SYNC_TRIGGER_TOKEN --data-file=-`,
then redeploy the api and update the scheduler + gas-app Script Property to match.

> If `SYNC_TRIGGER_TOKEN` was previously set as a **plain env var** on the
> service, the first deploy with `--set-secrets` will replace it with the
> secret-backed value (Cloud Run forbids the same key as both). That's expected.

## 0b. Web app access — public invoke + DRS exception (one-time)

The `event-photo-api` Cloud Run service **must be publicly invokable**
(`allUsers` → `roles/run.invoker`). The app does its own auth
(`requireAuth`/`requireAdmin`/`X-Sync-Token`), and classic Firebase Hosting →
Cloud Run rewrites require a public service — there is no Hosting service
account to authorize (the `service-<num>@gcp-sa-firebasehosting…` SA does not
exist for classic rewrites). If the service is private, the browser's Firebase
token (not a Google IAM credential) is rejected by Cloud Run IAM with an **HTML
401** *before* reaching the app, and there is **no app log line**.

> Symptom: web app shows `Could not load events: GET /api/events failed: HTTP 401`
> and the response body is Google's HTML `401 Unauthorized` page (not our JSON).

**Do NOT deploy with `--no-allow-unauthenticated`** — it strips the `allUsers`
binding on every deploy. `deploy-api.sh` now passes neither auth flag, leaving
IAM untouched.

The org's **Domain Restricted Sharing** policy
(`constraints/iam.allowedPolicyMemberDomains`) blocks adding `allUsers`:

```
FAILED_PRECONDITION: One or more users named in the policy do not belong to a
permitted customer, perhaps due to an organization policy.
```

To allow it, an **Org Policy Administrator** adds a **project-scoped** exception,
then re-grants the binding:

1. Inspect current state:
   ```bash
   gcloud run services get-iam-policy event-photo-api --region=us-central1 --project=mmr-data-pipeline
   gcloud org-policies describe iam.allowedPolicyMemberDomains --project=mmr-data-pipeline
   ```
2. Override the constraint for **this project only** (Console: IAM & Admin →
   Organization Policies → "Domain restricted sharing" → select project
   `mmr-data-pipeline` → Manage policy → Override parent's policy → Add rule →
   Allow All → Save). Or via gcloud:
   ```bash
   cat > /tmp/drs-allow.yaml <<'EOF'
   name: projects/mmr-data-pipeline/policies/iam.allowedPolicyMemberDomains
   spec:
     inheritFromParent: false
     rules:
       - allowAll: true
   EOF
   gcloud org-policies set-policy /tmp/drs-allow.yaml
   ```
   (Needs `roles/orgpolicy.policyAdmin`.) Keep the override scoped to the
   project, never the org — it relaxes DRS for the whole project, which is
   acceptable here because every endpoint enforces its own app-level auth.
3. Re-grant public invoke (wait ~1 min for the policy to propagate):
   ```bash
   gcloud run services add-iam-policy-binding event-photo-api \
     --region=us-central1 --project=mmr-data-pipeline \
     --member=allUsers --role=roles/run.invoker
   ```
4. Reload `mmr-data-pipeline.web.app` — events load and Find Me works.

Because `deploy-api.sh` no longer touches IAM, this binding survives future
deploys. If a CI run on stale `main` re-strips it, push the current scripts to
`main` (the fix) and re-run step 3.

## 1. Deploy the parallelized indexer

```bash
./infra/scripts/deploy-indexer.sh mmr-data-pipeline us-central1
```

This rebuilds the image and redeploys the Job with `--cpu=4 --memory=4Gi` and `INDEX_CONCURRENCY=8`. To tune concurrency without a full redeploy:

```bash
gcloud run jobs update photo-indexer --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=INDEX_CONCURRENCY=12
```

Smoke test on one event (idempotent; reuses unchanged photos):

```bash
gcloud run jobs execute photo-indexer --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=EVENT_ID=<eventId>
# watch:
gcloud run jobs executions list --job=photo-indexer --region=us-central1 --project=mmr-data-pipeline
```

Confirm the event doc's `indexState.status` reaches `done` in Firestore and the run is faster than before for a multi-photo event.

## 2. Deploy the api

The api must carry `SYNC_TRIGGER_TOKEN` (already set for the daily sync; no new env var needed). Redeploy to pick up the new `index-scan` route, the shared `cronAuth` middleware, the machine-token path on `/events/:id/index`, and the friendlier Find Me 409.

```bash
./infra/scripts/deploy-api.sh mmr-data-pipeline us-central1   # or the deploy-api.yml GH Action
```

Verify the token path works end-to-end. Both tokens are required (OIDC for the Cloud Run IAM gate, `X-Sync-Token` for the app gate) — see the prerequisites note:

```bash
URL=$(gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format='value(status.url)')
OIDC="Authorization: Bearer $(gcloud auth print-identity-token)"
# manual scan (should 200 with a triggered/skipped report):
curl -s -X POST "$URL/api/admin/index-scan" -H "$OIDC" -H "X-Sync-Token: $TOKEN" -H 'Content-Type: application/json' -d '{}' | jq .
# direct event trigger via the machine path (should 202):
curl -s -X POST "$URL/api/events/<eventId>/index" -H "$OIDC" -H "X-Sync-Token: $TOKEN" -d '{}' | jq .
```

A valid OIDC token + wrong/empty `X-Sync-Token` returns our JSON 401. Missing/invalid OIDC returns Google's **HTML** 403 (never reaches our code).

## 3. Configure the gas-app (end-of-batch trigger)

In the Apps Script project, set two Script Properties (Project Settings → Script Properties), then redeploy with clasp:

- `FINDME_API_URL` = the `event-photo-api` URL from step 2 (e.g. `https://event-photo-api-xxxx.a.run.app`)
- `INDEX_TRIGGER_TOKEN` = the **same** value as the api's `SYNC_TRIGGER_TOKEN`

The gas-app sends its OIDC identity token (`ScriptApp.getIdentityToken()`) for the Cloud Run IAM gate, so that identity needs `run.invoker` on the api. It's the same Apps Script identity already used for the image-convert service; confirm/grant it:

```bash
gcloud run services add-iam-policy-binding event-photo-api --region=us-central1 \
  --member="serviceAccount:<apps-script-identity>" --role="roles/run.invoker" --project=mmr-data-pipeline
```

```bash
cd ../gas-app
clasp push
```

Verify: run an upload of one photo through the volunteer/admin upload page, then check the api logs for `index job triggered` and the event's `indexState` flipping to `queued`/`running`. If the properties are unset, the trigger logs `not_configured` and no-ops (safe). If you see `[indexTrigger] … HTTP 403`, the OIDC identity lacks `run.invoker`.

## 4. Provision the scheduled scan (safety net)

The script attaches an OIDC token; by default it reuses the daily-sync job's service account. If that job has none, export `OIDC_SA=<sa-email>` (a SA with `run.invoker` on the api — see prerequisites).

```bash
cd ../cloud-webapp
SYNC_TRIGGER_TOKEN=$TOKEN ./infra/scripts/provision-index-scan-scheduler.sh mmr-data-pipeline us-central1
#   …or with an explicit identity:
# OIDC_SA=<sa-email> SYNC_TRIGGER_TOKEN=$TOKEN ./infra/scripts/provision-index-scan-scheduler.sh mmr-data-pipeline us-central1
# one-off run:
gcloud scheduler jobs run findme-index-scan --location=us-central1 --project=mmr-data-pipeline
```

Default cadence is every 10 minutes. Override at provision time: `SCAN_SCHEDULE="*/5 * * * *" SYNC_TRIGGER_TOKEN=$TOKEN ./infra/scripts/provision-index-scan-scheduler.sh …`.

## 5. Verify the full loop

1. Upload a fresh batch via the gas-app upload page.
2. Within seconds (end-of-batch trigger) — or within one scan interval (backstop) — the event's `indexState` goes `queued` → `running` → `done`.
3. In Find Me, submit a selfie for that event: matches appear. If you search mid-run, you get the friendly in-progress 409 (`retryable: true`) rather than "ask an admin."
4. Upload a second batch; confirm new photos become matchable after the next index (more matches over time).

## Tuning knobs

- Indexer fan-out: `INDEX_CONCURRENCY` (job env). Raise for I/O-bound speedups; watch memory.
- Scan cadence: `SCAN_SCHEDULE` (re-run the provision script).
- Scan scope/cost: `index-scan` accepts `activeWithinDays` (default 21) and `limit` (default 25) as query/body params; set them in the scheduler's `--message-body` if you need a wider/narrower window.

## Rollback

- **Disable the scheduled scan:** `gcloud scheduler jobs pause findme-index-scan --location=us-central1 --project=mmr-data-pipeline` (or `delete`).
- **Disable the end-of-batch trigger:** clear the `FINDME_API_URL` (or `INDEX_TRIGGER_TOKEN`) Script Property — `triggerEventIndex` immediately no-ops; uploads are unaffected.
- **Revert indexer throughput:** redeploy with `INDEX_CONCURRENCY=1` (serial) — `gcloud run jobs update photo-indexer --update-env-vars=INDEX_CONCURRENCY=1 …` — or roll back the image. Output is identical regardless of concurrency.
- **Revert api routes:** redeploy the previous api revision (`gcloud run services update-traffic event-photo-api --to-revisions=<prev>=100`). Manual `POST /events/:id/index` by a Firebase admin always remains available.

## Cost notes

The scan launches at most `limit` Job executions per interval, and each is a near-no-op when nothing changed (Drive listing + manifest load + no-op store write). At expected event volumes this is well inside the free tier; the `$10` budget alert from SETUP_NOTES Phase J still applies. If event count grows large, lower `limit`, narrow `activeWithinDays`, or lengthen `SCAN_SCHEDULE` — the end-of-batch trigger remains the primary, on-demand path.

## Operational checks

- API logs: `index job triggered`, `index-scan complete` (with `triggered`/`scanned` counts).
- gas-app logs (Apps Script executions): `[indexTrigger] event <id>: indexing triggered (HTTP 202)`.
- A run stuck in `running`: the Job timed out (1h) or failed — check `gcloud run jobs executions list`; the next scan re-triggers once `indexState` is no longer in-flight (it sets `failed` on error).
