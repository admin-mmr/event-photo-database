# cloud-webapp — Event Photo Database, Google Cloud edition

This is the GCP replacement for the Apps Script app in `../gas-app/`.
Backend on Cloud Run, frontend on Firebase Hosting, metadata in Firestore,
photo originals/thumbnails in Cloud Storage.

As of the G1–G5 migration (`../GAS_MIGRATION_DEV_PLAN.md`), the full **control
plane** also lives here: users, clubs, events, upload links, email, audit,
duplicates/trash, reporting, and the partner API — see "Control plane (admin)"
below. **The Google Sheet remains the source of truth (SSOT);** cloud-webapp is
the writer, with Firestore as a derived read cache. `gas-app/` is now deprecated
(`../gas-app/DEPRECATED.md`); cutover is operational — follow
`../CUTOVER_RUNBOOK.md`.

The two trees coexist during the migration; nothing in this folder
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

## Control plane (admin)

Ported from gas-app (dev plan G1–G5). All writes go through RBAC middleware
(`requireAuth` → `attachRole` → `requireSuperAdmin`/`requireAnyAdmin`, plus club
scoping) to the Google Sheet (SSOT) via the `*Store` services, and are recorded
in the audit log.

| Area | API route | Web page |
|---|---|---|
| Users | `/api/admin/users` | `/admin/users` |
| Clubs | `/api/admin/clubs` | `/admin/clubs` |
| Masquerade | `/api/admin/masquerade/*` | (super-admin) |
| Events | `/api/admin/events` | `/admin/events` |
| Upload links | `/api/admin/links` | `/admin/events/:id/links` |
| Email prefs / digest | `/api/admin/email-prefs`, `/api/admin/email/daily` | `/me/email` |
| Audit | `/api/admin/audit` | `/admin/audit` |
| Deleted files / trash | `/api/admin/deleted-files` | `/admin/deleted` |
| Reporting | `/api/admin/summary` | `/admin/summary` |
| Partner API | `/api/partner/events`, `/api/partner/links` | (API key) |

RBAC: `requireSuperAdmin` for user/club management; `requireAnyAdmin` +
club-scope for events/links/trash/reporting; partner routes use an API key
(`X-Api-Key`, secret in env/Secret Manager — never the Sheet). Required config
and the deploy/cutover sequence are in `../CUTOVER_RUNBOOK.md`.

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
