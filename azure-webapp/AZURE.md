# Azure deployment — architecture, service recommendation, and migration map

This folder (`azure-webapp/`) is the Azure counterpart of `cloud-webapp/`. The
**application code is identical**; what differs is the deployment surface
(`infra/scripts/`, Dockerfile build commands, config) and the cloud SDKs the
data layer talks to. This document is the source of truth for the GCP→Azure
mapping and the recommendation behind it.

> **Status:** the infrastructure/deploy layer is fully ported. The application
> **data-layer code** (Firestore→Cosmos, Cloud Storage→Blob, Firebase Auth) is
> **not yet ported** — that work is tracked in `AZURE_MIGRATION_PROGRESS.md`.

---

## Recommendation (the "which Azure service" question)

**Use Azure Container Apps (Consumption plan) for the api and matcher, Azure
Container Apps Jobs for the indexer, and Azure Static Web Apps (Free) for the
web frontend.**

Why Container Apps over the alternatives, judged against this project's
non-negotiable **zero-idle-cost policy** (`CLAUDE.md`):

| Option | Scale-to-zero? | Verdict |
|---|---|---|
| **Azure Container Apps (Consumption)** | **Yes — $0 at zero replicas**, plus a monthly free grant (180k vCPU-s, 360k GiB-s, 2M requests per subscription). | ✅ **Recommended.** Closest analog to Cloud Run: same container, same scale-to-zero economics, same cold-start tradeoff. Container Apps **Jobs** map 1:1 onto the Cloud Run Job indexer and bill only while a run executes. |
| Azure App Service | Weak. The cheapest always-on tiers bill ~24/7; "scale to zero" isn't a first-class consumption model for containers. | ❌ Violates the idle-cost policy — there's effectively a standing instance charge. |
| Azure Functions (Consumption) | Yes for event/timer triggers. | ⚠️ Good *only* for the indexer-style batch job, but a poor fit for the long-lived Express api and the model-loading matcher (image size, in-memory vector cache, 1-worker gunicorn). Mixing runtimes adds complexity for no cost win over Container Apps. |

So the whole stack lands on **one Container Apps environment** (api + matcher as
apps, indexer as a job) plus a **Static Web App** for the SPA. This is the
minimal-surface, lowest-idle-cost arrangement and the most faithful translation
of the existing Cloud Run topology.

**Cost caveats to watch** (documented so they don't surprise anyone):
- Never set `--min-replicas > 0`. A warm replica bills at the idle rate from the
  first second and is *not* covered by the free grant — this is the Azure twin
  of the `matcher` warm-instance bug in `CLAUDE.md`.
- The Container Apps environment requires a **Log Analytics workspace**; its
  ingestion is the one unavoidable standing cost. Keep retention low (30 days,
  set in `bootstrap-azure.sh`) and don't over-log.
- **Cosmos DB is provisioned in serverless mode** (pay per request unit, no idle
  floor) to honor scale-to-zero on the database too.

Sources: Azure Container Apps [pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
and [billing](https://learn.microsoft.com/en-us/azure/container-apps/billing);
[Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs);
[Static Web Apps pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/);
[Cosmos DB serverless](https://learn.microsoft.com/en-us/azure/cosmos-db/serverless).

---

## Full service mapping

| Concern | GCP (cloud-webapp) | Azure (azure-webapp) | Code change needed? |
|---|---|---|---|
| api runtime | Cloud Run service | **Container Apps** (external ingress) | No (same container) |
| matcher runtime | Cloud Run service (private, IAM) | **Container Apps** (internal ingress) | No |
| indexer | Cloud Run Job | **Container Apps Job** (Manual trigger) | No |
| web hosting | Firebase Hosting | **Static Web Apps (Free)** | No (build is the same) |
| api↔web routing | Hosting rewrite `/api/**`→Cloud Run | SWA **linked backend** + `staticwebapp.config.json` | Config only |
| Database | Firestore (Native) | **Cosmos DB (NoSQL API, serverless)** | **Yes — data layer** |
| Photo/derivative storage | Cloud Storage + signed URLs | **Blob Storage** + user-delegation SAS | **Yes — data layer** |
| Auth | Firebase Auth | Keep **Firebase Auth** (cross-cloud) *or* migrate to **Entra External ID** | See note below |
| Secrets | Secret Manager (`--set-secrets`) | **Key Vault** (Container Apps secret refs) | No (env names same) |
| Container registry | Artifact Registry | **Azure Container Registry (ACR)** | No |
| Image build | Cloud Build | **ACR Tasks** (`az acr build`) | Script only |
| Logs/errors | Cloud Logging + Error Reporting | **Log Analytics + Application Insights** | No |
| Scheduled triggers | Cloud Scheduler | **Container Apps Jobs (Schedule)** | Script only |
| Runtime identity | IAM service accounts | **user-assigned Managed Identities** | No |
| CI auth | Workload Identity Federation | **Entra federated credentials (OIDC)** | Workflow only |
| Photo source (Drive) | Google Drive (DWD) | **Google Drive (unchanged)** — cred in Key Vault | Cred location only |

### Auth note
Firebase Auth works fine from anywhere, so the **lowest-risk path is to keep
Firebase Auth** initially: `firebase-admin` token verification in the api needs
only the Firebase project's public keys — no GCP runtime dependency. Migrating to
**Entra External ID** (formerly Azure AD B2C) is the fully-Azure-native option
but is a separate, larger workstream (re-issue tokens, migrate the ~50 admin
users). Recommendation: ship on Container Apps with Firebase Auth retained, then
evaluate Entra External ID as a follow-up.

---

## What still needs code changes (data layer)

The api/indexer/matcher import cloud SDKs that must be swapped. The cleanest
approach is a thin adapter behind the existing call sites:

- **Firestore → Cosmos:** `@google-cloud/firestore` (api) and
  `google-cloud-firestore` (indexer) → `@azure/cosmos` / `azure-cosmos`. Query
  semantics differ (SQL-ish queries, partition keys, no collection-group
  queries) — see `infra/cosmos-access-notes.md`.
- **Cloud Storage → Blob:** `@google-cloud/storage` / `google-cloud-storage` →
  `@azure/storage-blob`. Replace `gs://` paths and signed URLs with Blob
  container URLs and user-delegation SAS — see `infra/blob-access-notes.md`.
  `matcher/store.py`, `indexer/blobs.py`, `indexer/derivatives.py` are the hot
  spots.
- **Security rules → api middleware:** Firestore/Storage rules have no Azure
  equivalent; port their conditions into the api's route guards.
- **Auth:** keep Firebase Auth (no change) or migrate to Entra External ID.

These are deliberately **not** done yet — they're real application logic that
must be ported and tested, not mechanically rewritten. Track them in
`AZURE_MIGRATION_PROGRESS.md`.

---

## Deploy order

```
./infra/scripts/bootstrap-azure.sh               # RG, ACR, env, Cosmos, Blob, Key Vault, Log Analytics
./infra/scripts/provision-runtime-identities.sh  # managed identities + RBAC
./infra/scripts/deploy-matcher.sh                # internal Container App
./infra/scripts/deploy-api.sh                    # external Container App (auto-wires MATCHER_URL)
./infra/scripts/deploy-indexer.sh                # Container Apps Job
./infra/scripts/deploy-web.sh                    # Static Web App + link api backend
./infra/scripts/provision-sync-scheduler.sh      # daily sync (scheduled job)
./infra/scripts/provision-index-scan-scheduler.sh# index-on-arrival backstop
./infra/scripts/provision-volunteer-uploads.sh <rg> <web-origin>
./infra/scripts/provision-budget-guardrails.sh   # $10/mo budget + idle audit
```

All scripts default to resource group `mmr-photos-rg`, region `eastus`; override
via positional args or the env vars echoed by `bootstrap-azure.sh`.
