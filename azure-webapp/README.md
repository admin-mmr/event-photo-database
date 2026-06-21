# azure-webapp — Event Photo Database, Microsoft Azure edition

> **This is the Azure port of `../cloud-webapp/`.** Start with **`AZURE.md`**
> (service recommendation + GCP→Azure mapping) and **`AZURE_MIGRATION_PROGRESS.md`**
> (what's done vs. remaining). The application code is shared with the GCP tree;
> what differs is the deploy layer (`infra/scripts/`, build commands, config).
> Target: Azure Container Apps (api + matcher) and Container Apps Jobs (indexer),
> Static Web Apps (web), Cosmos DB serverless (metadata), Blob Storage (photos),
> Key Vault (secrets). The data-layer SDK swap is still in progress.
>
> The notes below still describe the original Google Cloud topology and are being
> migrated; `AZURE.md` is authoritative where they disagree.

This is the cloud replacement for the Apps Script app in `../gas-app/`.
Backend on Container Apps, frontend on Static Web Apps, metadata in Cosmos DB,
photo originals/thumbnails in Blob Storage.

The trees coexist during the migration; nothing in this folder
imports from `../gas-app/` and vice versa. Once cutover finishes,
`../gas-app/` is decommissioned.

---

## Architecture at a glance

```
                                                      ┌──────────────────────────┐
   browser  ──HTTPS──▶  Firebase Hosting  ───▶ /api/* ─┤  Cloud Run (api/)        │
   (React SPA          (web/ static bundle)            │  Node 20 + Express + TS  │
    from web/)                                         └──────────┬───────────────┘
                                                                  │
                                                  ┌───────────────┼────────────────┐
                                                  ▼               ▼                ▼
                                            Firestore     Cloud Storage      Firebase Auth
                                            (metadata)    (photos + CDN)     (user identity)
```

Folder layout:

| Path | Purpose |
|---|---|
| `api/` | Cloud Run service. Express + TypeScript. Runs the business logic. |
| `web/` | Vite + React + TypeScript SPA. Deploys as static files to Firebase Hosting. |
| `shared/` | Types + Zod schemas imported by both `api/` and `web/`. The single source of truth for request/response shapes. |
| `infra/` | `firebase.json`, Firestore rules and indexes, Storage rules, gcloud bootstrap scripts. |
| `docs/` | Development and deployment guides. |
| `.github/workflows/` | CI (lint + typecheck + test on every PR) and CD (deploy on push to `main`). |

This is a single npm workspace with three packages (`api`, `web`, `shared`).
One `npm install` at the root installs everything.

---

## Prerequisites

Install once on your machine:

- Node 20.x (use `nvm install` from this directory — `.nvmrc` pins it).
- `gcloud` CLI: <https://cloud.google.com/sdk/docs/install>
- `firebase-tools`: `npm install -g firebase-tools`
- Docker Desktop (only needed if you want to build/run the api container locally).

Then:

```bash
gcloud auth login
gcloud auth application-default login
firebase login
```

---

## One-time GCP setup

After your billing account is active in `console.cloud.google.com`, run:

```bash
cd cloud-webapp
./infra/scripts/bootstrap-gcp.sh <project-id>
```

The script is idempotent — safe to re-run. It enables the required APIs,
creates the deploy service account, grants minimum IAM roles, creates
the Firestore database in Native mode, and prints the Workload Identity
Federation values you'll paste into GitHub Actions secrets.

See `docs/DEPLOYMENT.md` for the long version.

---

## Local development

```bash
cd cloud-webapp
nvm use            # picks up Node 20 from .nvmrc
npm install        # installs all workspaces
npm run dev        # runs api on :8080 and web on :5173 in parallel
```

Open <http://localhost:5173>. The Vite dev server proxies `/api/*` to
`http://localhost:8080`, so frontend and backend look like one origin
in dev exactly like they will in production behind Firebase Hosting.

Run tests:

```bash
npm test           # all workspaces
npm test -w api    # just the api
```

Typecheck + lint:

```bash
npm run check      # tsc --noEmit + eslint, across all workspaces
```

---

## Deploying

CI/CD does this automatically on push to `main` (see `.github/workflows/`).
To deploy manually:

```bash
# Backend → Cloud Run
./infra/scripts/deploy-api.sh <project-id>

# Frontend → Firebase Hosting
./infra/scripts/deploy-web.sh <project-id>
```

---

## Migration status from gas-app

| gas-app feature | Status |
|---|---|
| Health check | ✅ ported (`GET /api/health`) |
| Auth (Firebase Auth replacing `Session.getActiveUser`) | 🟡 scaffolded, not wired into routes yet |
| Upload links | ⬜ not started |
| Audit log | ⬜ not started |
| Drive tree | ⬜ not started |
| Photos sync | ⬜ not started |
| (existing) image conversion `cloud-run/main.py` | ⬜ to be absorbed in a later milestone |

When a feature ships here, flip its row to ✅ and remove the equivalent
from the gas-app tree in the same PR.
