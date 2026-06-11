# Deployment guide

End-to-end: from "billing account active in `console.cloud.google.com`" to
"new code on every push to main deploys automatically."

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
