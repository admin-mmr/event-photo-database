# Architecture

This document captures the *why* behind the structural choices. Read this
before making big changes to folder layout, deployment topology, or the
boundary between `api/`, `web/`, and `shared/`.

The directional decisions come from two existing docs in the repo root:

- `../STORAGE_AND_DATABASE_OPTIONS.md` — storage and DB analysis.
- `../UX_AND_GCP_ASSESSMENT.md` — case for moving off Apps Script and the GCP cost model.

---

## Stack

| Layer | Choice | Why this choice |
|---|---|---|
| Frontend hosting | Firebase Hosting | Free TLS, free custom domain (`photos.mmrunners.org`), global CDN, simple `firebase deploy`. Free-tier 10 GB storage + 360 MB/day egress is well above this org's traffic. |
| Frontend framework | Vite + React 18 + TypeScript | Familiar to most contributors; Vite gives sub-second HMR; static build is just files Firebase Hosting can serve. No SSR complexity. |
| Backend runtime | Node 20 on Cloud Run | Cloud Run scales to zero, pay per request, $0 at this org's traffic under the $10k/yr nonprofit credit. Node 20 is LTS. TS reuses ~35 service files from `gas-app/src/services/`. |
| Backend framework | Express 4 | Boring, battle-tested, easiest hand-off. The team can swap to Hono or Fastify later if needed; the route definitions are thin. |
| Database | Firestore (Native mode) | Inside the $10k/yr credit ~50× over. Native ADC auth from Cloud Run, no connection pooling concerns. Document model is fine for our shapes (events, clubs, photos, upload-links, audit-log) and gives us PITR + automatic regional replication for free. |
| Auth | Firebase Auth | Free at 50 MAU (we have ~50 active admins). Replaces `Session.getActiveUser()` from Apps Script. Verified server-side via `firebase-admin`. |
| Photo storage | Cloud Storage Standard + Cloud CDN with signed URLs | Engineered for image serving; no Drive hotlinking interstitials, no abuse throttling. Weekly mirror back to a Shared Drive folder in the 100 TB Workspace pool is the cold-archive policy from `STORAGE_AND_DATABASE_OPTIONS.md`. |
| Secrets | Google Secret Manager | First-class in Cloud Run via `--set-secrets`; secrets never appear in environment dumps, IAM controls access, rotation is built-in. |
| Logs / errors | Cloud Logging + Error Reporting | Free under the nonprofit credit; structured JSON logs from the api auto-parse. |
| CI/CD | GitHub Actions with Workload Identity Federation | No long-lived service-account keys in GitHub secrets — GitHub OIDC token exchanges for short-lived GCP credentials. This is the current Google-recommended pattern. |

---

## Why a monorepo with three workspaces

`api/` and `web/` need to share types and validation schemas. The three options were:

1. **Duplicate the types in each package.** Drifts in days. Rejected.
2. **Publish `shared/` to a private npm registry.** Massive overkill for a single-org repo. Rejected.
3. **npm workspaces, with `shared/` consumed by relative import.** ✅ Picked. One `npm install` at the root installs everything; TypeScript project references let `api/` and `web/` typecheck against `shared/` source directly.

The boundary rule:

- `shared/` may not import from `api/` or `web/`.
- `api/` may not import from `web/` and vice versa.
- `api/` and `web/` may import freely from `shared/`.

---

## Request flow in production

1. User hits `https://photos.mmrunners.org/…` — Firebase Hosting serves it.
2. For paths matching `/api/**`, Firebase Hosting rewrites to the Cloud Run service (see `infra/firebase.json`). Same origin from the browser's perspective — no CORS to configure.
3. Cloud Run cold-starts in ~200–800 ms if cold, ~5 ms if warm.
4. The Express app reads the `Authorization: Bearer <Firebase ID token>` header, verifies it via `firebase-admin`, and attaches `req.user` to the request.
5. Handlers read/write Firestore via Application Default Credentials. No service-account JSON files on disk.
6. Photo serving: the api returns signed URLs to Cloud Storage objects; the browser fetches directly from the GCS bucket through Cloud CDN.

---

## Deployment flow

```
   developer pushes to main
            │
            ▼
   GitHub Actions
   ├── ci.yml         lint + typecheck + test (always runs)
   ├── deploy-api.yml builds api Docker image, pushes to Artifact Registry,
   │                  runs `gcloud run deploy`. New revision gets 0% traffic
   │                  until a smoke-test passes, then 100%.
   └── deploy-web.yml runs `npm run build` in web/, then `firebase deploy --only hosting`.
```

Both deploys use Workload Identity Federation. The GitHub Actions OIDC
token is exchanged for a short-lived GCP access token via the
`google-github-actions/auth` action. No service-account JSON is ever
stored as a GitHub secret.

---

## What lives where

| Concern | File |
|---|---|
| Adding an API endpoint | `api/src/routes/*.ts`, register in `api/src/server.ts` |
| Adding a frontend page | `web/src/pages/*.tsx`, register in `web/src/App.tsx` |
| Adding a shared type or schema | `shared/src/*.ts`, re-export from `shared/src/index.ts` |
| Adding a Firestore index | `infra/firestore.indexes.json` (gets deployed by `deploy-web.sh`) |
| Loosening or tightening Firestore security rules | `infra/firestore.rules` |
| Adding a GCP API or IAM role | edit `infra/scripts/bootstrap-gcp.sh` and re-run |
| Adding a secret consumed by the api | `gcloud secrets create …` then reference in `infra/scripts/deploy-api.sh` |
