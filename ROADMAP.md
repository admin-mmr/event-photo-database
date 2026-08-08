# ROADMAP.md — the one live list of outstanding work

**Updated 2026-08-06.** This file replaces `GAS_MIGRATION_DEV_PLAN.md` §4A as the
single consolidated roadmap. Every line below was checked against the running
system (Cloud Run services + schedulers, deployed env vars, the code) rather than
copied from a plan's own status banner — several plans still claim work is
"pending deploy" that shipped weeks ago.

**How to use it:** this file says *what is left and who owns it*. The owning plan
says *how*. `CLAUDE.md` holds the invariants you must not break while doing it —
read it first, it is the only doc that is authoritative about production
behaviour.

---

## Where things stand

| Plane | State |
|---|---|
| **Control plane** (users, clubs, events, links, email, audit, duplicates, reporting, partner API) | **Delivered.** G0–G6 built in `cloud-webapp/`; gas-app writes frozen 2026-07-18 and cloud-webapp has been the single writer since. All six Cloud Scheduler jobs are `ENABLED`. |
| **Photo plane** (volunteer upload → Drive → indexer → gallery) | **Live.** Async Cloud Tasks upload queue, managed folders (`MANAGED_FOLDERS_ENABLED=true` in prod), capture-time sort, duplicate-file removal queue, event deletion, upload recovery. |
| **Find-Me** (face + outfit search) | **Live**, and the active workstream is *quality*, not features. T-norm on by default (threshold z≥4.0); anchor promotion, per-face quality metadata and the pick-time selfie check all shipped. |
| **Video → running stills** | **Research + Phase 0 harness only.** The go/no-go gate is undecided because the frames were never judged. |
| **Azure** | **Dormant.** Strategy decision D1 (adapters inside `cloud-webapp/`) has not been executed, and the `azure-webapp/` fork holds a rotted copy of the app source. |
| **gas-app** | Deprecated, frozen, still in the tree. Phase E retirement steps are not done. |

---

## 1. Find-Me match quality — one measurement blocks most of it

Owner: [PEOPLE_RECOGNITION_QUALITY_PLAN.md](PEOPLE_RECOGNITION_QUALITY_PLAN.md)
(per-item status banners are maintained there) · latest session detail:
[FINDME_SELFIE_QUALITY_HANDOFF.md](FINDME_SELFIE_QUALITY_HANDOFF.md).

**1.1 The blocking decision: re-index the 8 stale events.**
`audit-person-crops.sh` exits 1 — 8 of 10 indexed events have person ("outfit")
embeddings built from face-box expansion while the matcher now queries with the
real YOLOv8 detector, so the outfit half of every fused search on those events
compares mismatched geometry. Nightly runs will never fix it: the version tag
lied, so the md5+version reuse check hits. Only `FORCE_REINDEX=1` per event does,
and outfit-tagger events must then be re-prepared (they key on
`sourceModelVersion`). Cost is a full re-embed of ~9,500 photos.

**1.2 Then the judged sweep**, which gates three knobs at once:

```bash
python cloud-webapp/matcher/eval/run_eval.py --judged-only --tnorm --anchor-promotion --face-quality-weight '0.25;0.5;1.0'
```

Run it on `81a584f7` (91 users / 1,516 pairs) and `34f3e38f`. It decides
`FACE_QUALITY_WEIGHT` (Item 5, currently **0.0** = off), the anchor-promotion UI
defaults (Item 11), and per-event thresholds (Item 8).

**1.3 Provisional constants waiting on that sweep** — all flagged in code, none
backed by data: `WEAK_SELFIE_SCORE = 0.65` (`shared/schemas/findme.ts`),
`REJECTS_BEFORE_HELP = 3` (`web/pages/FindMe.tsx`), `FACE_QUALITY_WEIGHT = 0.0`,
and `FUSION_TIME_CONDITIONAL` (Item 1 — implemented, swept, *inconclusive*; needs
real upload-time EXIF anchors and a same-day multi-outfit event before more spend).

**1.4 Not started** (quality plan Items): 4 SAHI tiled detection · 6 bib signal ·
7 AdaFace A/B · 8 per-event thresholds · 9 identity clustering + cluster-confirm
HITL · 10 GEFF appearance gallery.

**1.5 Loose ends from the selfie work:** single-page result sets never hit the
page-turn judging checkpoint (no page turn to intercept — a "leaving results"
trigger is a deliberate separate decision); the
`infra/monitoring/selfie-stuck-alert-policy.json` policy is written but not
applied, so `selfie_stuck` still routes with general crash alerts.

---

## 2. Video → running stills — the Phase 0 gate is undecided

Owners: [VIDEO_FRAME_EXTRACTION_DEV_PLAN.md](VIDEO_FRAME_EXTRACTION_DEV_PLAN.md)
(research + Phases 1–4), [VIDEO_FRAME_EXTRACTION_PHASE0.md](VIDEO_FRAME_EXTRACTION_PHASE0.md)
(what the harness measured), [HUMAN_REVIEW_LOOP_PLAN.md](HUMAN_REVIEW_LOOP_PLAN.md)
(how to get more than one judge).

The harness is built and run on 10 real clips; nothing is wired into the
pipeline. What is missing is **judgments** — "would a volunteer publish this
still?" — and one person at a laptop is the weakest part of the evidence. The
member review-link design is proposed and **nothing is built**. Decide judging
first; Phases 1–4 stay blocked until the gate passes.

---

## 3. Ops backlog

| Item | Where | Note |
|---|---|---|
| **Stranded-derivative backlog** | `infra/scripts/sweep-stranded-derivatives.sh` | Measured 2026-08-05: 3,663 objects / 7.44 GiB across two events, all byte-identical duplicates that lost canonical status. The indexer sweeps *new* departures now (#71) but nothing will ever look at the backlog. Re-run the dry run, then `--apply`. |
| **Billing export not enabled** | GCP billing → BigQuery | No cost question is answerable from the CLI until this exists. `billing-analysis/GCP_COST_REPORT_2026.md` is the last hand-built snapshot. |
| **image-convert service is not deployed** | `cloud-run/` + `api/src/services/imageConvertClient.ts` | Only `event-photo-api`, `matcher` and `outfit-tagger` run. So non-JPEG managed-folder entries always take the shortcut fallback. Decide: deploy it, or delete the client and the `cloud-run/` tree. |
| **Indexer incremental checkpointing** | `indexer/job.py` | The store + manifest are written only at the END of a run, so a killed run makes zero progress. The largest event measures **55.6 min** (6,914 photos, 8 vCPU); this is the one structural gap left in the indexer, and it is also **the cleanest way out of the Azure blocker in §5.1** — worth doing on GCP either way. |
| **Email templates are EN-only** | `api/src/services/emailTemplates.ts` | The web app is fully bilingual (EN · 中文); the transactional + digest emails are not. |
| **Minor/guardian attestation wording** | `routes/findme.ts`, `FindMe.tsx` | Gate is enforced server-side; the wording is still pending legal review (PRD D8 / M5.6). Not an engineering task. |
| **Persistent selfie enrollment (PRD D7)** | — | Never built. Reusing a *past upload* covers most of the convenience; a persistent `face_enrollments` store does not exist. Decide whether D7 is still wanted before building it. |

---

## 4. Cutover Phase E — the leftovers

Owner: [CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md) (Phases A–D are signed off).

- **`gas-app-final` tag was never pushed** — the repo has no tags at all. Tag the
  last gas-app deploy before the tree moves or gets deleted.
- **gas-app is still in the tree**, read-only. Move it under `archive/` or drop
  it once nobody needs the reference.
- **Superseded, do not execute:** Phase E's "stop building `Photos_NNN` / `Videos`
  / `Album`" and "retire the public-index Sheet". Managed folders were
  *deliberately* migrated into cloud-webapp and are enabled in production
  (`MANAGED_FOLDERS_ENABLED=true`, `PUBLIC_FOLDER_INDEX_SHEET_ID` set,
  `findme-folder-rebuild` draining). See
  [cloud-webapp/MANAGED_FOLDERS_MIGRATION_PLAN.md](cloud-webapp/MANAGED_FOLDERS_MIGRATION_PLAN.md).

---

## 5. Azure — decide before doing

Owner: [AZURE_MIGRATION_DEV_PLAN.md](AZURE_MIGRATION_DEV_PLAN.md) (audit +
phased plan; decision **D1** = build cloud-neutral adapters inside
`cloud-webapp/` rather than maintain the fork).

Nothing has been run against a real subscription. The `azure-webapp/` fork was
~90 commits stale at the 2026-07-28 re-audit and has only drifted further, so its
app source is a liability, not an asset — D1 exists precisely to stop maintaining
it. Before any Azure work: confirm the move is still wanted, then execute D1
(adapters + `azure-webapp/` reduced to `infra/` + docs).

### 5.0 If Azure is the target, converge with `trailhead` — but do NOT merge the repos

`github.com/admin-mmr/trailhead` (local: `../trailhead`) is MMR's Azure platform
and it already owns half of what the photo-alert feature needs. Reviewed
2026-08-06.

**The overlap is real and one side should stop.** `trailhead/photo-manager/`
(Python, cv2/dlib) does bib OCR, Azure-Face detection + face crops, and photo
quality picking against Drive, and its `round2-plan.md` **Q3** proposes applying
to Microsoft for **Limited Access to Face API `PersonGroup` Identify** to get 1:N
matching. This repo already does 1:N in production — self-hosted SCRFD + ArcFace
+ YOLOv8, no vendor approval, no per-call fee, with judged P@20 measured (0.824 /
0.684). **Recommendation: drop Q3 Phase B; the matcher is the answer.** Its Q1
(Drive stays SSOT, Blob holds only processed artifacts) is the architecture this
repo already runs, so there is nothing to reconcile there.

**What flows the other way** — trailhead has three things this repo lacks:

- Bib OCR + the MySQL roster = exactly the "roster-matched" half of quality-plan
  **Item 6 (bib signal)**, which is unstarted here. `photo-manager/` was deleted
  from trailhead on 2026-08-08 (branch `claude/remove-photo-manager`); the useful
  part survives at `git show e6f2583:photo-manager/src/modules/bib_ocr.py` — 310
  lines, EasyOCR on torso crops with a prominence score to elect the primary bib,
  and it consumes person boxes, which this repo's indexer already produces. It is
  **MIT**, so porting it into this AGPL repo is fine as long as the MIT notice
  travels with it.
- `members` (unique `Email`, `WeChatID`) — the member identity the alert feature
  needs and this repo has no equivalent of.
- `notification_log` ("dedupe_key makes scheduled jobs idempotent") plus a typed
  `EMAIL_TYPES` registry that fails CI when a type has no template. That is the
  right substrate for "you appear in new photos" mail, already built.

So the alert feature is: trailhead's member record + its
`member-photo-instructions.md` collection design (4–6 photos, different outfits —
i.e. PRD **D7 enrollment**, never built here) → embeddings from this repo's
matcher → a post-run hook on the indexer → one idempotent `notification_log` mail
carrying a short-lived signed link. **Consent is not automatic:** PRD D4/D8/D9
scoped 90/30-day retention for *reference uploads*; persistent enrollment is a
different policy and needs its own opt-in + delete path before any member face is
stored indefinitely.

**Why not one repo: the licenses are incompatible in the direction that matters.**
trailhead is **MIT**; this repo is **AGPL-3.0**, relicensed precisely because the
bundled Ultralytics YOLOv8 detector is AGPL. One tree makes the combined work
AGPL, and AGPL **§13 attaches a source-disclosure duty to a public network
service** — which would then include MMR's membership and payment portal and its
member PII. Keep the AGPL boundary at the ML services (matcher + indexer) and
integrate over HTTP. If a single tree is ever genuinely wanted, swap YOLOv8 for an
Apache-2.0 detector *first* (YOLOX / RTMDet / RT-DETR — note `models/person.py`
implements only the YOLOv8 output layout, so it needs a new decode path). The
working agreements also differ sharply (npm workspaces + gcloud + keyless DWD here
vs MySQL-migration CI + macOS-Keychain secrets + Python 3.9/Flask there).

**Resource reuse, given "no new resource groups":**

- Deploy into the existing **`mmr-resources`** RG. Reuse **`mmrunnersstorage`**
  with new containers — do not create a storage account.
- **Database — verified 2026-08-08 via `az`, and the region decides it.**
  `mmr-mysql-v4` is a **Flexible Server, MySQL 8.4, Standard_B1ms (Burstable,
  1 vCore / 2 GiB), 20 GB, in Sweden Central**. (trailhead's `CLAUDE.md` still
  warns about MySQL **5.7** `ALTER` quirks — stale; 8.4 has `IF NOT EXISTS`.)
  No Cosmos account exists in the subscription, so the **free-tier slot is
  unclaimed**. Cost is not the deciding factor: reusing MySQL is ~$0 marginal
  (photo rows are ~1 KB; even 1M photos ≈ 1 GB ≈ $0.12/mo) and Cosmos free tier
  is $0 outright. Decide on these two instead:
  - **Blast radius.** A 1-vCore burstable server currently carries membership and
    payments. An index run upserting ~6,900 rows plus event-day gallery reads can
    exhaust burst credits and degrade the member portal. Batch the writes, or move
    to B2s (~$25/mo, well inside the grant).
  - **Region.** Photo compute in the US writing per-photo rows to Sweden is the
    one combination to avoid — it lands straight on §5.1's wall-clock margin. So:
    **either** migrate MySQL to East US (dump/restore into a new server; a server's
    region cannot be changed in place) and reuse it for everything, **or** leave it
    in Sweden and put photo metadata in the free Cosmos slot in East US, with the
    alert job doing the cross-store join. Reusing MySQL removes D5, D8 and
    `cosmos-indexes.json` from the plan and replaces them with a MySQL adapter
    behind the `lib/db` port that already exists.
- **Email: not ACS.** The `mmr-comm` / `mmr` Communication Services resources are
  provisioned but unused — trailhead's mail actually routes through a GAS webhook
  (`lib/email/client.ts`) and this repo's through the Gmail API over DWD. Both are
  cloud-neutral (GAS plan §5); converge there and reuse `notification_log` rather
  than adding a provider.
- **The footprint is split three ways** (verified 2026-08-08): `mmrunnersstorage`
  in **East US**; the Static Web App in **East US 2**; `mmr-mysql-v4`, the App
  Service (`mmr-nyrr-viewer`), App Insights and the Log Analytics workspace all in
  **Sweden Central**. For a US org that is backwards — the storage account is the
  high-bandwidth path for photos, so new photo compute belongs in **East US** with
  it. Whether the Sweden resources follow is trailhead's call and needs a
  maintenance window; a Log Analytics workspace already exists, so Container Apps
  needs no new one.
- **Blob safety:** that account already holds member profile photos and payment
  screenshots. Keep "allow blob public access" **off** and stay SAS-only. Note
  **Blob CORS is per-account per-service, not per-container**, so the derivatives
  CORS rule applies account-wide; those other containers must remain SAS-gated on
  their own merits (CORS grants no access by itself — don't rely on container
  scoping for either).

**Resolved 2026-08-08:** the stale March-2026 v1.0 GAS-era plan for *this* system
that lived at `trailhead/photo-manager/partner/湘舍动公益文件系统/` went with the
directory.

### 5.1 Settle first — the indexer does not fit the Consumption plan

**This blocks AZ0. Settle it on paper before provisioning anything, not after the
first large event dies.**

GCP runs the indexer at **8 vCPU / 12 GiB with `INDEX_CONCURRENCY=8`**
(`cloud-webapp/infra/scripts/deploy-indexer.sh`).
`azure-webapp/infra/scripts/deploy-indexer.sh` asks for **4 vCPU / 8 GiB** — the
Container Apps *Consumption* ceiling — while still passing
`INDEX_CONCURRENCY=8`, with `--replica-timeout 7200` (2 h) and
`--replica-retry-limit 1`. That is half the CPU at a memory level we already know
OOMs: 12 GiB ÷ 8 workers ≈ 1.5 GiB per in-flight photo, and `CLAUDE.md` records
that 8 GiB needs `INDEX_CONCURRENCY≈4`. So the script as written will OOM.

**The fix is not just the concurrency number — the timeout is the real teeth.**
Measured 2026-08-06: the 6,914-photo event (`5ff5ff5c`, execution
`photo-indexer-swzrk`, 2026-08-02) took **55.6 minutes** at 8 vCPU / concurrency 8.
Halving the CPU roughly doubles that, so the *same* event lands near **110 min
against the 2 h replica timeout — about 8% headroom, today, on today's largest
event.** And because the store and manifest are written only at the END of a run
(§3, incremental checkpointing), crossing that ceiling yields **zero progress**,
and `--replica-retry-limit 1` retries the whole run into the same wall.

**Money is not the constraint here; wall-clock is.** The work is constant, so
vCPU-seconds barely move, and 8 GiB × 2× runtime ≈ 12 GiB × 1× runtime in
GiB-seconds. Do not let a cost argument decide this one.

Three ways out, best first:

1. **Land incremental checkpointing first** (§3). It converts a timeout from
   "zero progress, forever" into "resume", which defuses the whole question and is
   worth doing on GCP regardless.
2. **`INDEX_CONCURRENCY=4` at 4 vCPU / 8 GiB** — a previously proven GCP pairing,
   not a guess — *and* raise `--replica-timeout` well past 2 h (verify the
   Consumption plan's actual ceiling; don't assume 7200 is the max).
3. **A dedicated workload profile** to get 8 vCPU / 12 GiB. It bills per allocated
   node rather than per request, so re-check it against the zero-idle-cost policy
   before choosing this.

**Sizing + quota facts, measured 2026-08-06** (so the decision is not made on
guesses):

- **There is no "project" in Azure.** Tenant → *subscription* (where the
  nonprofit grant lands) → *resource group* → resources.
  `azure-webapp/infra/scripts/bootstrap-azure.sh` creates resource group
  `mmr-photos-rg` in `eastus` inside whatever subscription `az account` points
  at. Nothing to create in the portal. The live footprint (2026-08-06) is one
  subscription with `mmr-resources` holding the Static Web App, an App Service,
  `mmr-mysql-v4`, `mmrunnersstorage` and the unused Communication Services — reuse
  it per §5.0. The Cosmos free-tier slot (D5, one per subscription) only matters
  if you pick Cosmos over the existing MySQL.
- **Drive quota does not change with the cloud.** Every Drive call is
  impersonated as the same DWD subject, so it draws on **one Workspace user's**
  quota (`driveRateLimit.ts`), and the API quota belongs to the *GCP project of
  the credential*, not to where the container runs. Our own pacing gate
  (`DRIVE_MIN_INTERVAL_MS=120` ≈ 8 req/s) is far below either limit and is the
  real constraint. What does change is the network path: Google→Azure crosses the
  public internet, so expect somewhat lower per-object throughput than the
  measured 6 MB/s in-GCP figure (`uploadRecoveryService` `THROUGHPUT_BYTES_PER_SEC`)
  and re-measure it before trusting the chunk-cost estimator on Azure.
- **Vector + manifest footprint ≈ 23–25 KB per photo.** Event `5ff5ff5c`
  (6,914 photos): `faces.npy` 65.6 MB + `persons.npy` 78.4 MB +
  `manifest.json` 18.1 MB = **154.6 MiB**. Event `81a584f7` (3,408 photos):
  84.8 MiB. Outfit-tagger adds ~16 MB per small event. So 100k photos ≈ 2.5 GB —
  irrelevant next to the derivatives bucket, where `orig/` alone is ~109 GiB.
- **Indexer wall-clock: 55.6 min for 6,914 photos** at 8 vCPU / 12 GiB /
  concurrency 8. This is the number §5.1 turns on; incremental runs with no
  changed photos are 1–3 min, so don't size the job off those.
- **Metadata is tiny either way.** Photo docs are ~1 KB, so today's ~9.5k photos
  are ~10 MB — nothing for MySQL, and far inside Cosmos free tier's 25 GB. *If*
  Cosmos is chosen anyway, the 1,000 RU/s ceiling is the constraint, not the size:
  size the gallery's paged queries against it (D8 keyset paging + the composite
  indexes `cosmos-indexes.json` still owes).

---

## Doc map

**Live plans — work is still open in these**

| Doc | Scope |
|---|---|
| [PEOPLE_RECOGNITION_QUALITY_PLAN.md](PEOPLE_RECOGNITION_QUALITY_PLAN.md) | Find-Me quality, Items 1–12, with per-item status |
| [FINDME_SELFIE_QUALITY_HANDOFF.md](FINDME_SELFIE_QUALITY_HANDOFF.md) | Newest session state, provisional constants, process traps |
| [VIDEO_FRAME_EXTRACTION_DEV_PLAN.md](VIDEO_FRAME_EXTRACTION_DEV_PLAN.md) · [VIDEO_FRAME_EXTRACTION_PHASE0.md](VIDEO_FRAME_EXTRACTION_PHASE0.md) | Video → stills research, harness, measurements |
| [HUMAN_REVIEW_LOOP_PLAN.md](HUMAN_REVIEW_LOOP_PLAN.md) | Member review links (proposed, unbuilt) |
| [AZURE_MIGRATION_DEV_PLAN.md](AZURE_MIGRATION_DEV_PLAN.md) | Azure audit + phases (dormant) |
| [EVAL_FEEDBACK_LOOP.md](EVAL_FEEDBACK_LOOP.md) | How feedback becomes labels; judged-precision semantics + evidence bar |

**Runbooks / ops — read when doing that thing**

`CLAUDE.md` (invariants — read first) ·
[CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md) ·
[AUTOMATED_INDEXING_RUNBOOK.md](AUTOMATED_INDEXING_RUNBOOK.md) ·
[FACE_MATCHING_SETUP_RUNBOOK.md](FACE_MATCHING_SETUP_RUNBOOK.md) ·
[SETUP_NOTES.md](SETUP_NOTES.md) ·
[cloud-webapp/UPLOAD_WORKER_RUNBOOK.md](cloud-webapp/UPLOAD_WORKER_RUNBOOK.md) ·
[cloud-webapp/docs/FINDME_RUNBOOK.md](cloud-webapp/docs/FINDME_RUNBOOK.md) ·
[cloud-webapp/docs/DEPLOYMENT.md](cloud-webapp/docs/DEPLOYMENT.md) ·
[cloud-webapp/docs/DEVELOPMENT.md](cloud-webapp/docs/DEVELOPMENT.md) ·
[cloud-webapp/README.md](cloud-webapp/README.md) ·
[cloud-webapp/ARCHITECTURE.md](cloud-webapp/ARCHITECTURE.md)

**Delivered — kept for the reasoning, not for the status**

[FACE_MATCHING_FEATURE_PRD.md](FACE_MATCHING_FEATURE_PRD.md) (consent, retention,
minors — still policy) · [FACE_MATCHING_DEV_PLAN.md](FACE_MATCHING_DEV_PLAN.md) ·
[GAS_MIGRATION_DEV_PLAN.md](GAS_MIGRATION_DEV_PLAN.md) ·
[AUTOMATED_INDEXING_IMPLEMENTATION.md](AUTOMATED_INDEXING_IMPLEMENTATION.md) ·
[CAPTURE_TIME_SORT_DESIGN.md](CAPTURE_TIME_SORT_DESIGN.md) ·
[FACE_RECOGNITION_IMPROVEMENT_ANALYSIS.md](FACE_RECOGNITION_IMPROVEMENT_ANALYSIS.md)
(background for the quality plan) ·
[cloud-webapp/MANAGED_FOLDERS_MIGRATION_PLAN.md](cloud-webapp/MANAGED_FOLDERS_MIGRATION_PLAN.md) ·
[cloud-webapp/UPLOAD_ASYNC_QUEUE_DESIGN.md](cloud-webapp/UPLOAD_ASYNC_QUEUE_DESIGN.md) ·
[cloud-webapp/WEB_UI_REFRESH_DEV_PLAN.md](cloud-webapp/WEB_UI_REFRESH_DEV_PLAN.md) ·
[DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) ·
[STORAGE_AND_DATABASE_OPTIONS.md](STORAGE_AND_DATABASE_OPTIONS.md) ·
[UX_AND_GCP_ASSESSMENT.md](UX_AND_GCP_ASSESSMENT.md) ·
[PUBLIC_SHARING.md](PUBLIC_SHARING.md) · [EMAIL_SERVICE.md](EMAIL_SERVICE.md)

**Deleted in this pass** (spent session artifacts — recover from git history if
ever needed): `AUTOMATED_INDEXING_HANDOFF.md`, `FACE_MATCHING_HANDOFF.md`,
`FINDME_DEPLOY_CHECKLIST.md`, `cloud-webapp/WEB_UI_REFRESH_HANDOFF.md`,
`cloud-webapp/MANAGED_FOLDERS_CUTOVER.md`, `cloud-webapp/DEMO_READINESS_{PROMPT,REPORT}.md`,
`cloud-webapp/docs/{DEMO_CHECKLIST,SYNC_RECONCILER_HANDOFF,FINDME_GAS_DEPENDENCY_RUNBOOK}.md`,
and the five stale `azure-webapp/` copies of the same.
