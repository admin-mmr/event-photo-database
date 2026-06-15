# Deployment guide

End-to-end: from "billing account active in `console.cloud.google.com`" to
"new code on every push to main deploys automatically."

---

## 0. Project reference

The concrete values for this deployment. Wherever a command below says
`<project-id>`, use `mmr-data-pipeline`.

| What | Value |
|---|---|
| Project ID | `mmr-data-pipeline` |
| Project number | `489676654863` |
| Region | `us-central1` |
| Live site | `https://mmr-data-pipeline.web.app` |

To find the project ID yourself at any time:

```bash
gcloud config get-value project   # the currently active project
gcloud projects list              # every project you can access
```

In the Cloud Console it's in the project picker at the top — use the **ID**
(e.g. `mmr-data-pipeline`), not the display name or the numeric number.

None of these are secrets — the project ID and number ship in the web
client config and appear throughout this repo. Real secrets (deploy
credentials) live in GitHub Actions secrets via Workload Identity
Federation; see §2.

---

## 1. Bootstrap GCP (one time)

After your billing account is set up, you have a project. Pick one project
ID for the whole webapp — keep dev and prod separate later if needed.

```bash
cd cloud-webapp

# If you'll be wiring CI/CD, export the GitHub repo first so the script
# also configures Workload Identity Federation.
export GITHUB_REPO=mmr/event-photo-database

./infra/scripts/bootstrap-gcp.sh <your-project-id>
```

The script is idempotent. It enables the required APIs, creates the
deploy service account with minimum roles, creates the Firestore database
in Native mode, creates the Artifact Registry repo, and prints the values
to paste into GitHub repo secrets.

Then edit `infra/.firebaserc` and replace `REPLACE_WITH_YOUR_GCP_PROJECT_ID`
with your project ID.

---

## 2. Configure GitHub secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
Paste in the four values the bootstrap script printed:

| Secret name | Value |
|---|---|
| `GCP_PROJECT_ID` | your project ID |
| `GCP_REGION` | usually `us-central1` |
| `GCP_SERVICE_ACCOUNT` | `cloud-webapp-deployer@…iam.gserviceaccount.com` |
| `GCP_WORKLOAD_IDP` | the `projects/…/workloadIdentityPools/github-actions/providers/github` path |

No long-lived service-account JSON keys ever touch GitHub. The workflows
exchange GitHub's OIDC token for short-lived GCP credentials at runtime.

---

## 3. First deploy

Push to `main`. CI will:

1. Run `ci.yml`: lint, typecheck, test.
2. Run `deploy-api.yml`: build the Docker image, push to Artifact Registry,
   `gcloud run deploy` a new revision, smoke-test `/api/health`.
3. Run `deploy-web.yml`: build the Vite bundle, `firebase deploy` to Hosting
   plus Firestore rules and Storage rules.

You can also trigger either deploy workflow manually from the GitHub Actions
tab (`workflow_dispatch`).

The first `firebase deploy` will prompt for a Hosting site name if one
doesn't exist. Easiest: pre-create one in the Firebase console so the CI
deploy is fully unattended.

---

## 4. Custom domain

Once the app is live at `https://<your-project>.web.app`:

1. Firebase Console → Hosting → Add custom domain.
2. Enter `photos.mmrunners.org` (or whatever).
3. Firebase shows TXT and A records to add at the DNS provider.
4. After verification, TLS cert is auto-provisioned (typically <1 hour).

Cloud Run rewrites in `firebase.json` continue working unchanged — the
custom domain is purely a frontend concern.

---

## 5. Set a budget alert (do this immediately)

In Cloud Console → Billing → Budgets & alerts:

- Budget: $50/month for the project.
- Alerts at 50%, 90%, 100%.
- Notify admin@mmrunners.org.

Egress is the historic billing-surprise vector for nonprofits — see
`STORAGE_AND_DATABASE_OPTIONS.md` for the longer discussion. Cloud Run
`--max-instances=10` (set in both `deploy-api.sh` and `deploy-api.yml`)
also caps the worst-case scale-out.

---

## 6. Managing secrets

The api is deliberately scaffolded with **zero runtime secrets** so far —
no API keys, no DB passwords. Firestore uses ADC, Firebase Auth uses ADC.

When a secret becomes necessary later (e.g. a SendGrid key for transactional
email):

```bash
# Create the secret
echo -n "the-secret-value" | gcloud secrets create sendgrid-api-key \
  --project=<project-id> --data-file=-

# Grant the api's runtime service account access
gcloud secrets add-iam-policy-binding sendgrid-api-key \
  --member="serviceAccount:<runtime-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Mount it into the api in deploy-api.sh / deploy-api.yml
# by adding to gcloud run deploy:
#   --set-secrets=SENDGRID_API_KEY=sendgrid-api-key:latest
# And add it to api/src/lib/config.ts EnvSchema.
```

---

## 6b. Deploying the matcher (Find Me search)

The matcher is the private Cloud Run service that runs face/person search. It
is **not** deployed by CI — you deploy it manually from your machine with
`infra/scripts/deploy-matcher.sh`, because it ships ~184 MB of ONNX model
weights that we don't keep in git.

To avoid re-uploading those 184 MB from your laptop on every deploy, the
models live in GCS and Cloud Build pulls them in-cloud. Your laptop upload
stays at ~1 MB of code.

**One-time setup** (from `cloud-webapp/matcher/`):

```bash
# 1. Fetch the model files locally if you don't already have them.
python3 scripts/fetch_models.py --dir model_files   # OSNet: scripts/export_osnet.py

# 2. Stage them in GCS (once, and again only when a model changes).
gcloud storage buckets create gs://mmr-data-pipeline-models --location=us-central1
gcloud storage cp -r model_files/* gs://mmr-data-pipeline-models/model_files/
```

**Every deploy** (from `cloud-webapp/`):

```bash
./infra/scripts/deploy-matcher.sh mmr-data-pipeline us-central1
```

The script pulls the models from `gs://<project-id>-models/model_files` into
the build context inside Cloud Build (override with
`MODELS_GCS=gs://bucket/path`). `matcher/.gcloudignore` excludes
`model_files/` from the laptop upload, so the only thing that travels each
deploy is the source code.

After the first deploy, grant the api permission to call the matcher and wire
up its URL:

```bash
gcloud run services add-iam-policy-binding matcher --region=us-central1 \
  --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

Then set the GitHub repo **variable** `MATCHER_URL` (Settings → Secrets and
variables → Actions → **Variables**) to the URL the script prints, and re-run
the deploy-api workflow.

---

## 6c. Troubleshooting

**`COPY failed: no source files were specified`** (matcher build, step
`COPY model_files/`).
Two distinct causes have produced this, both now fixed:

1. *The models weren't in the build context.* `gcloud builds submit` decides
   what to upload from `.gcloudignore`; if that file is missing it falls back
   to `.gitignore`, which lists `model_files/`, stripping the 184 MB of
   weights out of the upload. Fixed by the GCS-staging flow in §6b — confirm
   `gcloud storage ls gs://mmr-data-pipeline-models/model_files/` lists four
   `.onnx` files; the deploy script preflights this and fails early if empty.
2. *The `COPY` itself was a fragile glob.* The Dockerfile previously used
   `COPY model_file[s]/` — an "optional copy" trick that only skips-when-empty
   under BuildKit. Cloud Build uses the **legacy** Docker builder, which fails
   that bracket glob with this exact error even when `model_files/` is present
   (check the `Sending build context to Docker daemon` line — if it's ~193 MB,
   the models are there and this is your cause). Fixed by switching to a plain
   `COPY model_files/ model_files/`.

**`Permission denied to get service [firebasestorage.googleapis.com]` (403)**
(web deploy, `firebase deploy … --only=…,storage`).
Two things are needed and both are now in `bootstrap-gcp.sh`: the
`firebasestorage.googleapis.com` API must be enabled, **and** the deployer
service account needs `roles/serviceusage.serviceUsageConsumer` — Firebase's
"ensuring required API is enabled" step reads the service via Service Usage
(`serviceusage.services.get`), which the deployer otherwise lacks. (Hosting and
Firestore deploy fine without it because only the `storage` target makes that
check.) Enabling the API alone is not enough; you also need the role.

Run both once as an owner, then re-run deploy-web:

```bash
gcloud services enable firebasestorage.googleapis.com --project=mmr-data-pipeline

gcloud projects add-iam-policy-binding mmr-data-pipeline \
  --member="serviceAccount:cloud-webapp-deployer@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer" --condition=None
```

If the rules step then fails with a rules permission error, grant the deployer
`roles/firebaserules.admin`.

**`Permission 'firebasestorage.defaultBucket.get' denied … defaultBucket (or
it may not exist)` (403)** (web deploy, after the API check passes).
The deployer can manage Cloud Storage (`roles/storage.admin`) but not the
Firebase Storage *management* layer, which owns the default bucket. Grant it
(now in `bootstrap-gcp.sh`):

```bash
gcloud projects add-iam-policy-binding mmr-data-pipeline \
  --member="serviceAccount:cloud-webapp-deployer@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/firebasestorage.admin" --condition=None
```

If the error persists with "may not exist", Firebase Storage hasn't been
initialized for the project yet — do it once in the Firebase Console
(Build → Storage → Get started), which creates the default bucket, then
re-run deploy-web.

**Container failed to start and listen on PORT=8080** (api deploy, "Creating
Revision … failed").
The container crashed on startup before binding the port. Check
Logs Explorer for the revision (the deploy error includes a direct link). A
past instance: the `@cloud-webapp/shared` package resolved to its TypeScript
source at runtime instead of compiled JS — fixed by the `production` export
condition in `shared/package.json` plus `node --conditions=production` in
`api/Dockerfile`.

---

## 7. Rolling back

Every Cloud Run deploy creates a new revision. To roll back:

```bash
gcloud run services update-traffic event-photo-api \
  --region=us-central1 --to-revisions=<previous-revision-name>=100
```

For the web bundle, Firebase Hosting also keeps the last 10 releases and
the rollback button is in the Firebase Console → Hosting → Release history.

---

## 8. Monitoring once it's live

- **Logs**: Cloud Console → Logging → Logs Explorer.
  Filter: `resource.type="cloud_run_revision" resource.labels.service_name="event-photo-api"`.
  Pino's structured JSON parses automatically.
- **Errors**: Cloud Console → Error Reporting. Auto-clusters by stack trace.
- **Uptime**: create a Cloud Monitoring uptime check pointing at
  `https://<custom-domain>/api/health` with a 5-minute interval. Free.

cathylin@Cathys-MacBook-Air infra % firebase apps:create WEB "event-photo-web" 2>/dev/null || true
Create your WEB app in project mmr-data-pipeline:

🎉🎉🎉 Your Firebase WEB App is ready! 🎉🎉🎉

App information:
  - App ID: 1:489676654863:web:b135d1921c7214fd45567a
  - Display name: event-photo-web

You can run this command to print out your new app's Google Services config:
  firebase apps:sdkconfig WEB 1:489676654863:web:b135d1921c7214fd45567a
cathylin@Cathys-MacBook-Air infra % firebase apps:sdkconfig WEB
✔ Downloading configuration data of your Firebase WEB app
{
  "projectId": "mmr-data-pipeline",
  "appId": "1:489676654863:web:b135d1921c7214fd45567a",
  "storageBucket": "mmr-data-pipeline.firebasestorage.app",
  "apiKey": "AIzaSyCv2o8wTUUJWS59QTBRTgo1jl11KZ1i1jc",
  "authDomain": "mmr-data-pipeline.firebaseapp.com",
  "messagingSenderId": "489676654863",
  "measurementId": "G-Y65EFZ8MXP",
  "projectNumber": "489676654863",
  "version": "2"
}
