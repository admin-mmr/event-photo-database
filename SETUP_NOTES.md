# Find Me — Setup Values & Progress

**Project:** mmr-data-pipeline (489676654863) · **Updated:** 2026-06-10 (Phases F–H complete; I in progress)

## URLs & daily workflow

- **Live site:** https://mmr-data-pipeline.web.app (custom domain `photos.mmrunners.org` not yet wired — Firebase Console → Hosting → Add custom domain + DNS)
- **API direct:** https://event-photo-api-emi5arbbea-uc.a.run.app (auth required for direct access; public via Hosting rewrite)
- **Local dev:** `cd cloud-webapp && npm run dev` → http://localhost:5173 (vite, hot reload; proxies `/api/*` to the api on :8080)
- **Deploys:** automatic on `git push` to main (paths-filtered: `web/**` → hosting, `api/**` → Cloud Run). Manual redeploy: `gh workflow run deploy-web.yml --ref main`; watch with `gh run watch` or the Actions tab.

## GitHub Actions configuration (Phase I)

Paste into GitHub repo `admin-mmr/event-photo-database` → Settings → Secrets and variables → Actions:

```
GCP_PROJECT_ID      = mmr-data-pipeline
GCP_REGION          = us-central1
GCP_SERVICE_ACCOUNT = cloud-webapp-deployer@mmr-data-pipeline.iam.gserviceaccount.com
GCP_WORKLOAD_IDP    = projects/489676654863/locations/global/workloadIdentityPools/github-actions/providers/github
```

## Runbook progress (FACE_MATCHING_SETUP_RUNBOOK.md)

- [x] **D1** Firebase added to project (`firebase projects:addfirebase` — required accepting Firebase ToS in console first; CLI 403s until then)
- [x] **D2** Firebase Authentication enabled (Google sign-in)
- [x] **D3** `cloud-webapp/infra/firebase.json` + `.firebaserc` → mmr-data-pipeline
- [x] **D4** Web app `event-photo-web` registered, SDK config captured
- [x] **E1** bootstrap-gcp.sh complete — verified: deployer SA active, Firestore NATIVE, Artifact Registry repo, WIF pool ACTIVE
- [x] **E2** Runtime SAs created via `infra/scripts/provision-runtime-sas.sh` (verified 2026-06-09)
- [x] **F** Buckets + Pub/Sub topics (verified) — **Cloud SQL SKIPPED** (zero-cost decision, see below)
- [x] **G1** Drive access via **domain-wide delegation** (2026-06-10): `indexer-runtime` SA, DWD client ID `106562625333715022810`, scope `https://www.googleapis.com/auth/drive`, Admin console entry shows as "MMR WebApp" (name comes from the project's OAuth consent screen). Drive API enabled. Verified read (event folder) + write (`_find_me_uploads`) with `cloud-webapp/infra/scripts/verify-g1-dwd.sh`. DWD calls must impersonate a Workspace user (`sub=admin@mmrunners.org`); keyless via IAM `signJwt` — needs `roles/iam.serviceAccountTokenCreator`.
- [x] **G2** `CONSENT_POLICY_VERSION` secret = `v1-2026-06`
- [x] **G3** reCAPTCHA key `6Ld_cxgtAAAAAGJ2nH2TvvFhP745x41RqPPHki6r` → `RECAPTCHA_KEY` secret (v2; v1 was a paste error, destroyed). Still to do: put key id in SPA config.
- [x] **H1** API deployed 2026-06-10: revision `event-photo-api-00002-wdt`, `https://event-photo-api-emi5arbbea-uc.a.run.app`, `/api/health` OK (`v0.1.0`, commit `1db13d0`)
- [x] **H2** Hosting live 2026-06-10: `https://mmr-data-pipeline.web.app`, `/api/health` OK through the rewrite. Required `allUsers` invoker on `event-photo-api` (Hosting rewrites are anonymous): temporary project-level DRS override → `add-iam-policy-binding --member=allUsers --role=roles/run.invoker` → override deleted (binding persists). ⚠️ API is now publicly invokable — protected routes must verify Firebase ID tokens.
- [x] **I** GitHub Actions working end-to-end (2026-06-10): 4 WIF values as **repository secrets** (not variables — workflows use `${{ secrets.… }}`); workflows at repo-root `.github/workflows/`; CI deployed commit `4a81145` to Cloud Run + Hosting, verified live. Push to main = auto-deploy.
- [ ] **J** Budget alert ($10) + max-instances caps — **script ready** (2026-06-11): run `cloud-webapp/infra/scripts/provision-budget-guardrails.sh` (needs billing-account perms; idempotent). Api already capped at 10 via deploy-api.sh.

## Dev progress (FACE_MATCHING_DEV_PLAN.md)

- **2026-06-15 — "Sync with Drive" reconciler (dev plan §8) + indexer deployed.** Cloud-side pull reconciler: `sheetsService.ts` (keyless DWD Sheets read), `reconcileService.ts` (Events + Upload_Links tabs → `events` upsert with derived per-event `tags`; **report-only** merge policy — preserves `indexState`/`visibility`, never deletes, idempotent), `POST /api/admin/sync` (Firebase admin **or** `X-Sync-Token` cron header), `provision-sync-scheduler.sh` (daily Cloud Scheduler), shared `sync.ts` schema + `tags` on `EventSummary`, new config (`MASTER_SPREADSHEET_ID`/`SYNC_TRIGGER_TOKEN`). Indexer Job deployed: `deploy-indexer.sh` rewritten to the matcher's in-cloud GCS model-staging pattern + repo-root `.gcloudignore`; **fixed `indexer/Dockerfile` to use a plain `COPY model_files/`** — the old `model_file[s]` glob fails on Cloud Build's legacy builder (same fix matcher already had). First real index run: **Women mini 10k** (`d2307147-…`, folder `1uFoWUozAcsYewq6kdhrErru0hWMIbbix`). Removed orphan `gas-app/src/services/firestoreClient.ts` (abandoned GAS-push path, superseded by this pull reconciler). 41 vitest green. **Human steps to make the Sync button live + remaining IAM:** see `cloud-webapp/docs/SYNC_RECONCILER_HANDOFF.md`.

- **2026-06-12 — Demo fast-path code complete (M2 + minimal M3).** Goal: stakeholder demo ~June 18–19. API: `matcherClient.ts` (keyless ID-token call to the private matcher, upstream error strings preserved), `gcsService.ts` (V4 signed URLs ≤60 min into the derivatives bucket), `POST /api/findme/search` (multipart; consent gate → `consents` doc with policy version; persists minimal `match_runs` for the feedback loop), `GET /api/events/:id/photos` (gallery listing). Web: Firebase Auth (Google popup; config via Hosting's `/__/firebase/init.json` — nothing in the repo; Vite proxies `/__` to the live site for local dev), Events → Gallery (signed-thumb grid + lightbox) → Find Me (consent checkbox → selfie upload → ranked results with score chips). New `deploy-matcher.sh`; `MATCHER_URL` flows into the api via GitHub repo **variable** (deploy-api.yml `--set-env-vars` replaces all env vars, so manual `services update` would be wiped). 28 vitest green. **Human steps to demo:** `cloud-webapp/docs/DEMO_CHECKLIST.md` (~half a day: models → deploy matcher+indexer → 2 IAM bindings → index one event → smoke test). Demo-scope deferrals: ZH i18n, enrollment, guardian path, rate limit/reCAPTCHA, feedback UI.

- **2026-06-11 — M0 decisions recorded; eval scope relaxed.** Task 0.4 = keyless DWD (see G1), task 0.5 = flat-file GCS store (see 2026-06-09 decision) — now also recorded in the dev plan banner. Task 0.3 relaxed: M0 go/no-go judged on **2 labeled people** on `ev_sample` (alice/bob, `eval/labels.csv` + reference selfies in `eval/queries/`); exhaustive labeling deferred to the **beta feedback loop** — design in `EVAL_FEEDBACK_LOOP.md` (judged precision from `match_feedback`; export script + `--judged-only` eval flag land with M4 task 4.4). New tooling: `matcher/eval/make_review_page.py` (visual top-K review + label bootstrapping, with lightbox); `run_eval.py` now errors on empty queries, warns on missing references, and emits per-query retrieved lists in report.json.
- **2026-06-11 — M1 code complete** (tasks 1.2–1.5; 1.1 was done as setup Phases E–F): `cloud-webapp/indexer/` Cloud Run Job (`job.py` — Drive→GCS mirror of orig/web/thumb derivatives, embed via matcher pipeline, flat-file store write, Firestore `photos` + `events.indexState`; idempotent via manifest md5 diff, `model_version` bump → full re-embed, Drive deletions pruned; 10 pytest green, added to CI). API: `driveService.ts` (keyless DWD Drive reads), `GET /api/events` + `POST /api/events/:id/index` (admin allowlist via `ADMIN_EMAILS`), `triggerIndexJob` calls the Cloud Run Jobs API directly — **deviation from plan:** no Pub/Sub hop (flat-file store made per-photo fanout moot; topic stays for the M2+ change scan). Shared `event.ts` zod schemas. 13 vitest green. **Human steps for M1 DoD:** grant api-runtime→indexer-runtime `tokenCreator` + `run.invoker` on the job, self-`tokenCreator` for indexer-runtime (commands in `deploy-indexer.sh` header), build models into image, `deploy-indexer.sh`, set `driveFolderId` on one real event, trigger, reconcile counts vs Drive.
- **2026-06-11 — M0 code complete** (`cloud-webapp/matcher/`): SCRFD+ArcFace face pipeline, OSNet outfit pipeline (YOLO person detector optional, falls back to face-box expansion), flat-file GCS/local embedding store + in-memory cosine search, score/RRF fusion, quality gates, `/embed` + `/search` Flask endpoints, `scripts/embed_folder.py` (sample indexer), `eval/run_eval.py` (P@20 harness). 31 pytest tests green (fake models; real-model tests gated on `MODEL_DIR`); matcher job added to `ci.yml`. **Human steps remaining for M0 DoD:** fetch models (OSNet needs a one-time ONNX export — see `scripts/fetch_models.py`), embed ~500 real event photos, hand-label ~10 attendees, run the eval → go/no-go at P@20 ≥ 0.8. See `cloud-webapp/matcher/README.md` quickstart. M0 tasks 0.4 (DWD) + 0.5 (flat-file store) were already decided during setup.

## Decision (2026-06-09): zero-cost architecture — no Cloud SQL

Cloud SQL has no free tier (~$50–58/mo for db-custom-1-3840 Enterprise). Replaced pgvector with **flat-file embeddings in GCS** (`gs://mmr-data-pipeline-derivatives/<eventId>/embeddings/`) + in-memory cosine similarity in the matcher. Everything now targets free tiers: Firestore, GCS (5 GB regional, us-central1), Cloud Run, Pub/Sub, Secret Manager, Firebase Auth/Hosting. Expected steady-state spend: **$0** (watch Artifact Registry >0.5 GB and GCS egress). Details: runbook Phase F + dev plan decision-update banner.

⚠️ A `findme-pg` instance was briefly created on 2026-06-10 before this decision — **deleted same day** (`gcloud sql instances delete findme-pg`); cost a few cents at most. Confirm it's gone: `gcloud sql instances list`.

## Gotchas encountered

- `firebase projects:addfirebase` returned generic 403 despite Owner + firebase.admin. Cause: Firebase ToS never accepted by admin@mmrunners.org. Fix: add the project via console.firebase.google.com once.
- Org enforces `iam.allowedPolicyMemberDomains` (domain restricted sharing). `add-firebase.sh` temporarily overrides it at project level and restores on exit — reuse if IAM bindings fail with that constraint.
- No deny policies at project or org level (verified 2026-06-09 via roles/iam.denyReviewer, since removed? — remove binding when done: `gcloud organizations remove-iam-policy-binding 838436601528 --member="user:admin@mmrunners.org" --role="roles/iam.denyReviewer"`).
- ~~`firebase` CLI commands must run from `cloud-webapp/infra/`~~ **2026-06-10:** `firebase.json` + `.firebaserc` moved to `cloud-webapp/` root — the CLI errors with "outside of project directory" if the hosting public dir (`web/dist`) isn't under the dir containing firebase.json. Run firebase commands from `cloud-webapp/`. Rules files stayed in `infra/` (paths updated in firebase.json); `deploy-web.sh` + `deploy-web.yml` updated.
- Firebase CLI auth expires periodically → `firebase login --reauth`. The "no site name or target name" assertion error is a symptom of expired auth, not a config problem.
- **2026-06-10:** Workflows were in `cloud-webapp/.github/workflows/` where GitHub never registers them (404 on `gh workflow run`). Moved to repo-root `.github/workflows/` — their paths were already repo-root-relative, no content changes. Both deploy workflows support `workflow_dispatch`.
- **2026-06-10:** CI builds failed with TS6305 (`shared/dist/index.d.ts has not been built`) — web's tsconfig has a project reference to `../shared`, which worked locally only because `shared/dist` existed on disk. Fix: added `"build": "tsc -b"` to `shared/package.json`; `ci.yml` + `deploy-web.yml` now run `npm run build -w @cloud-webapp/shared` before typecheck/web build.
- GitHub Actions annotation: Node 20-based actions deprecated; runners force Node 24 from **2026-06-16**. Bump `actions/checkout` + `actions/setup-node` versions when convenient.
