# Azure migration — progress & handoff

Living checklist for the `azure-webapp/` port. Update the checkboxes as work
lands. The resume prompt at the bottom lets a fresh thread pick up cleanly.

> **⚠ Superseded for planning (2026-07-18):** a full codebase audit found this
> fork ~90 commits stale against `cloud-webapp/` and changed the strategy —
> see root **`AZURE_MIGRATION_DEV_PLAN.md`** (decision D1: adapters in
> `cloud-webapp/` instead of maintaining this copy; `azure-webapp/` keeps only
> `infra/` + docs). This file remains useful for the infra-script inventory.

_Last updated: 2026-06-20_

---

## Goal

Stand up the event-photo stack (api, matcher, indexer, web) in **Azure**, as a
faithful, zero-idle-cost translation of the GCP `cloud-webapp/`. Target services
and rationale are in **`AZURE.md`** (read that first).

**Recommended target:** Azure Container Apps (Consumption) for api + matcher,
Container Apps Jobs for indexer, Static Web Apps (Free) for web, Cosmos DB
(serverless) for the DB, Blob Storage for photos, Key Vault for secrets.

---

## Done ✅

- [x] Created `azure-webapp/` as a full copy of `cloud-webapp/` (source only;
      build artifacts excluded).
- [x] Removed GCP-only files (`firebase.json`, `.firebaserc`, `.gcloudignore`).
- [x] Renamed GCP infra files to Azure equivalents
      (`firestore.rules`→`infra/cosmos-access-notes.md`,
      `storage.rules`→`infra/blob-access-notes.md`,
      `firestore.indexes.json`→`infra/cosmos-indexes.json`,
      `bootstrap-gcp.sh`→`bootstrap-azure.sh`,
      `provision-runtime-sas.sh`→`provision-runtime-identities.sh`,
      `verify-g1-dwd.sh`→`verify-drive-access.sh`).
- [x] Rewrote **all `infra/scripts/`** for Azure (bootstrap, runtime identities,
      deploy-api / matcher / indexer / web, sync + index-scan schedulers,
      volunteer-uploads, budget guardrails, backfill-capture-time, verify-drive).
- [x] Added `web/staticwebapp.config.json` (SWA routing + `/api` backend).
- [x] Rewrote `api/.env.example` for Azure (Cosmos/Blob/Key Vault env).
- [x] Wrote `AZURE.md` (recommendation + full GCP→Azure mapping).

## To do — infra polish ⬜

- [ ] Update `ARCHITECTURE.md`, `README.md`, `docs/DEPLOYMENT.md` prose to Azure
      (they still describe Cloud Run / Firebase). `AZURE.md` is authoritative for
      now; these are stale until edited.
- [ ] Add a `.github/workflows/` set for ACR build + Container Apps deploy using
      Entra federated credentials (the GCP repo had none committed).
- [ ] Decide region (scripts default `eastus`) and naming suffix; confirm global
      uniqueness of ACR / storage / cosmos names.

## To do — application data layer (the real work) ⬜

These are code changes, not config. See `AZURE.md` "What still needs code
changes" and the two `infra/*-notes.md` files.

- [ ] **api:** swap `@google-cloud/firestore` → `@azure/cosmos`; introduce a
      `db` adapter so route handlers don't change much. Map collections→containers
      and queries→SQL with partition keys.
- [ ] **api:** swap `@google-cloud/storage` → `@azure/storage-blob`; replace
      signed-URL minting with user-delegation SAS.
- [ ] **api:** port Firestore/Storage **security rules** into route guards
      (`requireAuth`/`requireAdmin`) — they have no Azure client-side equivalent.
- [ ] **indexer:** swap `google-cloud-storage`/`google-cloud-firestore` →
      `azure-storage-blob`/`azure-cosmos` in `blobs.py`, `derivatives.py`, and
      the Firestore writes in `job.py`. Keep Google Drive client as-is.
- [ ] **matcher:** swap `google-cloud-storage` → `azure-storage-blob` in
      `store.py`; `EMBEDDINGS_ROOT` becomes a Blob container URL.
- [ ] **auth:** keep Firebase Auth (no code change) OR migrate to Entra External
      ID (larger, separate workstream).
- [ ] **Drive credential:** store the Google SA JSON in Key Vault, mount into the
      indexer job, set `GOOGLE_APPLICATION_CREDENTIALS` (see
      `verify-drive-access.sh`).
- [ ] Update `requirements.txt` (matcher/indexer) and `api/package.json` deps
      accordingly; adapt the test suites.

## To do — deploy & verify ⬜

- [ ] Run `bootstrap-azure.sh` against the Azure subscription.
- [ ] Seed Key Vault secrets (SYNC-TRIGGER-TOKEN, CONSENT-POLICY-VERSION,
      RECAPTCHA-KEY, DRIVE-SA-JSON).
- [ ] Deploy all four components; smoke-test `/api/health` and a Find-Me search.
- [ ] Confirm every Container App shows `minReplicas = 0`
      (`provision-budget-guardrails.sh` audits this).

---

## Key facts for whoever picks this up

- Folder: `/Users/cathylin/github/mmr/event-photo-database/azure-webapp`
  (sibling of `cloud-webapp/`, which is the untouched GCP original — diff against
  it to see exactly what changed).
- npm workspace names still use the `@cloud-webapp/*` scope (api, web, shared) —
  not renamed, to avoid churning every import. Rename later if desired.
- Scripts default to RG `mmr-photos-rg`, region `eastus`; override by env var or
  positional arg. They are idempotent.
- Cost rule (from root `CLAUDE.md`) is non-negotiable: **scale to zero, never set
  min-replicas > 0.** Cosmos is serverless for the same reason.

---

## Resume prompt for a new thread

Paste this to continue:

> I'm continuing an Azure migration of a photo-database app. The repo is at
> `~/github/mmr/event-photo-database`. `cloud-webapp/` is the original GCP stack
> (Cloud Run + Firebase + Firestore + GCS); `azure-webapp/` is the in-progress
> Azure port. **Read `azure-webapp/AZURE.md` and
> `azure-webapp/AZURE_MIGRATION_PROGRESS.md` first** — they hold the service
> mapping, the recommendation, and the checklist of what's done vs. remaining.
>
> The infra/deploy layer (`azure-webapp/infra/scripts/`, `staticwebapp.config.json`,
> Key Vault wiring) is already ported to Azure Container Apps + Static Web Apps +
> Cosmos (serverless) + Blob. What remains is the **application data layer**:
> swapping Firestore→`@azure/cosmos` and Cloud Storage→`@azure/storage-blob` in
> the api (TypeScript), indexer and matcher (Python), porting the Firestore/
> Storage security rules into api route guards, and deciding Firebase Auth vs.
> Entra External ID.
>
> Honor the zero-idle-cost rule in the root `CLAUDE.md` (scale to zero, no
> min-replicas > 0). Start with: <pick one — e.g. "the api Cosmos adapter" or
> "run bootstrap-azure.sh and seed Key Vault">. Update
> `AZURE_MIGRATION_PROGRESS.md` checkboxes as you go.
