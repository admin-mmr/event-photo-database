# cloud-webapp — Demo Readiness Report

_Run 2026-06-14. Demo target: live site https://mmr-data-pipeline.web.app_

## Verdict: Yes, with caveats

The **code is demo-ready** — everything builds, typechecks, lints, and tests green,
the API boots, and the deployed backend is live (`/api/health` → `ok`, commit `4a81145`).
The **demo itself** depends on a handful of one-time GCP/infra steps in
`docs/DEMO_CHECKLIST.md` that I can't run or verify from here (they need `gcloud` logged
in as admin@mmrunners.org). Confirm those are done and run the smoke test before presenting.

## What I verified (and it passed)

| Check | Result |
|---|---|
| `npm run check` (tsc --noEmit + eslint, all 3 workspaces) | ✅ clean |
| `npm test` | ✅ 28 passed (26 api + 2 web) |
| API boots locally + `GET /api/health` | ✅ `{ok:true, version:"0.1.0"}` |
| Protected routes reject unauthenticated calls | ✅ 401 as expected |
| `web` production build (Vite) | ✅ 51 modules, ~87 kB gzipped |
| Live hosting + Firebase init.json | ✅ HTTP 200 |
| Live backend `/api/health` | ✅ `ok`, commit `4a81145` |

The noisy JSON in test output is expected log lines from negative-path tests, not failures.

## The demo path

Sign in with Google → Events list → Gallery (per event) → Find Me (selfie search) → ranked
results + download. Code present and wired: `events`, `gallery`, `findme`, `health` routes;
`Events`, `Gallery`, `FindMe` pages + Firebase Auth + a simple consent dialog. This matches
the "M2 + minimal M3" demo fast-path shipped 2026-06-12.

## What gates the live demo (not code — human/infra steps)

From `docs/DEMO_CHECKLIST.md`, all run from `cloud-webapp/` with gcloud as admin. ~half a day:

1. **Models into build context** — `matcher/scripts/fetch_models.py` + OSNet ONNX export.
2. **Deploy matcher** — `./infra/scripts/deploy-matcher.sh mmr-data-pipeline`, then set the
   repo **variable** `MATCHER_URL`. Until this is set, Find Me search returns 503
   (`matcher_unconfigured`) — confirmed in the test suite.
3. **Signed-URL IAM** — grant `api-runtime` tokenCreator on itself, or gallery thumbnails
   won't get signed URLs.
4. **Deploy indexer + index one real event** — set `driveFolderId` on the event's Firestore
   doc; DoD is `indexState.status == "done"`.
5. **Smoke test** the full path on the live site (sign in → gallery loads → selfie → results).
6. _Optional polish:_ warm a matcher instance (`--min-instances=1`) to skip the ~20 s cold start.

## Config / secrets

No required env to boot the API (all `config.ts` fields have safe defaults). For a *fully local*
end-to-end demo you'd additionally need ADC (`gcloud auth application-default login`) for
Firebase token verification + Firestore reads, plus real event data. **Simpler: demo the live
deployed site**, which is already up.

## Known limitations to state up front (from the checklist)

English only; search requires Google sign-in; reference selfie isn't saved (re-upload each
search); no "not me" feedback yet. These are scheduled for full M3/M4.

## Doc nit

The migration table in `README.md` is stale — it lists most features "not started," but M2 +
minimal M3 shipped. The authoritative status is `docs/DEMO_CHECKLIST.md` +
`FACE_MATCHING_DEV_PLAN.md`. Worth updating the README so a fresh reader isn't misled.

## Environment note — Node 22 (applied & re-verified 2026-06-14)

The repo is now on Node 22. Four edits made: `.nvmrc` → `22`, root `engines.node` →
`>=22.0.0 <23`, `api/Dockerfile` both stages → `node:22-slim`, `api` `@types/node` → `^22.7.4`
(installed 22.19.21). CI/deploy-web read `.nvmrc` so they follow automatically; prod Cloud Run
follows the Dockerfile. Matcher/indexer are Python, untouched.

Re-ran the full prompt on Node 22 — all green:

| Check (Node 22) | Result |
|---|---|
| typecheck (shared/api/web) | ✅ clean |
| lint (api/web) | ✅ clean |
| `npm test` | ✅ 28 passed (26 api + 2 web) |
| API boot + `/api/health` | ✅ `{ok:true}` |
| `web` production build | ✅ built, ~87 kB gzipped |

Recommend landing this on a branch so CI runs green before merge — not right before the demo.
