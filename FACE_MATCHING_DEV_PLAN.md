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

## 0.1 Status at a glance — legend & §5A↔Mx reconciliation (2026-06-16)

The §5A demo-feedback backlog (B1–B8) and milestones M1/M3/M4 describe the **same
work from two angles**: §5A is the ticket-level view of items that live *inside*
those milestones. They are not separate scopes. This section is the single source
of truth for status; the milestone tables (§5) and the §5A table now carry the
same markers and cross-reference each other.

**Status legend**

| Mark | Meaning |
|---|---|
| ✅ | **Done & live** — deployed/pushed and running (demo fast-path or earlier) |
| 🟢 | **Code-complete** — implemented + unit-tested locally (CI-green), **not yet deployed/pushed** |
| 🟡 | **Partial** — some sub-tasks done, others still open |
| ⬜ | **To do** — not started |

**§5A ↔ milestone map** (every backlog item is a ticket within an existing milestone — no new milestone):

| §5A | Maps to | Status | One-liner |
|---|---|---|---|
| B1 — original-res ZIP download (FR-12) | **M4.2** | 🟢 | `download.ts` zip-streams `orig` derivatives; shipped 2026-06-16, not deployed |
| B2 — selection UI (FR-11) | **M4.1** | 🟢 | `selection.ts`/`useSelection`/`SelectBar` in FindMe + Gallery; not deployed |
| B3 — switch active selfie (FR-9b) | **M3.3** | 🟢 | per-selfie result sets + picker in `FindMe.tsx`; shipped 2026-06-16b, not deployed |
| B4 — Gallery back-nav (FR-2b) | **M3.1** | 🟢 | breadcrumb to Events + event header; not deployed |
| B5 — real event names (FR-1b) | **M1.3 / M1.4** | 🟢 | indexer backfills `events.name` from Drive folder; not deployed |
| B6 — content-hash dedup (FR-2c) | **M1.3 / M1.5** | 🟢 | md5 de-dup in indexer; **needs re-run** (`{"force":true}`) on indexed events; not deployed |
| B7 — wrong-match feedback (FR-15) | **M4.4** | 🟢 | `feedback.ts` + per-result buttons; shipped 2026-06-16b, not deployed |
| B8 — instant event-metadata push | **M1.4** | 🟢 | gas-app `triggerMetadataSync()` → `POST /api/admin/sync` on event + link creation; shipped 2026-06-16c, not deployed |

**Net:** §5A is **B1–B8 all code-complete** — one deploy (api + web + gas-app `clasp push`) plus a B6 indexer re-run away from live. The milestone tables below reflect this: M0–M2 are done/live, M1's last gap (B8 metadata push) is closed in code, M3 and M4 are mostly addressed by the (undeployed) §5A work, and M5–M6 are still to do.

---

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

### M0 — Spike & decisions (1–2 weeks) — ✅ Done

| # | Task | Status | Output |
|---|---|---|---|
| 0.1 | Stand up `matcher/` skeleton; load a face model (InsightFace/ArcFace ONNX) and a person-ReID model; embed a sample of ~500 real event photos | ✅ | Embeddings produced locally / on a dev Cloud Run |
| 0.2 | ~~Stand up Cloud SQL + pgvector dev instance~~ → **load sample embeddings from GCS, brute-force query in matcher** (per 2026-06-09 decision) | ✅ | Working query path (flat-file GCS store) |
| 0.3 | Hand-label known attendees and measure Precision@20/Recall (face/outfit/fused) | ✅ | Scope **relaxed to 2 labeled people** on `ev_sample`; exhaustive labeling deferred to the feedback loop (`EVAL_FEEDBACK_LOOP.md`) |
| 0.4 | Confirm Drive read approach (domain-wide delegation vs shared-folder SA) | ✅ | **Domain-wide delegation** (keyless, `signJwt`, impersonating `admin@mmrunners.org`) — `SETUP_NOTES.md` G1 |
| 0.5 | Confirm pgvector vs Vertex (cost recheck per PRD §10.1) | ✅ | **Flat-file GCS embedding store**; pgvector/Vertex dropped (no free tier) |
| **DoD** | | ✅ | Spot-eval gate met; fusion weights chosen; **go = demo fast-path shipped** |

### M1 — Indexing pipeline (1.5–2 weeks) — 🟢 Done (B5/B6/B8 code-complete, pending deploy + B6 re-run)

| # | Task | Status | Files |
|---|---|---|---|
| 1.1 | `provision-data-plane.sh` + ~~`0001_init.sql`~~ (replaced by GCS manifest layout); extend `bootstrap-gcp.sh` (APIs, IAM) | ✅ | `infra/` |
| 1.2 | `driveService.ts`: list an event's Drive folder, fetch file metadata | ✅ | `api/src/services/driveService.ts` |
| 1.3 | `indexer/job.py`: Drive→GCS mirror (HEIC/RAW/EXIF), detect faces+persons, embed, write flat `.npy` + manifest, write `photos` meta | ✅ | `indexer/` — **+B5** (backfill `events.name`, 🟢) **+B6** (content-hash de-dup, 🟢, needs re-run) |
| 1.4 | Admin "Index event" trigger (api route → job) + scheduled change scan | ✅ photos / 🟢 **B8** metadata | Auto-push live: end-of-batch `triggerEventIndex` + 10-min `findme-index-scan`. **B8** now code-complete: gas-app `triggerMetadataSync()` fires `POST /api/admin/sync` on event + link creation so names appear in seconds; daily reconciler remains the backstop. Not yet deployed/pushed |
| 1.5 | Idempotency + `model_version` re-index logic | ✅ | `indexer/` — **B6** dedup hooks in here (🟢) |
| **DoD** | One real event fully indexed; re-run indexes only changed photos; counts reconcile with Drive | ✅ | Met. Outstanding: deploy B5/B6 + B6 indexer re-run; B8 metadata push |

### M2 — Search API + matcher (1.5–2 weeks) — ✅ Done & live (demo fast-path, 2026-06-12)

| # | Task | Status | Files |
|---|---|---|---|
| 2.1 | `matcher/main.py`: `/embed` endpoint — detect + face/person embeddings + quality/no-face handling | ✅ | `matcher/` |
| 2.2 | `matcherClient.ts`: call matcher with Cloud Run IAM token | ✅ | `api/src/services/matcherClient.ts` |
| 2.3 | `vectorService.ts`: top-k per kind, event-filtered (GCS flat-file store, in-memory cosine) | ✅ | `api/src/services/vectorService.ts` |
| 2.4 | `fusion.ts`: combine face+outfit ranks, threshold (PRD §7.2) | ✅ | `api/src/lib/fusion.ts` |
| 2.5 | `findme.ts`: `POST /api/findme/search` — embed, query, fuse, persist `match_runs`, return signed URLs | ✅ | `api/src/routes/findme.ts` — Drive mirror of reference uploads (D6) still deferred (see M3/M5) |
| **DoD** | p95 ≤ 6 s on the M1 event; eval gate (P@20 ≥ 0.85) on 2 events | 🟡 | Latency met. Eval gate now **judged precision via the feedback loop** (`EVAL_FEEDBACK_LOOP.md`); M0-style spot eval is the interim gate until feedback accrues |

### M3 — Frontend Find Me flow (2 weeks) — 🟡 Partial (demo slice live; rest deferred/code-complete)

| # | Task | Status | Files |
|---|---|---|---|
| 3.1 | `Events.tsx`, `Gallery.tsx` with signed-URL grid + Find Me button (FR-1…FR-3) | ✅ live + 🟢 **B4** | `web/src/pages/` — demo grid live; **B4** back-nav (FR-2b) code-complete, not deployed |
| 3.2 | `ConsentDialog` + consent gate; minor → guardian path (FR-5, D8) | 🟢 (copy pending legal) | **Minor/guardian mechanism shipped 2026-06-16d**: consent UI asks "under 18?" → requires guardian-attestation checkbox; `subjectIsMinor`/`guardianAttested` sent to `findme/search` and **enforced server-side** (`guardian_required` 403) + recorded on the `consents` doc. Final consent *wording* still gated on legal review (M5.6) |
| 3.3 | `FindMe.tsx`: upload/capture, no-face fallback, multi-reference tabs (FR-4, FR-7…FR-10) | 🟢 | Upload/search live; **B3** per-selfie result sets + switcher (FR-9b); **no-face fallback (FR-7) shipped 2026-06-16d** — `no_usable_face` now offers "Search by outfit instead" (re-runs `mode=person`, which the matcher already supports). Not deployed |
| 3.4 | `MyData.tsx` + enrollment reuse "Use my enrolled photo" (FR-10b, D7) | 🟡 (reuse done; MyData/enroll pending) | **Reference reuse shipped 2026-06-16e**: fresh uploads persist to the uploads bucket + a `find_me_uploads` record (90/30-day `expiresAt`, PRD §8.4); `GET /api/findme/uploads` lists the caller's own past selfies; `POST /api/findme/uploads/:id/search` reuses one against any event; FindMe shows a **multi-select picker of past photos**, each producing its own result set (FR-9). Still open: a dedicated **My Data** screen (view/delete/opt-in enrollment) + delete-cascade (overlaps M5.1/5.2) |
| 3.5 | EN/ZH localization + accessibility + all empty/error states (FR-18…FR-20) | ⬜ | **ZH localization deferred** (cross-cutting i18n refactor); a11y/state coverage outstanding |
| **DoD** | FR-1…FR-10b pass on iOS Safari + Android Chrome, EN + ZH | 🟡 | Remaining: deploy; build 3.4 enrollment; 3.5 ZH/i18n |

### M4 — Download/save + feedback (1–1.5 weeks) — 🟢 Code-complete (pending deploy)

| # | Task | Status | Files |
|---|---|---|---|
| 4.1 | `Results.tsx` multi-select + sticky action bar (FR-11) = **B2** | 🟢 | `selection.ts` reducer + `useSelection` + `SelectBar` (Select all/none/invert), wired into FindMe **and** Gallery; not deployed |
| 4.2 | `download.ts`: signed-URL batch + zip stream from GCS (FR-12, FR-14) = **B1** | 🟢 | Streams `application/zip` of `orig` derivatives; `MAX_DOWNLOAD_PHOTOS=200`; new dep `archiver`; not deployed |
| 4.3 | "Save to phone" via Web Share API L2 w/ fallback (FR-13) | 🟢 | **Shipped 2026-06-16d**: `web/src/lib/share.ts` (`canShareFiles`/`shareFiles`/`saveToPhone`, unit-tested) + `apiFetchBlob`; "📲 Save to phone" in `SelectBar` shares the originals ZIP via the native sheet, falls back to download where Web Share L2 is absent |
| 4.4 | `feedback.ts` + UI: "Not me"/"That's me" → `match_feedback`, optimistic removal + admin queue (FR-15…FR-17) = **B7** | 🟢 | B7 vote write + per-result buttons; **admin review queue shipped 2026-06-16d**: `GET /api/admin/feedback` (admin-gated, eventId/verdict filters, verdict counts) |
| **DoD** | FR-11…FR-17 pass; feedback feeds the eval set | 🟢 | Code-complete; remaining is deploy + an admin UI page to render the queue |

### M5 — Privacy, retention, security, hardening (1.5 weeks) — 🟡 Partial (5.3 done)

| # | Task | Status | Files |
|---|---|---|---|
| 5.1 | `retentionService.ts` + scheduled deletion jobs (uploads 90/30d, enrollment expiry, `match_runs` TTL, GCS lifecycle) (PRD §8.4) | ⬜ | `api/`, scheduler |
| 5.2 | Consent records immutable + revoke→delete cascade; user "delete my data" (PRD §8) | ⬜ | `api/src/services/consentService.ts`, `retentionService.ts` |
| 5.3 | `rateLimit.ts` + reCAPTCHA Enterprise on upload; upload size/MIME allowlist; decompression-bomb guard | 🟢 | **Shipped 2026-06-16d**: `middleware/rateLimit.ts` (Firestore fixed-window, fail-open, on `findme/search` + `download`), `middleware/recaptcha.ts` + `services/recaptcha.ts` (Enterprise assessment, no-op until keyed, fail-open on infra error, fail-closed on bad verdict), config env. MIME allowlist + 15 MB cap already in `findme.ts`; matcher `MAX_IMAGE_PIXELS` + `MAX_UPLOAD_BYTES` guards already present. Not deployed; needs reCAPTCHA key + a `rate_limits.expireAt` TTL policy |
| 5.4 | Budget alert $50/mo, Cloud Run max-instances caps, per-service runtime SAs verified | ⬜ | `infra/` |
| 5.5 | Firestore + Storage security rules tightened; audit logging of consent/deletion | ⬜ | `infra/firestore.rules`, `infra/storage.rules` |
| 5.6 | **Legal review of consent + minor language (launch gate)** | ⬜ | doc/sign-off — the minor/guardian *mechanism* (3.2) is built; the *wording* still needs counsel |
| **DoD** | PRD §8/§9 complete; legal sign-off; deletion verified end-to-end | 🟡 | 5.3 done; 5.1/5.2/5.4/5.5/5.6 remain |

### M6 — Pilot & launch (1 week + soak) — 🟡 Partial (flag + metrics + runbook code-complete 2026-06-17f; pilot run + legal gate remain)

| # | Task | Status |
|---|---|---|
| 6.1 | Feature-flag Find Me to one real event; invite a small attendee group | 🟢 **mechanism shipped 2026-06-17f** — two-knob flag (`FINDME_ENABLED` global kill switch + `FINDME_EVENT_ALLOWLIST` per-event allowlist) in `config.ts`, enforced in `findme.ts` `runSearch` (`403 feature_unavailable`) before any biometric work; default-permissive so nothing changes until an operator opts in. Not deployed; the actual attendee-invite pilot ⬜. Informal demo already ran on live event `d2307147-…` |
| 6.2 | Measure PRD §2 metrics (precision, latency, deflection, consent coverage) | 🟢 **data-derived slice shipped 2026-06-17f** — `GET /api/admin/metrics` (admin) rolls up searches, distinct searchers, mode split, minor searches, consent coverage, feedback-judged precision, and erasures over a window. Out-of-band metrics (p95 latency, $ spend, recall, deflection) sourced per `docs/FINDME_RUNBOOK.md` §5. Not deployed |
| 6.3 | Write `cloud-webapp/docs/FINDME_RUNBOOK.md` (deploy, re-index, incident, data-deletion) | 🟢 **written 2026-06-17f** — `cloud-webapp/docs/FINDME_RUNBOOK.md`: system map, deploy (incl. the `--set-env-vars` survival gotcha), pilot flag, re-index, metrics, incident table, data-deletion/DSR, rollback, pre-launch checklist. Not pushed |
| 6.4 | Remove flag; general rollout to link/login-gated events | ⬜ (supported by 6.1: clear `FINDME_EVENT_ALLOWLIST` → all events) |

**Rough total:** ~10–12 weeks of focused work for 1–2 engineers — consistent with the "6–10 weeks part-time" envelope in `UX_AND_GCP_ASSESSMENT.md` §2.6, with the extra time attributable to the ML/privacy surface.

---

> **⚠️ STATUS UPDATE (2026-06-17f) — M6 pilot scaffolding shipped (code): feature flag + metrics + runbook.**
> Resumes the dev plan at M6. CI-green locally (api typecheck + eslint clean;
> **api suite 110 tests / 18 files**, +10 new). **M6.1 feature flag:** a two-knob
> pilot gate — `FINDME_ENABLED` (global kill switch) and `FINDME_EVENT_ALLOWLIST`
> (comma-separated per-event allowlist) in `api/src/lib/config.ts`
> (`isFindMeEnabledForEvent`), enforced in `findme.ts` `runSearch` **before any
> biometric processing** (`403 feature_unavailable`). Default-permissive
> (`enabled`, empty allowlist = all events) so the demo and existing tests are
> unaffected until an operator opts in; flip via `--update-env-vars` (transient)
> or the `deploy-api.yml` `--set-env-vars` list (durable). Tests:
> `featureFlag` (3, pure helper) + `findmeFeatureFlag` (2, route wiring).
> **M6.2 metrics:** `GET /api/admin/metrics` (admin-gated; `routes/metrics.ts` +
> shared `metrics.ts` schema) aggregates `match_runs`/`consents`/`match_feedback`
> over a window into searches, distinct searchers, mode split, minor searches,
> consent coverage, feedback-judged precision, and erasures — the data-derivable
> slice of PRD §2. Tests: `metrics` (5). **M6.3 runbook:**
> `cloud-webapp/docs/FINDME_RUNBOOK.md` (deploy / pilot-enable / re-index /
> metrics / incident table / data-deletion / rollback / pre-launch checklist),
> folding in the `CLAUDE.md` ops notes. **Not deployed/pushed.** Still open:
> M6.1 actual attendee pilot, M6.4 general rollout, and the M5.6 legal sign-off
> (launch gate); the unbuilt M5.1 retention Job + missing admin-erasure endpoint
> are flagged as launch caveats in the runbook §7.
>
> **⚠️ STATUS UPDATE (2026-06-16e) — reference reuse / "match this event with a past photo" shipped (code).**
> Implements the D7/FR-10b reuse half of M3.4 (CI-green locally: api 87 tests /
> 13 files, web 25 tests, typecheck + eslint clean). Fresh `findme/search`
> uploads now **persist** to the uploads bucket (`gcsService.uploadReference`)
> plus a `find_me_uploads` Firestore record (`services/references.ts`) with a
> 90/30-day `expiresAt` (PRD §8.4). New endpoints: `GET /api/findme/uploads`
> (lists the caller's own non-expired selfies, self-service-only) and
> `POST /api/findme/uploads/:uploadId/search` (reuses a stored selfie against any
> event — owner-checked 404, minor/guardian gate re-enforced, 410 if the bytes
> expired). The search core is refactored into a shared `runSearch`. UI: a
> **multi-select picker of past photos** in the FindMe "pick" step, each selected
> photo producing its own switchable result set (FR-9). Config: `UPLOADS_BUCKET`
> + retention-day envs. New tests: `findmeUploads` (7) + extended `findme`.
> **Not deployed.** Needs the uploads bucket to exist with a matching
> object-lifecycle (or the M5.1 deletion job) and a `find_me_uploads.expiresAt`
> TTL policy. Still open in M3.4: the **My Data** screen (view/delete/opt-in
> persistent enrollment) and the delete-cascade (overlaps M5.1/5.2).
>
> **⚠️ STATUS UPDATE (2026-06-16d) — M5.3 hardening + M4.3/4.4 + M3 fallback/minor-gate shipped (code).**
> Post-§5A milestone work, CI-green locally (api typecheck + new tests pass;
> web typecheck + 25 web tests pass; eslint clean). **M5.3:** per-user rate
> limiting (`middleware/rateLimit.ts`, Firestore fixed-window, fail-open) on
> `findme/search` + `download`, and reCAPTCHA Enterprise (`middleware/recaptcha.ts`
> + `services/recaptcha.ts`, no-op until keyed, fail-open on infra error /
> fail-closed on a bad verdict); new config env; matcher decompression-bomb +
> upload-size guards confirmed already present. **M4.3:** "Save to phone" via Web
> Share API L2 (`web/src/lib/share.ts` + `apiFetchBlob`, "📲 Save to phone" in
> `SelectBar`) with download fallback. **M4.4:** admin review queue
> `GET /api/admin/feedback` (admin-gated, eventId/verdict filters + counts).
> **M3:** no-face → outfit-only fallback (FR-7; `findme/search` now takes
> `mode`, matcher already supports `person`), and the minor/guardian consent
> mechanism (FR-5/D8) — UI asks "under 18?" → guardian attestation, enforced
> server-side (`guardian_required`) and recorded on the consent doc; final
> consent *wording* still gated on legal (M5.6). New tests: api `rateLimit`,
> `recaptcha`, `feedbackAdmin`, extended `findme`; web `share`. **Not deployed**;
> reCAPTCHA needs a key + a `rate_limits.expireAt` Firestore TTL policy. Still
> open: M3.4 enrollment/MyData, M3.5 ZH/i18n, M5.1/5.2/5.4/5.5/5.6, M6.
>
> **⚠️ STATUS UPDATE (2026-06-16b) — §5A B3/B6/B7 shipped (code).** Completes the
> §5A backlog (CI-green locally: api 56, web 15, indexer 13; typecheck + eslint
> clean): **B6** content-hash de-dup — the indexer collapses byte-identical
> images by Drive `md5Checksum` before download (canonical = first in relPath
> order), stores `contentHash`/`duplicateCount` on each photo + a `duplicates`
> audit map in the manifest and `indexState.duplicates`; `gallery.ts` de-dupes
> defensively at list time; new admin `GET /api/events/:id/duplicates` audit
> route. Perceptual-hash dedup of re-encodes is a noted follow-up. **B7**
> wrong-match feedback — shared `feedback` schema, `api/src/routes/feedback.ts`
> writing immutable `match_feedback` docs keyed to `runId`, per-result "Not me /
> That's me" buttons with optimistic removal. **B3** reference-selfie history —
> `FindMe.tsx` keeps a result set per uploaded selfie with a picker to switch,
> an explicit deduped Combined view, and no cross-upload blending elsewhere
> (pure `web/src/lib/results.ts` helpers, unit-tested). **B6 needs an indexer
> re-run** (`{"force":true}`) on already-indexed events to collapse existing
> duplicates and populate `contentHash`. Not yet deployed/pushed.
>
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

Tickets from hands-on use of the shipped demo (PRD §4.8). Priority is **P0** (ship next) → **P2**. These do not add a milestone; they slot into M1 (indexing), M3 (frontend), and M4 (download/feedback) — see the §0.1 reconciliation map for the canonical status. Two are bugs in the demo slice; the rest are deferred-but-designed work now confirmed and ordered.

**Status (2026-06-16c):** **B1–B8 are all 🟢 code-complete and unit-tested locally, not yet deployed/pushed.** B6 additionally needs an indexer re-run on already-indexed events. B8 — the last open item — is now implemented (`gas-app/src/services/indexTriggerClient.ts` `triggerMetadataSync()`, wired into `serverCreateEvent` + `serverGenerateLink`, 10 new unit tests; gas-app typecheck clean, handler tests green). Legend in §0.1.

| # | Item (PRD ref) | Type | Priority | Status | Maps to | Files | Notes |
|---|---|---|---|---|---|---|---|
| B1 | Original-resolution batch ZIP download (FR-12) | feature | **P0** | 🟢 not deployed | M4.2 | `api/src/routes/download.ts`, `services/gcsService.ts`, `web/src/pages/Results.tsx` | Shipped 2026-06-16. ZIP streams the `orig` derivatives; `MAX_DOWNLOAD_PHOTOS=200`; new dep `archiver`. Short-TTL signed URLs; per-user rate limit (§M5.3) **still to add**. |
| B2 | Selection UI before download (FR-11) | feature | **P0** | 🟢 not deployed | M4.1 | `web/src/pages/Results.tsx`, `components/SelectBar` | Shipped 2026-06-16. `selection.ts` reducer + `useSelection`; Select all / none / invert; wired into FindMe **and** Gallery. Keyboard-accessible. |
| B3 | Show & switch active reference selfie (FR-9b) | feature | **P1** | 🟢 not deployed | M3.3 | `web/src/pages/FindMe.tsx`, `Results.tsx`, `api/src/routes/findme.ts` | Shipped 2026-06-16b. Result set per uploaded selfie + picker to switch; explicit deduped Combined view; no silent cross-upload blending (`web/src/lib/results.ts`, unit-tested). |
| B4 | Gallery → back to event / Events (FR-2b) | **bug** | **P1** | 🟢 not deployed | M3.1 | `web/src/pages/Gallery.tsx`, router/`App.tsx` | Shipped 2026-06-16. Breadcrumb to Events + event-name header. |
| B5 | Event name instead of "Untitled event" (FR-1b) | **bug** | **P1** | 🟢 not deployed | M1.3 / M1.4 | `indexer/job.py`, `api/src/routes/events.ts`, `web/src/pages/{Events,Gallery}.tsx` | Shipped 2026-06-16. Indexer backfills `events.name` from Drive folder (never clobbers an admin/Sheet name); `eventLabel()` guarantees the literal "Untitled event" never shows for an event with photos. **Pairs with B8** (B8 removes the up-to-a-day delay before the name appears). |
| B6 | De-duplicate gallery photos (FR-2c) | feature | **P1** | 🟢 not deployed — **needs indexer re-run** | M1.3 / M1.5 | `indexer/job.py`, `api/src/routes/events.ts` | Shipped 2026-06-16b. Collapses byte-identical images by Drive `md5Checksum` (canonical = first in relPath order); `contentHash`/`duplicateCount` per photo + `duplicates` audit map; defensive de-dupe at list time; admin `GET /api/events/:id/duplicates`. Re-run with `{"force":true}` to collapse existing dupes. Perceptual-hash dedup of re-encodes is a noted follow-up. |
| B7 | Wrong-match feedback (FR-15) | feature | **P2** | 🟢 not deployed | M4.4 | `api/src/routes/feedback.ts`, `web/` | Shipped 2026-06-16b. Immutable `match_feedback` docs keyed to `runId`; per-result "Not me / That's me" buttons + optimistic removal. Pairs with B3. Admin review queue still open. |
| B8 | Instant event-metadata push on creation | feature | **P1** | 🟢 not deployed | M1.4 | `gas-app/src/services/indexTriggerClient.ts`, `gas-app/src/routes/eventHandlers.ts`, `gas-app/src/routes/linkHandlers.ts` | Shipped 2026-06-16c. New `triggerMetadataSync(context)` POSTs `/api/admin/sync` (OIDC + existing `X-Sync-Token` machine path, same as `triggerEventIndex`); wired best-effort/non-fatal into `serverCreateEvent` (`'event_created'`) and `serverGenerateLink` (`'link_generated'`) so events/names reach Firestore in seconds, not up to a day. Daily `findme-drive-sync` reconciler stays as backstop. No api change needed — `POST /api/admin/sync` already exists and accepts `X-Sync-Token` (`allowCronOrAdmin`). NOT the abandoned per-photo `firestoreClient.ts` path. **Needs gas-app `clasp push`** + the `FINDME_API_URL`/`INDEX_TRIGGER_TOKEN` Script Properties (already set for the index trigger). |

**Sequencing (original plan, now fully executed in code).** B1+B2 shipped together first (the headline ask, mutually dependent); B4+B5 landed in parallel as cheap bug fixes; B3+B7 landed together; B8 (the last item) is now implemented alongside B5 as intended. **All of B1–B8 are code-complete (not deployed).** Remaining work is deploy + one re-run, in order:

1. **Deploy/push** — single api + web deploy, plus a gas-app `clasp push` for B8.
2. **B6 indexer re-run** on already-indexed events with `{"force":true}` (per `CLAUDE.md` indexer notes) to collapse existing duplicates and populate `contentHash`.
3. **Smoke-test B8** — create an event (and an upload link) in the gas-app and confirm the event + name appears in Firestore within seconds without waiting on the daily reconciler, and that a forced `/api/admin/sync` failure is swallowed (non-fatal).

> **⚠️ STATUS UPDATE (2026-06-16c) — §5A B8 shipped (code).** Closes the §5A backlog: every item B1–B8 is now code-complete. **B8** instant event-metadata push — new `triggerMetadataSync(context)` in `gas-app/src/services/indexTriggerClient.ts` POSTs `/api/admin/sync` over the existing OIDC + `X-Sync-Token` machine path, wired best-effort/non-fatal into `serverCreateEvent` and `serverGenerateLink`. No api change (the route already accepts `X-Sync-Token` via `allowCronOrAdmin`). 10 new unit tests (`tests/unit/indexTriggerClient.test.ts`) cover not-configured no-op, 200/202 success, non-2xx + thrown-exception swallowing, URL/header shape, and the existing `triggerEventIndex` path; gas-app typecheck clean; eventHandlers/linkHandlers tests green. Not yet deployed/`clasp push`ed; needs the `FINDME_API_URL`/`INDEX_TRIGGER_TOKEN` Script Properties (already set for the index trigger).

**Auto-push status (context for B8).** Photo indexing is already fully event-driven: a finished upload batch fires `triggerEventIndex` → `POST /api/events/:id/index`, with a 10-minute `findme-index-scan` backstop (`AUTOMATED_INDEXING_IMPLEMENTATION.md` / `AUTOMATED_INDEXING_RUNBOOK.md`). The only non-instant link in the GAS→cloud chain is **event/link creation**, which today waits on the daily reconciler — that is exactly what B8 closes.

**Test additions (extend §6).** Download: assert ZIP entries are original bytes and links die after TTL. Selection: reducer unit tests for all-three actions. FR-9b: result sets never merge across distinct uploads except the combined view. Dedup: indexing a folder with known duplicates yields one tile per unique content hash. Event name: indexed event exposes a non-empty `name`; UI fallback never emits "Untitled event". B8: creating an event/link in the gas-app issues a `POST /api/admin/sync` and the event appears in Firestore without waiting for the daily job; a failed sync call is swallowed (non-fatal) and the daily reconciler still backfills.

---

## 5B. Find Me results UX & save-to-phone backlog (2026-06-20)

Tickets from hands-on mobile use (iPhone Safari) of the deployed Find Me flow. Same priority scheme as §5A (**P0** ship next → **P2**). These slot into M4 (download/save) and M3 (frontend results); none add a milestone. Grouped into **three rounds** so they ship incrementally.

**Root-cause note — the "Too many requests … 24814s" banner is the DOWNLOAD limiter, not search.** Verified against the deployed service (2026-06-20): neither `FINDME_SEARCH_LIMIT/WINDOW` nor `DOWNLOAD_LIMIT_PER_DAY` is set on `event-photo-api`, so both run on **code defaults** (search = 20 / 60s; download = **50 / 86400s**, a 1-day window). The single-original endpoint `GET /events/:id/photos/:photoId/original` (powers "Save individually" / "Save to phone") carries `downloadRateLimit()`, so a single N-photo save fires **N separate GETs**, each counting against the daily 50. A 22-photo "save individually" burns 22; two attempts (~44) plus a couple ZIP tries exceed 50 → locked out ~6.9h (24814s left in the day window). A 24814s reset is *impossible* on the 60s search window — confirming it is the download bucket.

| # | Item | Type | Priority | Round | Files | Notes |
|---|---|---|---|---|---|---|
| C1 | Per-photo save shouldn't exhaust the daily download quota | **bug** | **P0** | 1 | `api/src/routes/download.ts`, `api/src/middleware/rateLimit.ts`, `api/src/lib/config.ts`, `web/src/pages/FindMe.tsx` | Root cause above. Options: (a) give single-original GETs their own, much higher bucket (e.g. `ORIGINAL_FETCH_LIMIT` ~ a few hundred/day) separate from bulk-ZIP; or (b) count one multi-photo save as one logical unit, not N; or (c) prefer the single-ZIP path (1 hit) on platforms where it works. Also format the reset (`24814s` → "~7 hours") and consider a much shorter window. |
| C2 | Explicitly set rate-limit env in deploy | config | **P0** | 1 | `infra/scripts/deploy-api.sh`, `api/.env.example` | Both limits are unset in prod (running on defaults). Decide intended values and set them explicitly so behaviour isn't an accident of the schema default. Pairs with C1. |
| C3 | One-tap "Save to Photos" on iPhone | feature | **P0** | 1 | `web/src/lib/share.ts`, `web/src/lib/downloads.ts`, `web/src/pages/FindMe.tsx`, `components/SelectBar.tsx` | **The headline ask.** A web app cannot silently write to the iOS photo library (OS sandbox) — true one-click is only possible from a native app or an iOS Shortcut. Closest is **Web Share L2 sharing the actual image `File` objects** → iOS sheet offers "Save N Images to Photos" (one tap in the sheet). Today `saveToPhone` shares a **ZIP** blob, which iOS can't expand into Photos — switch the "Save to phone" button to the `savePhotosIndividually` (image-files) path. Make **"Save to Photos" the primary CTA on mobile** and demote "Download ZIP" (ZIP is the worst case on iOS — lands in Files, can't unzip into Photos). Note the C1 interaction: the image-files path still fetches each original. |
| C4 | Tap-to-enlarge lightbox on results | feature | **P1** | 2 | `web/src/pages/FindMe.tsx`, new `components/Lightbox.tsx`, `api` original/large-derivative serving | **Cannot currently enlarge a result to verify "is this me."** Result tiles are select-only `<button className="result-thumb">` rendering only `thumbUrl`. Add a lightbox: larger/original derivative, swipe between results, with Select / Not me / That's me actions inside. Highest-value results fix; makes the existing B7 feedback usable. |
| C5 | Separate view-vs-select interaction | feature | **P1** | 2 | `web/src/pages/FindMe.tsx`, `styles.css` | One tap currently both selects and is the only affordance. Image tap = enlarge (C4); a corner checkbox = select. Stops accidental toggles. |
| C6 | Persist results across reload | feature | **P1** | 2 | `web/src/pages/FindMe.tsx`, `web/src/lib/results.ts` | Results live only in React state; a refresh (or the iOS download/share bounce) wipes the match set → forces a re-search → burns search/download limits. Cache the last result set (in-memory store / sessionStorage-equivalent per artifact rules in-app). |
| C7 | Score banding instead of bare % | feature | **P2** | 3 | `web/src/pages/FindMe.tsx`, `web/src/lib/results.ts` | A 51% and a 97% render as equally "matched." Band into Strong / Possible (keep the % as detail) so users focus verification. |
| C8 | Search loading state | feature | **P2** | 3 | `web/src/pages/FindMe.tsx`, `styles.css` | `phase === 'searching'` is just the text "Searching the event photos…". Add spinner/skeleton — matcher scales to zero (per `CLAUDE.md` cost policy) so first search has real cold-start latency. |
| C9 | Empty-selection guards + post-save confirmation | feature | **P2** | 3 | `web/src/pages/FindMe.tsx`, `components/SelectBar.tsx` | Disable Download/Save when nothing selected; confirm after success ("22 photos saved"). Fold the friendlier rate-limit copy here if not done in C1. |

**Status (2026-06-20a) — Round 1 (C1–C3) 🟢 code-complete, not deployed.**
- **C1** new `original_fetch` rate-limit bucket (`ORIGINAL_FETCH_LIMIT`, default 500/day) on `GET /events/:id/photos/:photoId/original`, split out from the bulk `download` bucket so a multi-photo save no longer drains the 50/day ZIP budget; 429 message humanized via `humanizeRetry()` ("about 7 hours", not "24814s"). Files: `api/src/middleware/rateLimit.ts`, `api/src/lib/config.ts`, `api/src/routes/download.ts`. New unit test in `api/test/rateLimit.test.ts`.
- **C2** `deploy-api.sh` now sets `FINDME_SEARCH_LIMIT=20`, `FINDME_SEARCH_WINDOW_SEC=60`, `DOWNLOAD_LIMIT_PER_DAY=50`, `ORIGINAL_FETCH_LIMIT=500` explicitly (override-able shell vars, merged via `--update-env-vars`); documented in `api/.env.example`.
- **C3** `FindMe.saveSelected` now fetches the selected originals and shares the actual image **files** (`savePhotosIndividually`) instead of a ZIP blob → iOS "Save N Images to Photos"; redundant ZIP-share + "Save individually" removed from Find Me. `SelectBar` makes "📲 Save N to Photos" the **primary** action when Web Share L2 is available and demotes "Download ZIP" to secondary; Gallery unchanged (still ZIP-primary + "Save individually"). Files: `web/src/pages/FindMe.tsx`, `web/src/components/SelectBar.tsx`.
- **Verification:** all three workspaces typecheck + lint clean; 117 api + 38 web unit tests green.
- **Remaining:** deploy api + web; on a real iPhone confirm the share sheet offers "Save N Images to Photos" and a 22-photo save no longer trips the limiter.

**Status (2026-06-20b) — Round 2 (C4–C6) 🟢 code-complete, not deployed.**
- **C4** new reusable `web/src/components/Lightbox.tsx`: full-size `webUrl` viewer with prev/next (on-screen arrows, ←/→ keys, touch swipe), an `n of N` counter, Esc/backdrop close, and a footer slot for per-photo actions. Wired into Find Me results.
- **C5** result tiles now separate **view** from **select**: tapping the photo opens the lightbox; a dedicated corner checkbox (`.select-box`) toggles selection. Select / Not me / That's me are also available inside the lightbox footer, so verify-and-decide happens in one place. Helper copy updated.
- **C6** new `web/src/lib/findmeCache.ts`: persists references/activeId/confirmed to `sessionStorage` keyed by eventId, restored on mount so a reload (or the iOS share/download bounce) no longer wipes matches and forces a re-search. TTL is 50 min (under the api's 60-min signed-URL cap) so restored thumbnails still load; dead `blob:` preview URLs are dropped on save (matches still restore, sans the tiny selfie thumb). Files: `web/src/pages/FindMe.tsx`, `web/src/styles.css`.
- **Verification:** web typecheck + lint clean; 44 web unit tests green (incl. 6 new `findmeCache` tests); production `vite build` succeeds (61 modules).
- **Remaining:** deploy web; on-device check of lightbox swipe/keys and that a reload restores the result set within the TTL.

**Status (2026-06-20c) — Round 3 (C7–C9) 🟢 code-complete, not deployed.**
- **C7** score banding: `scoreBand()` / `bandLabel()` + `STRONG_MATCH_THRESHOLD` (0.6) in `web/src/lib/results.ts`. The result chip now reads "Strong · 87%" / "Possible · 54%" (raw % kept as detail), colour-coded green/amber, on both the tile and the lightbox badge. Threshold is one tunable constant — retune against the eval harness.
- **C8** search loading state: the bare "Searching…" text is now a spinner + "the first search can take a few seconds to warm up" (the matcher scales to zero per the cost policy, so the first request cold-starts). `role="status"`; respects `prefers-reduced-motion`.
- **C9** post-action confirmation: a transient aria-live status line — "Downloaded N photos as a ZIP." / "Sent N photos to your share sheet — choose Save to Photos." (and a download-fallback variant); a cancelled share says nothing. SelectBar already disables the actions when nothing is selected and the handlers early-return on an empty selection, so the guard is belt-and-suspenders.
- **Verification:** web typecheck + lint clean; 46 web unit tests green (incl. new `scoreBand` tests); production `vite build` succeeds (61 modules).
- **Remaining:** deploy web. With Round 1–3 code-complete, the §5B backlog is closed pending a single api + web deploy and an on-device pass.

**Rounds.**

1. **P0 / unblock real attendees + the save ask.** C1 (stop per-photo saves from eating the daily quota) + C2 (set the limits explicitly) + C3 (one-tap Save to Photos via image-file share, make it the mobile primary). Ship together — C3's per-file fetch is exactly what C1 must protect. ✅ **code-complete 2026-06-20a.**
2. **P1 / core results UX.** C4 lightbox → C5 view-vs-select (depends on C4) → C6 persist results. ✅ **code-complete 2026-06-20b.**
3. **P2 / polish.** C7 score banding, C8 loading state, C9 guards + confirmation/copy. ✅ **code-complete 2026-06-20c.**

**One-click Save-to-Photos — what's actually achievable (C3).** Ranked by how close to "one click":

- **Web Share L2 with image files (recommended):** button → native sheet → "Save N Images to Photos." ~2 taps, no extra install, works in iOS Safari. This is the realistic best.
- **iOS Shortcut / native wrapper:** the only way to get truly silent one-tap save, but requires the user to install something — out of scope for the web app.
- **ZIP (current default):** worst on iOS — `.zip` to Files, no path into Photos. Demote, don't remove (still useful on desktop).

**Test additions (extend §6).** C1: an N-photo individual save consumes at most one (or a bounded count) of the download bucket, not N; reset message formats seconds to a human duration. C3: `saveToPhone`/save-to-Photos shares image `File`s (not a ZIP) when Web Share L2 is available, and falls back to per-file download otherwise. C4: lightbox opens the larger derivative and exposes Select/Not me/That's me without toggling selection on open. C6: a reload after a search restores the prior result set without re-hitting the matcher.

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
