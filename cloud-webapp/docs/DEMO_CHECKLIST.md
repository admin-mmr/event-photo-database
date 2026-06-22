# Find Me — Stakeholder Demo Checklist

**Goal:** live demo of Events → Gallery → Find Me (selfie search) → Results at
https://mmr-data-pipeline.web.app

**Scope shipped 2026-06-12 (demo fast-path):** M2 search API + minimal M3 UI with a
simple consent dialog. Deferred to full M3/M5: i18n (ZH), enrollment, minor/guardian
consent path, rate limiting/reCAPTCHA, feedback buttons.

> **Update 2026-06-22:** several items listed as "deferred" below have since been
> built. The Find Me B-series backlog (B1–B8) — feedback buttons ("not me"),
> original-res ZIP download, multi-selfie switching, content-hash dedup, instant
> metadata sync — is now **code-complete in the repo, pending one deploy** (api +
> web, plus a B6 indexer re-run). Still genuinely unbuilt: ZH localization, selfie
> enrollment, and the minor/guardian consent path. See
> `../GAS_MIGRATION_DEV_PLAN.md` §4A.1–4A.2 for current status.

The code deploys itself on `git push` (api + hosting). What remains is the
**one-time human steps** below — all run from `cloud-webapp/` with `gcloud` logged in
as admin@mmrunners.org. Budget ~half a day, plus model download time.

---

## 1. Models into the build context (~30 min)

```bash
cd matcher
python3 scripts/fetch_models.py --dir model_files   # SCRFD + ArcFace
# OSNet one-time ONNX export (separate venv, see requirements-export.txt):
python3 -m venv .venv-export && .venv-export/bin/pip install -r requirements-export.txt
.venv-export/bin/python scripts/export_osnet.py --out model_files/
```

Sanity check: `ls model_files/` should show the SCRFD, ArcFace, and OSNet `.onnx` files.

## 2. Deploy the matcher service (~20 min)

```bash
./infra/scripts/deploy-matcher.sh mmr-data-pipeline
```

Then (one-time IAM + wiring):

```bash
# api may call the matcher (project-level run.invoker already covers this;
# explicit binding is belt-and-braces):
gcloud run services add-iam-policy-binding matcher --region=us-central1 \
  --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

Set the repo **variable** (not secret) `MATCHER_URL` to the printed service URL:
GitHub → Settings → Secrets and variables → Actions → **Variables** tab → New
repository variable. Then `gh workflow run deploy-api.yml --ref main`.

## 3. Signed URLs IAM (one command)

V4 signing with ADC uses the IAM signBlob API — api-runtime needs tokenCreator
**on itself**:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  api-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
  --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 4. Deploy the indexer Job + index one real event (~1–2 h incl. run time)

```bash
./infra/scripts/deploy-indexer.sh mmr-data-pipeline
# one-time IAM for api→job trigger + DWD JWT signing: see deploy-indexer.sh header
```

Pick a demo event with a few hundred photos and clear faces. Set its Drive folder
on the Firestore `events` doc (Console → Firestore → events → `<eventId>` →
add field `driveFolderId`), then:

```bash
gcloud run jobs execute photo-indexer --region=us-central1 \
  --update-env-vars=EVENT_ID=<eventId>
# watch: gcloud beta run jobs executions logs read <execution> --region=us-central1
```

DoD: the event doc's `indexState.status == "done"` and `photoCount` matches the
Drive folder count.

## 5. Smoke test the full path (~15 min)

1. Open https://mmr-data-pipeline.web.app → sign in with Google.
2. Event appears with "Find Me ready" badge → open gallery, thumbnails load
   (signed URLs working).
3. Find Me → consent box → upload a selfie of someone known to be in the photos →
   results show them ranked first; download works.
4. Negative checks: selfie of a non-attendee returns few/zero high scores; a
   landscape photo returns the "no clear face" message.

## 6. Pre-demo polish (optional but cheap)

- Warm instance for the demo hour (skips the ~20 s model cold start):
  `gcloud run services update matcher --region=us-central1 --min-instances=1`
  (set back to 0 after).
- Budget guardrails if not yet run: `./infra/scripts/provision-budget-guardrails.sh`
  (runbook Phase J).
- Have a backup phone photo ready in case the venue Wi-Fi blocks popups
  (sign-in is a popup).

## Demo script (5 min)

1. The problem: hundreds of event photos, attendees can't find themselves.
2. Sign in → pick event → gallery (photos served from our own bucket, Drive
   stays the archive).
3. Find Me: consent step (privacy story: explicit consent, uploads not kept,
   $0/month architecture) → selfie → ranked results → download.
4. What's next: Chinese UI, feedback buttons ("not me"), guardian flow for
   minors, then general rollout — ~4–6 weeks to production per the dev plan.

## Known demo-scope limitations (say them before stakeholders find them)

These describe the **currently deployed** demo site. Items marked _(code-complete,
pending deploy)_ exist in the repo and land on the next api + web deploy — see the
2026-06-22 update note at the top.

- English only (ZH lands with full M3 — still unbuilt).
- Search requires Google sign-in (link-only access lands with M3 — still unbuilt).
- Reference selfie isn't saved — every search re-uploads (enrollment is M3 — still unbuilt).
- "Not me" feedback (B7) — _code-complete, pending deploy_; accuracy tuning continues
  via EVAL_FEEDBACK_LOOP.md.
