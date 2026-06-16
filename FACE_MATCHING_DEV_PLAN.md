# Development Plan — "Find Me" Face & Person Matching

**Project:** 湘舍动公益文件系统 (Event Photo Database)
**Implements:** `FACE_MATCHING_FEATURE_PRD.md`
**Prepared for:** IT Department, Youth4AM / mmrunners
**Date:** June 8, 2026
**Status:** Draft for review
**Builds on:** `cloud-webapp/` (existing scaffold), `cloud-run/` (existing Python image service), `ARCHITECTURE.md`, `STORAGE_AND_DATABASE_OPTIONS.md`

---

## 0. How to read this plan

This is the build plan for the PRD. It is organized as: prerequisites → GCP provisioning → repo structure → a phased, ticket-level build sequence (mapped to PRD milestones M0–M6) → the test strategy → CI/CD → cutover. Every coding task names the concrete files it touches in the existing monorepo so an engineer can start without guessing.

**Locked decisions carried from the PRD** (see PRD §0): self-hosted face + person-ReID embedding models on Cloud Run (D1, D2); vector store = **Cloud SQL + pgvector** (D-cost, PRD §10.1); auth = Firebase, Find Me is link-or-login only (D3); minors require guardian-performed search (D8); identity reuse / persistent enrollment enabled (D7); Drive stays SSOT and also stores user uploads (D6); no Apps Script (D5).

> **⚠️ DECISION UPDATE (2026-06-09) — zero-cost vector store.** The vector store decision is superseded: **no Cloud SQL/pgvector** (no free tier; ~$50–58/mo). Instead, per-event embeddings are stored as flat files in Cloud Storage (`gs://…-derivatives/<eventId>/embeddings/{faces,persons}.npy` + `manifest.json`) and the matcher does in-memory cosine similarity — trivial at our per-event scale (a few thousand photos; searches are event-scoped per PRD §5). Consequences for this plan: §2.1 drop `sqladmin`; §2.2 drop Cloud SQL row and `DB_CONNECTION`/`DB_PASSWORD` secrets; §2.4 `provision-data-plane.sh` provisions buckets/topics only; `infra/sql/0001_init.sql` and §4.3 are replaced by the manifest layout; `vectorService.ts`/`sql.ts` become a GCS-backed embedding store module; M0 task 0.2 becomes "load sample embeddings from GCS, brute-force query in matcher"; CI needs no Postgres container. Revisit pgvector only if a single event approaches ~100k photos. See `FACE_MATCHING_SETUP_RUNBOOK.md` Phase F and `SETUP_NOTES.md`.

> **⚠️ DECISION UPDATE (2026-06-11) — M0 decisions recorded; eval scope relaxed.**
> - **Task 0.4 decided:** Drive read via **domain-wide delegation** (keyless, IAM `signJwt`, impersonating `admin@mmrunners.org`). Details: `SETUP_NOTES.md` G1.
> - **Task 0.5 decided:** **flat-file GCS embedding store** (see 2026-06-09 banner above); pgvector/Vertex dropped.
> - **Task 0.3 scope relaxed:** M0 go/no-go is judged on **2 labeled people** (not ~10) on the `ev_sample` event, using `eval/run_eval.py` + `eval/make_review_page.py`. Exhaustive labeling is **deferred to the beta feedback loop** — accuracy is then measured continuously from real user feedback instead of a one-off hand-labeled set. Design: `EVAL_FEEDBACK_LOOP.md`. Consequence: the M2 DoD eval gate (P@20 ≥ 0.85 on 2 events) is measured as **judged precision** per that doc once feedback exists; until then the M0-style spot-labeled eval is the gate.

> **⚠️ STATUS UPDATE (2026-06-12) — demo fast-path.** For the stakeholder demo, M2 (search API: `matcherClient.ts`, `gcsService.ts` signed URLs, `findme.ts` route) plus a minimal slice of M3 (Events/Gallery/FindMe pages, Firebase Auth, simple consent checkbox) shipped ahead of full M3. Demo-scope deferrals tracked in `cloud-webapp/docs/DEMO_CHECKLIST.md`: ZH localization, enrollment/MyData, minor-guardian consent path, Drive mirror of reference uploads (D6), rate limit + reCAPTCHA (M5.3), feedback UI (M4). These remain on the plan's original schedule. Remaining human steps to a live demo are in the checklist.

> **⚠️ STATUS UPDATE (2026-06-15) — demo-feedback backlog.** Hands-on use of the shipped demo on the live event surfaced two bugs (no back-navigation out of the Gallery; events display as "Untitled event") and a confirmed priority ordering for the deferred M3/M4 work (original-resolution batch download is the most-wanted feature). PRD §4.8 adds FR-1b, FR-2b, FR-2c, FR-9b and reaffirms FR-11/FR-12/FR-15. Ticket-level build sequence is in **§5A** below; it slots into the existing M3/M4 milestones rather than adding a new milestone.

## 1. Prerequisites & assumptions

- **Photos already in Drive.** Event photos live in Drive folders today. We do *not* move them; the indexing pipeline mirrors copies to Cloud Storage for serving + embedding. Drive stays SSOT.
- **Drive structure is knowable.** We need a reliable mapping from "event" → "Drive folder ID". If `events` in Firestore (or the existing Sheet/`gas-app` data) already holds folder IDs, we reuse it; otherwise an admin sets a `driveFolderId` per event (first task in M1).
- **Google Cloud project exists** with the `cloud-webapp` bootstrap already run (`infra/scripts/bootstrap-gcp.sh`). Nonprofit billing/credit is attached.
- **Firebase project** is linked (Hosting + Auth already in the stack).
- **A service account with Drive read access** to the event folders. Two options, decided in M0: (a) domain-wide-delegated Workspace service account, or (b) a dedicated Workspace user whose Drive the SA is granted access to. Avoids per-user OAuth for indexing.
- **Two engineers** ideally (one TS/full-stack, one comfortable with Python/ML), or one full-stack engineer with ML support during M0/M2.

---

## 2. GCP services to provision

The existing `bootstrap-gcp.sh` already enables Cloud Run, Cloud Build, Artifact Registry, Firestore, Firebase, Hosting, IAM, Secret Manager, and Storage, and sets up the deployer SA + Workload Identity Federation. This feature **extends** that script (keep it idempotent). New items:

### 2.1 Additional APIs to enable

| API | Why |
|---|---|
| `sqladmin.googleapis.com` | Cloud SQL (Postgres + pgvector) — the vector store |
| `pubsub.googleapis.com` | Indexing pipeline eventing |
| `eventarc.googleapis.com` | Trigger indexing jobs from Storage/schedule events |
| `cloudscheduler.googleapis.com` | Scheduled Drive change scans + retention/deletion jobs |
| `drive.googleapis.com` | Read event photos from Drive; write user uploads to Drive |
| `recaptchaenterprise.googleapis.com` | Bot/abuse protection on the upload action |
| `cloudkms.googleapis.com` (optional) | CMEK for the uploads bucket if required by policy |

### 2.2 New infrastructure resources

| Resource | Spec / config | Notes |
|---|---|---|
| **Cloud SQL Postgres** | Small dedicated instance (e.g. 1 vCPU / shared-not-allowed for prod), `pgvector` extension enabled, automated backups + PITR on | ~$7–15/mo, credit-covered. Holds `events`-adjacent vector tables. Private IP + Cloud SQL connector from Cloud Run. |
| **Cloud Storage bucket: derivatives** | `gs://<proj>-derivatives`, uniform access, lifecycle: none (serving copies) | Thumb/web/orig serving copies of gallery photos. |
| **Cloud Storage bucket: uploads** | `gs://<proj>-uploads`, uniform access, **7-day lifecycle delete** | Working copies of reference selfies (PRD §8.4). |
| **Pub/Sub topics** | `photo-index-requests`, `photo-index-deadletter` | Drives per-photo embedding work. |
| **Cloud Run service: matcher** | Python, private (no unauth), CPU-only, scale-to-zero, min-instances 0 (raise to 1–2 during event weekends) | Online query embeddings. Same deploy pattern as existing `cloud-run/`. |
| **Cloud Run Job: indexer** | Python, larger CPU or GPU config, batch | Bulk embedding of an event's photos. |
| **Cloud Run service: api (existing)** | add the new routes; add Cloud SQL connector + new secrets | `event-photo-api` already wired in `firebase.json`. |
| **reCAPTCHA Enterprise key** | website key for the SPA | Gate the upload/search action. |
| **Secret Manager secrets** | `DB_CONNECTION`, `DB_PASSWORD`, `DRIVE_SA_KEY` (or WIF config), `RECAPTCHA_KEY`, `CONSENT_POLICY_VERSION` | Mounted via `--set-secrets` like existing pattern. |

### 2.3 IAM additions (deployer SA + runtime SAs)

Extend the role loop in `bootstrap-gcp.sh`:

- Deployer SA: add `roles/cloudsql.admin` (provisioning), `roles/pubsub.admin`, `roles/eventarc.admin`, `roles/cloudscheduler.admin`.
- **api runtime SA:** `roles/datastore.user`, `roles/cloudsql.client`, `roles/storage.objectAdmin` (uploads + derivatives buckets, scoped), `roles/secretmanager.secretAccessor`, `roles/run.invoker` (to call matcher), `roles/pubsub.publisher`.
- **matcher runtime SA:** `roles/cloudsql.client`, `roles/storage.objectViewer` (uploads), `roles/secretmanager.secretAccessor`.
- **indexer Job SA:** `roles/cloudsql.client`, `roles/storage.objectAdmin` (derivatives), `roles/datastore.user`, Drive access (via the Workspace SA from §1).
- Principle: **separate runtime SAs per service**, least privilege; never reuse the deployer SA at runtime.

### 2.4 Provisioning deliverables (code, not clicks)

All of the above is scripted, never click-ops, so it's reproducible:

- `infra/scripts/bootstrap-gcp.sh` — extended with the new APIs + IAM (idempotent, as today).
- `infra/scripts/provision-data-plane.sh` — **new**: Cloud SQL instance, `pgvector` extension, buckets + lifecycle, Pub/Sub topics, scheduler jobs.
- `infra/sql/0001_init.sql` — **new**: pgvector tables + indexes (see §4.3).
- `infra/scripts/deploy-matcher.sh`, `infra/scripts/deploy-indexer.sh` — **new**: deploy the Python services (mirror existing `deploy-api.sh`).

---

## 3. Repository structure (additions)

Monorepo stays as-is (`api/`, `web/`, `shared/`, `infra/`); we add a Python service dir and new modules. Nothing in `gas-app/` changes (D5).

```
cloud-webapp/
├── api/                         # existing Node/Express on Cloud Run
│   └── src/
│       ├── routes/
│       │   ├── events.ts        # NEW  GET events, gallery listing
│       │   ├── findme.ts        # NEW  upload, search, enrollment
│       │   ├── download.ts      # NEW  signed URLs, zip streaming
│       │   ├── feedback.ts      # NEW  wrong/confirmed match
│       │   └── consent.ts       # NEW  consent + minor/guardian
│       ├── services/
│       │   ├── driveService.ts  # NEW  read events, write user uploads (Drive API)
│       │   ├── gcsService.ts    # NEW  signed URLs, zip stream
│       │   ├── vectorService.ts # NEW  pgvector query/upsert
│       │   ├── matcherClient.ts # NEW  call matcher Cloud Run (IAM token)
│       │   ├── consentService.ts# NEW
│       │   └── retentionService.ts # NEW  deletion cascades
│       ├── middleware/
│       │   ├── auth.ts          # EXISTS  Firebase ID token verify
│       │   ├── consentGate.ts   # NEW  block biometric ops w/o consent
│       │   └── rateLimit.ts     # NEW  per-user limits + reCAPTCHA check
│       └── lib/
│           ├── sql.ts           # NEW  Cloud SQL connector pool
│           └── fusion.ts        # NEW  face+outfit score fusion
├── web/                         # existing React/Vite SPA
│   └── src/
│       ├── pages/
│       │   ├── Events.tsx       # NEW  step 1
│       │   ├── Gallery.tsx      # NEW  step 2 + Find Me button
│       │   ├── FindMe.tsx       # NEW  steps 3–4 upload + tabs
│       │   ├── Results.tsx      # NEW  steps 5–6 select/download/feedback
│       │   └── MyData.tsx       # NEW  enrollment + delete (D7, §8)
│       ├── components/          # ConsentDialog, PhotoGrid, SelectBar, FeedbackButton…
│       └── lib/api.ts           # EXISTS  extend with new endpoints
├── shared/
│   └── src/schemas/
│       ├── event.ts             # NEW  zod schemas + types
│       ├── findme.ts            # NEW  upload/search/result/enrollment
│       ├── feedback.ts          # NEW
│       └── consent.ts           # NEW
├── matcher/                     # NEW  Python Cloud Run service (online query)
│   ├── main.py                  # face + person embedding, detect, quality
│   ├── models/                  # model load/wrappers (ONNX)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── test_main.py
├── indexer/                     # NEW  Python Cloud Run Job (bulk index)
│   ├── job.py                   # Drive→GCS mirror, detect, embed, upsert
│   ├── requirements.txt
│   ├── Dockerfile
│   └── test_job.py
└── infra/
    ├── scripts/                 # extended + new provisioning scripts
    └── sql/0001_init.sql        # NEW  pgvector schema
```

---

## 4. Data plane detail

### 4.1 Firestore (metadata; collections from PRD §6.2)

`events` (extend with `driveFolderId`, `indexState`, `visibility`), `photos`, `photo_embeddings_meta`, `find_me_uploads`, `match_runs`, `match_feedback`, `consents`, `face_enrollments`. Security rules in `infra/firestore.rules`; composite indexes in `infra/firestore.indexes.json` (e.g. `match_runs` by `userId`+`createdAt`).

### 4.2 Cloud Storage

Two buckets (§2.2). Access only via the api minting **signed URLs** (≤60 min). No public objects; no Drive hotlinks.

### 4.3 Cloud SQL + pgvector schema (`infra/sql/0001_init.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per detected face/person crop. event_id partitions every query.
CREATE TABLE embeddings (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT      NOT NULL,
  photo_id      TEXT      NOT NULL,
  kind          TEXT      NOT NULL CHECK (kind IN ('face','person')),
  model_version TEXT      NOT NULL,
  embedding     vector(512) NOT NULL,         -- dim depends on chosen model
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ANN index per kind; event_id filtered in the WHERE clause.
CREATE INDEX embeddings_face_hnsw  ON embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE kind = 'face';
CREATE INDEX embeddings_person_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE kind = 'person';
CREATE INDEX embeddings_event_idx  ON embeddings (event_id, kind);
```

Query is `ORDER BY embedding <=> $1 LIMIT k` with `WHERE event_id = $2 AND kind = $3` (cosine distance). Enrolled selfies live in their own small table or are queried transiently — embeddings are stored only when the user opts into enrollment.

---

## 5. Phased build sequence

Each phase maps to a PRD milestone and lists ticket-sized tasks. "DoD" = definition of done.

### M0 — Spike & decisions (1–2 weeks)

| # | Task | Output |
|---|---|---|
| 0.1 | Stand up `matcher/` skeleton; load a face model (InsightFace/ArcFace ONNX) and a person-ReID model; embed a sample of ~500 real event photos | Embeddings produced locally / on a dev Cloud Run |
| 0.2 | Stand up Cloud SQL + pgvector dev instance; load the sample; run nearest-neighbor queries | Working query path |
| 0.3 | Hand-label ~10 known attendees across the sample; measure Precision@20 and Recall with face-only, outfit-only, and fused scoring | Accuracy report |
| 0.4 | Confirm Drive read approach (domain-wide delegation vs shared-folder SA) | Decision recorded |
| 0.5 | Confirm pgvector vs Vertex (cost recheck per PRD §10.1) | Decision recorded |
| **DoD** | | Precision@20 ≥ 0.8 on the sample; fusion weights chosen; **go/no-go** |

### M1 — Indexing pipeline (1.5–2 weeks)

| # | Task | Files |
|---|---|---|
| 1.1 | `provision-data-plane.sh` + `0001_init.sql`; extend `bootstrap-gcp.sh` (APIs, IAM) | `infra/` |
| 1.2 | `driveService.ts`: list an event's Drive folder, fetch file metadata | `api/src/services/driveService.ts` |
| 1.3 | `indexer/job.py`: Drive→GCS mirror (reuse `cloud-run/main.py` conversion patterns for HEIC/RAW/EXIF), detect faces+persons, embed, upsert to pgvector, write `photos`/`photo_embeddings_meta` | `indexer/` |
| 1.4 | Admin "Index event" trigger (api route → Pub/Sub → Job) + scheduled change scan | `api/src/routes/events.ts`, scheduler |
| 1.5 | Idempotency + `model_version` re-index logic | `indexer/` |
| **DoD** | One real event fully indexed; re-running indexes only changed photos; counts reconcile with Drive | |

### M2 — Search API + matcher (1.5–2 weeks)

| # | Task | Files |
|---|---|---|
| 2.1 | `matcher/main.py`: `/embed` endpoint — detect + face/person embeddings + quality/no-face handling | `matcher/` |
| 2.2 | `matcherClient.ts`: call matcher with Cloud Run IAM token (pattern from `cloud-run/main.py` auth) | `api/src/services/matcherClient.ts` |
| 2.3 | `vectorService.ts`: pgvector top-k per kind, event-filtered | `api/src/services/vectorService.ts` |
| 2.4 | `fusion.ts`: combine face+outfit ranks, threshold (PRD §7.2) | `api/src/lib/fusion.ts` |
| 2.5 | `findme.ts`: `POST /api/findme/search` — write upload to Drive (SSOT) + GCS, embed, query, fuse, persist `match_runs`, return signed URLs | `api/src/routes/findme.ts` |
| **DoD** | p95 ≤ 6 s on the M1 event; eval gate (Precision@20 ≥ 0.85) met on 2 events | |

### M3 — Frontend Find Me flow (2 weeks)

| # | Task | Files |
|---|---|---|
| 3.1 | `Events.tsx`, `Gallery.tsx` with CDN/signed-URL grid + Find Me button (FR-1…FR-3) | `web/src/pages/` |
| 3.2 | `ConsentDialog` + consent gate wiring; minor → guardian path (FR-5, D8) | `web/`, `api/src/routes/consent.ts`, `middleware/consentGate.ts` |
| 3.3 | `FindMe.tsx`: upload/capture, no-face fallback, multi-reference tabs (FR-4, FR-7…FR-10) | `web/src/pages/FindMe.tsx` |
| 3.4 | `MyData.tsx` + enrollment reuse "Use my enrolled photo" (FR-10b, D7) | `web/src/pages/MyData.tsx` |
| 3.5 | EN/ZH localization + accessibility + all empty/error states (FR-18…FR-20) | `web/` |
| **DoD** | FR-1…FR-10b pass on iOS Safari + Android Chrome, EN + ZH | |

### M4 — Download/save + feedback (1–1.5 weeks)

| # | Task | Files |
|---|---|---|
| 4.1 | `Results.tsx` multi-select + sticky action bar (FR-11) | `web/src/pages/Results.tsx` |
| 4.2 | `download.ts`: signed-URL batch + zip stream from GCS (FR-12, FR-14) | `api/src/routes/download.ts` |
| 4.3 | "Save to phone" via Web Share API L2 w/ fallback (FR-13) | `web/` |
| 4.4 | `feedback.ts` + UI: "Not me"/"Confirmed" → `match_feedback`, optimistic removal, admin queue (FR-15…FR-17) | `api/src/routes/feedback.ts`, `web/` |
| **DoD** | FR-11…FR-17 pass; feedback feeds the eval set | |

### M5 — Privacy, retention, security, hardening (1.5 weeks)

| # | Task | Files |
|---|---|---|
| 5.1 | `retentionService.ts` + scheduled deletion jobs (uploads 90/30d, enrollment expiry, `match_runs` TTL, GCS lifecycle) (PRD §8.4) | `api/`, scheduler |
| 5.2 | Consent records immutable + revoke→delete cascade; user "delete my data" (PRD §8) | `api/src/services/consentService.ts`, `retentionService.ts` |
| 5.3 | `rateLimit.ts` + reCAPTCHA Enterprise on upload; upload size/MIME allowlist; decompression-bomb guard | `api/src/middleware/rateLimit.ts`, `matcher/` |
| 5.4 | Budget alert $50/mo, Cloud Run max-instances caps, per-service runtime SAs verified | `infra/` |
| 5.5 | Firestore + Storage security rules tightened; audit logging of consent/deletion | `infra/firestore.rules`, `infra/storage.rules` |
| 5.6 | **Legal review of consent + minor language (launch gate)** | doc/sign-off |
| **DoD** | PRD §8/§9 complete; legal sign-off; deletion verified end-to-end | |

### M6 — Pilot & launch (1 week + soak)

| # | Task |
|---|---|
| 6.1 | Feature-flag Find Me to one real event; invite a small attendee group |
| 6.2 | Measure PRD §2 metrics (precision, latency, deflection, consent coverage) |
| 6.3 | Write `cloud-webapp/docs/FINDME_RUNBOOK.md` (deploy, re-index, incident, data-deletion) in the style of `cloud-run/DEPLOY_RUNBOOK.md` |
| 6.4 | Remove flag; general rollout to link/login-gated events |

**Rough total:** ~10–12 weeks of focused work for 1–2 engineers — consistent with the "6–10 weeks part-time" envelope in `UX_AND_GCP_ASSESSMENT.md` §2.6, with the extra time attributable to the ML/privacy surface.

---

> **⚠️ STATUS UPDATE (2026-06-16) — §5A P0 + cheap bug fixes shipped (code).**
> Implemented and unit-tested (CI-green locally: api 52, web 11, indexer 12;
> typecheck + eslint clean): **B1** original-resolution batch ZIP download
> (`api/src/routes/download.ts` streaming `application/zip` of the `orig`
> derivatives; `gcsService` orig helpers + mime→ext map mirroring `indexer/job.py`;
> shared `DownloadRequest` + `MAX_DOWNLOAD_PHOTOS=200`; `apiDownloadFile` client
> helper), **B2** selection UI (pure `selection.ts` reducer + `useSelection` hook,
> `SelectBar` with Select all / none / invert, wired into FindMe results **and** the
> Gallery), **B4** Gallery back-navigation (breadcrumb to Events + event-name
> header), **B5** real event names (indexer backfills `events.name` from the Drive
> folder name when empty — never clobbering an admin/Sheet name — `gallery` API
> returns `eventName`, and the shared `eventLabel()` helper guarantees the literal
> "Untitled event" is never shown for an event with photos). Still open in §5A:
> **B3** (switch active selfie), **B6** (content-hash dedup, needs an indexer
> re-run), **B7** (wrong-match feedback). New runtime dep: `archiver`. No new IAM
> (api-runtime already has derivatives access for signing). Not yet deployed/pushed.

## 5A. Demo-feedback backlog (2026-06-15)

Tickets from hands-on use of the shipped demo (PRD §4.8). Priority is **P0** (ship next) → **P2**. These do not add a milestone; they slot into M1 (indexing), M3 (frontend), and M4 (download/feedback). Two are bugs in the demo slice; the rest are deferred-but-designed work now confirmed and ordered.

| # | Item (PRD ref) | Type | Priority | Maps to | Files | Notes |
|---|---|---|---|---|---|---|
| B1 | Original-resolution batch ZIP download (FR-12) | feature | **P0** | M4.2 | `api/src/routes/download.ts`, `services/gcsService.ts`, `web/src/pages/Results.tsx` | The most-wanted capability. ZIP streams the **originals** (or `orig` derivative), not `web`/`thumb`. Short-TTL signed URLs; per-user rate limit (§M5.3). |
| B2 | Selection UI before download (FR-11) | feature | **P0** | M4.1 | `web/src/pages/Results.tsx`, `components/SelectBar` | First-class **Select all / Select none / select-all-then-deselect**. Selection drives B1. Keyboard-accessible. |
| B3 | Show & switch active reference selfie (FR-9b) | feature | **P1** | M3.3 | `web/src/pages/FindMe.tsx`, `Results.tsx`, `api/src/routes/findme.ts` | Display the selfie that produced the current set; upload-history picker to switch per-selfie result sets. Fixes "results from different people are mixed." No silent cross-upload blending except the explicit deduped combined view. |
| B4 | Gallery → back to event / Events (FR-2b) | **bug** | **P1** | M3.1 | `web/src/pages/Gallery.tsx`, router/`App.tsx` | Add breadcrumb/back control; ensure browser back works without reload/auth bounce. |
| B5 | Event name instead of "Untitled event" (FR-1b) | **bug** | **P1** | M1.3 / M1.4 | `indexer/job.py`, `api/src/routes/events.ts`, `web/src/pages/{Events,Gallery}.tsx` | Populate `events.name` from Drive folder name at index/sync; admin-editable override; UI never renders the literal "Untitled event" for an event with photos. |
| B6 | De-duplicate gallery photos (FR-2c) | feature | **P1** | M1.3 / M1.5 | `indexer/job.py`, `api/src/routes/events.ts` | Dedup at index time by content hash (SHA-256 of bytes; perceptual hash for re-encodes), not filename. One `photoId` per unique image; defensive de-dupe at list time. Add an audit query. |
| B7 | Wrong-match feedback (FR-15) | feature | **P2** | M4.4 | `api/src/routes/feedback.ts`, `web/` | "Not me / wrong match" per result → `match_feedback`, optimistic removal. Pairs with B3. Already an M4 deliverable; confirmed in scope this round. |
| B8 | Instant event-metadata push on creation | feature | **P1** | M1.4 | `gas-app/src/routes/uploadHandlers.ts` (+ event/link creation handlers), `gas-app/src/services/indexTriggerClient.ts`, `api/src/routes/sync.ts` | Today new events reach Firestore only via the **daily** `findme-drive-sync` reconciler — no GAS push on creation. Have the gas-app call `POST /api/admin/sync` (reusing the existing `X-Sync-Token` machine path, same as B-series triggers) immediately after creating an event or upload link, so events/names appear in seconds, not up to a day. Best-effort/non-fatal like the end-of-batch index trigger; the daily reconciler stays as backstop. **Photo indexing already auto-pushes** (end-of-batch `triggerEventIndex` + 10-min `findme-index-scan`); this closes the remaining metadata gap. NOT the abandoned per-photo `firestoreClient.ts` push path. |

**Sequencing.** B1+B2 ship together first (they are the headline ask and are mutually dependent). B4 and B5 are cheap bug fixes that can land in parallel. **B8 should land with (or just before) B5** — instant metadata sync is the root cause of the "Untitled event" delay B5 fixes; with B8 a freshly created event surfaces its name in seconds. B3 is the largest frontend change and lands with B7. B6 requires an indexer re-run on the live event after the hash logic is added (use `{"force":true}` per `CLAUDE.md` indexer notes).

**Auto-push status (context for B8).** Photo indexing is already fully event-driven: a finished upload batch fires `triggerEventIndex` → `POST /api/events/:id/index`, with a 10-minute `findme-index-scan` backstop (`AUTOMATED_INDEXING_IMPLEMENTATION.md` / `AUTOMATED_INDEXING_RUNBOOK.md`). The only non-instant link in the GAS→cloud chain is **event/link creation**, which today waits on the daily reconciler — that is exactly what B8 closes.

**Test additions (extend §6).** Download: assert ZIP entries are original bytes and links die after TTL. Selection: reducer unit tests for all-three actions. FR-9b: result sets never merge across distinct uploads except the combined view. Dedup: indexing a folder with known duplicates yields one tile per unique content hash. Event name: indexed event exposes a non-empty `name`; UI fallback never emits "Untitled event". B8: creating an event/link in the gas-app issues a `POST /api/admin/sync` and the event appears in Firestore without waiting for the daily job; a failed sync call is swallowed (non-fatal) and the daily reconciler still backfills.

---

## 6. Test strategy ("create all tests")

Testing is built per-phase, not bolted on at the end. CI must be green before any deploy.

### 6.1 Unit tests

- **api (Vitest, existing setup):** fusion math (`fusion.ts`) with fixed vectors; signed-URL generation; consent-gate middleware (blocks without consent, allows with); rate-limit logic; retention cascade (mock Firestore/GCS/Drive); zod schema validation in `shared/`.
- **web (Vitest + React Testing Library):** consent dialog can't be bypassed; multi-select reducer; results dedup/merge; enrollment opt-in/delete; empty/no-face/low-confidence states render.
- **matcher/indexer (pytest, pattern from `cloud-run/test_main.py`):** detect/embed on fixture images; no-face handling; quality filtering; HEIC/RAW/EXIF orientation (reuse existing conversion tests); idempotent upsert.

### 6.2 Integration tests

- **api ↔ pgvector ↔ matcher** against the **Firestore emulator** and an **ephemeral Postgres+pgvector container** (Testcontainers/Docker in CI). Verifies the full `search` path returns expected photos for a seeded event.
- **Drive write path** against a mocked Drive API (and one gated live smoke test in a sandbox folder).
- **Download/zip** path: assert zip contents + that links die after TTL.

### 6.3 End-to-end tests

- **Playwright** across the six PRD steps on Chromium + WebKit (mobile viewport): choose event → gallery → consent → upload → results → multi-select download → feedback. Includes the minor/guardian branch and the "use enrolled photo" branch.

### 6.4 Matching-quality evaluation harness (the ML-specific tests)

- `eval/` harness: a labeled set per event (seeded from `match_feedback` + manual labels). Computes **Precision@K, Recall, false-positive rate** per model version and per fusion weight. Runs in CI as a **non-blocking report** (accuracy is data-dependent) and as a **release gate** before enabling a new event or model (must meet PRD §2 targets). Tracks regressions across `model_version`.

### 6.5 Security & privacy tests

- Authz tests: a user cannot get signed URLs for an event they can't access; cannot search across events; cannot read another user's uploads/runs.
- Deletion tests: delete/ revoke removes Drive copy + GCS copy + vector + run records (assert all four gone).
- Abuse tests: rate limit trips; reCAPTCHA failure blocks; oversized/wrong-MIME upload rejected; decompression-bomb image rejected.

### 6.6 Load test

- k6/Locust simulating the event-weekend burst (PRD §3): 500 concurrent gallery loads + a search spike. Validates CDN cache hit ratio, matcher min-instances setting, and Cloud SQL connection pool.

---

## 7. CI/CD (extends existing GitHub Actions)

Existing workflows: `ci.yml`, `deploy-api.yml`, `deploy-web.yml` (Workload Identity Federation, no SA keys — keep this). Add:

- **`ci.yml`** — add pytest for `matcher/`+`indexer/`, Postgres+pgvector service container for api integration tests, Playwright e2e, and the eval-harness report.
- **`deploy-matcher.yml`** / **`deploy-indexer.yml`** — build + push Python images to Artifact Registry, `gcloud run deploy` (matcher) / `gcloud run jobs deploy` (indexer), new revision gets 0% traffic until smoke test passes (matches the api pattern in `ARCHITECTURE.md`).
- **DB migrations** — run `infra/sql/*.sql` via a guarded migration step.
- All deploys via WIF; secrets via `--set-secrets`.

---

## 8. Cutover, rollback, ops

- **Parallel to live.** Find Me ships disabled behind a flag; the existing `gas-app` keeps running untouched. No big-bang cutover.
- **GAS stays the workflow of record during the demo.** While we demo `cloud-webapp`, super-admin and club-admin users continue to do all of their real work — creating events, generating upload links, and uploading files — in the Apps Script app. `cloud-webapp` is shown as a read-mostly preview of the new Find Me experience and is seeded from existing Drive/Sheet data; it does not yet own any admin workflow. The Google Sheets master file in Drive remains the source of truth throughout.
- **Planned sync (post-demo).** Two-way reconciliation is roadmap, not demo scope: (1) `cloud-webapp` pulls from Drive/Sheets — an admin "Sync with Drive" button (and a scheduled job) reconciles events and tags from the master Sheet into Firestore; (2) GAS optionally pushes event/link/upload changes to `cloud-webapp` for near-real-time updates. Drive/Sheets stays authoritative; the cloud copy is derived.
- **Rollback.** Cloud Run keeps prior revisions; flip traffic back. DB migrations are additive/forward-only with a documented down path.
- **Re-index.** A bumped `model_version` triggers background re-embedding per event; old vectors serve until the new set is ready.
- **Cost guardrails.** Budget alert at $50/mo, max-instances caps, matcher scale-to-zero off-peak, pre-warm before known events (PRD §9, §10).
- **Runbook.** `cloud-webapp/docs/FINDME_RUNBOOK.md` documents deploy, re-index, data-deletion request handling, and incident response.

---

## 9. Risks specific to the build (beyond PRD §11)

| Risk | Mitigation |
|---|---|
| Drive read auth (domain-wide delegation) is fiddly to set up | Resolve in M0 (task 0.4) before pipeline work; document the exact grant |
| pgvector recall tuning (HNSW params) | Tune `m`/`ef_search` in M0/M2 against the eval harness |
| Python model image is large / slow cold start | Pin model files in the image, keep matcher warm during events, CPU-optimized ONNX runtime |
| EXIF/HEIC/RAW edge cases on reference uploads | Reuse the battle-tested conversion code from `cloud-run/main.py` |
| e2e flakiness on mobile WebKit | Run Playwright WebKit in CI from day one of M3 |

---

## 10. Definition of done (whole feature)

- All six PRD user-journey steps work on mobile EN/ZH behind link-or-login.
- CI green: unit + integration + e2e + security/privacy tests; eval harness meets PRD §2 accuracy targets on ≥2 events.
- GCP provisioned by script (no click-ops); per-service least-privilege SAs.
- Privacy controls live: consent gate, minor/guardian path, retention/deletion verified end-to-end, legal sign-off.
- Runbook written; budget alerts and max-instances caps in place.
- Pilot metrics meet targets; flag removed.

---

## References

- `FACE_MATCHING_FEATURE_PRD.md` — the requirements this plan implements.
- `cloud-webapp/ARCHITECTURE.md` — stack, request flow, deploy flow, WIF.
- `cloud-webapp/infra/scripts/bootstrap-gcp.sh` — existing provisioning to extend.
- `cloud-run/main.py`, `cloud-run/DEPLOY_RUNBOOK.md`, `cloud-run/test_main.py` — Python Cloud Run + conversion + test patterns to reuse.
- `STORAGE_AND_DATABASE_OPTIONS.md` — Drive-as-archive vs GCS serving; pgvector context.
