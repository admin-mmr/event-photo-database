# Find Me — Handoff Note (2026-06-16)

**Scope of this note:** work completed in the 2026-06-16 session on the "Find Me"
face/person matching feature. Everything below is **code-complete, CI-green
locally, and NOT yet deployed/pushed.** It builds on the PRD
(`FACE_MATCHING_FEATURE_PRD.md`) and dev plan (`FACE_MATCHING_DEV_PLAN.md`); the
dev plan's status banners (2026-06-16c/d/e) and milestone tables are the
canonical status and were updated this session.

---

## 1. What shipped this session (code only)

| Item | Milestone | Summary |
|---|---|---|
| Dev-plan reconciliation | — | §5A backlog (B1–B8) reconciled with milestones M0–M6: status legend + §0.1 map; every Mx task and B-item marked Done/Code-complete/To-do. |
| **B8** instant event-metadata push | M1.4 | `gas-app` `triggerMetadataSync()` POSTs `/api/admin/sync` on event + upload-link creation (reuses the `X-Sync-Token` machine path). Closes the §5A backlog (B1–B8 now all code-complete). |
| **M5.3** abuse hardening | M5.3 | Per-user rate limiting (Firestore fixed-window, fail-open) on `findme/search` + `download`; reCAPTCHA Enterprise gate on search (no-op until keyed). Matcher decompression-bomb + upload-size guards confirmed already present. |
| **M4.3** Save to phone | M4.3 | Web Share API L2 (`web/src/lib/share.ts`) with download fallback; "📲 Save to phone" in `SelectBar`. |
| **M4.4** admin review queue | M4.4 | `GET /api/admin/feedback` (admin-gated, eventId/verdict filters + verdict counts). |
| **M3.3** no-face fallback | M3.3 | `findme/search` takes `mode`; UI offers "Search by outfit instead" (re-runs `mode=person`). |
| **M3.2** minor/guardian gate | M3.2 | Consent UI asks "under 18?" → guardian attestation; enforced server-side (`guardian_required`) + recorded on the consent doc. **Wording still pending legal (M5.6).** |
| **M3.4 (reuse half)** match a past photo | M3.4 | Fresh uploads persist to the uploads bucket + `find_me_uploads` record (90/30-day expiry); `GET /api/findme/uploads` + `POST /api/findme/uploads/:id/search`; multi-select picker of past selfies, each its own result set (FR-9). |

---

## 2. Files touched

**gas-app** (Apps Script)
- `src/services/indexTriggerClient.ts` — added `triggerMetadataSync()`.
- `src/routes/eventHandlers.ts`, `src/routes/linkHandlers.ts` — best-effort sync call on create.
- `tests/unit/indexTriggerClient.test.ts` — new (10 tests).

**cloud-webapp/api**
- `src/lib/config.ts` — new env: rate-limit/reCAPTCHA settings, `UPLOADS_BUCKET`, `REFERENCE_RETENTION_DAYS_ADULT/MINOR`.
- `src/middleware/rateLimit.ts` — new (Firestore fixed-window limiter + `consumeRateLimit` core).
- `src/middleware/recaptcha.ts`, `src/services/recaptcha.ts` — new (Enterprise assessment, fail-open on infra error / fail-closed on bad verdict).
- `src/services/references.ts` — new (`find_me_uploads` CRUD).
- `src/services/gcsService.ts` — added reference upload/read/sign helpers.
- `src/routes/findme.ts` — refactored to a shared `runSearch`; added `mode`, minor/guardian gate, reference persistence, `GET /api/findme/uploads`, `POST /api/findme/uploads/:id/search`.
- `src/routes/download.ts`, `src/routes/feedback.ts` — rate limit wired in; admin feedback queue route added.
- Tests: `rateLimit` (5), `recaptcha` (8), `feedbackAdmin` (6), `findmeUploads` (7), extended `findme` (15). **Full suite: 87 tests / 13 files green.**

**cloud-webapp/shared**
- `src/schemas/feedback.ts` — `FeedbackItem`, `AdminFeedbackResponse`.
- `src/schemas/findme.ts` — `ReferenceUpload`, `ListReferencesResponse`, `SearchByUploadRequest`.
- **`dist/` was rebuilt** (`npx tsc -b`); rebuild again after any further schema edits.

**cloud-webapp/web**
- `src/lib/share.ts` — new (+ `share.test.ts`, 10 tests).
- `src/lib/api.ts` — added `apiFetchBlob`.
- `src/components/SelectBar.tsx` — "Save to phone" action.
- `src/pages/FindMe.tsx` — minor/guardian consent, outfit fallback, save-to-phone, past-photo picker.
- **Full suite: 25 tests green.**

---

## 3. Deploy checklist (nothing here is live yet)

1. **Build/deploy** `api` + `web` (the usual WIF deploy scripts), then `gas-app`
   via `clasp push` (B8 lives in the Apps Script bundle).
2. **B6 re-run (still outstanding from §5A):** after deploying the indexer,
   trigger already-indexed events with `{"force":true}` to collapse existing
   duplicates and populate `contentHash` (see `CLAUDE.md` indexer notes; remember
   `Content-Type: application/json`).
3. **Uploads bucket** (`UPLOADS_BUCKET`, default `mmr-data-pipeline-uploads`)
   must exist. Grant the **api-runtime SA** object read+write on it (reference
   upload/read) — it already has `serviceAccountTokenCreator` on itself for V4
   signing of the derivatives bucket; the same is needed for signed reference
   URLs.
4. **Firestore TTL policies** (operational, one-time):
   - `rate_limits.expireAt` — so rate-limit counters self-delete.
   - `find_me_uploads.expiresAt` — so reference records self-delete on the
     90/30-day schedule. Also add a matching **object-lifecycle rule** on the
     uploads bucket (or wait for the M5.1 deletion job) so the GCS bytes are
     removed too — the TTL only deletes the Firestore record.
5. **reCAPTCHA (optional but recommended):** set `RECAPTCHA_PROJECT_ID`,
   `RECAPTCHA_SITE_KEY`, `RECAPTCHA_API_KEY` (and the web site key in the SPA).
   Until all three are set the gate **no-ops** by design, so the demo keeps
   working. Client sends the token in the `X-Recaptcha-Token` header for
   `action: findme_search`.
6. **Rate-limit tuning (optional):** `FINDME_SEARCH_LIMIT` (20),
   `FINDME_SEARCH_WINDOW_SEC` (60), `DOWNLOAD_LIMIT_PER_DAY` (50). `0` disables a
   bucket. The limiter **fails open** on any Firestore error.
7. **B8 config:** `FINDME_API_URL` + `INDEX_TRIGGER_TOKEN` Script Properties —
   already set for the existing index trigger, so no new config.
8. **Smoke-test after deploy:** create an event/link in gas-app → name appears
   in seconds (B8); run a search → confirm a `find_me_uploads` doc + GCS object
   appear; reopen Find Me → the photo shows in the reuse picker; pick it for a
   different event → its own result set; "Save to phone" → share sheet on mobile,
   download on desktop.

---

## 4. Still open (not started or partial)

- **M3.4 — My Data screen** (view/delete saved photos, opt-in *persistent*
  enrollment) + the delete-cascade. The reuse/list/search half is done; the
  self-service management UI is not. Overlaps M5.1/5.2.
- **M3.5 — EN/ZH localization** + full a11y/empty-state coverage. Deferred as a
  cross-cutting i18n refactor (no framework wired yet).
- **M4.4 — admin UI page** to render the `GET /api/admin/feedback` queue (the API
  exists; no screen yet).
- **M5.1 — retention/deletion jobs** (uploads, `match_runs` TTL, enrollment
  expiry, GCS lifecycle). Needed for real cleanup of the reference data added
  this session.
- **M5.2 — consent revoke→delete cascade + user "delete my data".**
- **M5.4 — budget alert $50/mo + Cloud Run max-instances caps + per-service SA
  audit.**
- **M5.5 — Firestore/Storage security rules tightening + consent/deletion audit
  logging.**
- **M5.6 — legal review of consent + minor-guardian wording** (launch gate; the
  *mechanism* is built, the *copy* is not signed off).
- **M6 — pilot & launch** (feature flag, metrics, `FINDME_RUNBOOK.md`, rollout).

---

## 5. Notes / gotchas for the next person

- **Tests gate via `tsc`, not eslint, for gas-app** (`lint` script = `tsc
  --noEmit`). api/web have real eslint configs.
- **Vitest sets `NODE_ENV=test`**, which the rate-limit middleware uses to
  no-op so route tests stay deterministic; the limiter's logic is unit-tested
  directly (`consumeRateLimit`).
- **`shared` resolves from `src` in tests but from built `dist` for api
  typecheck** (project references). Rebuild `shared` (`npx tsc -b`) after schema
  changes or api typecheck will see stale types.
- **reCAPTCHA and the rate limiter both fail OPEN on infra errors** by design —
  abuse protection is defence-in-depth, not the primary gate, and must never
  lock real attendees out. reCAPTCHA fails *closed* only on an actual bad
  verdict.
- **Reference reuse is strictly self-service:** list/search are scoped to the
  caller's uid; another user's `uploadId` returns 404 (not 403) so existence
  isn't leaked.
- **Reuse persistence vs the old 7-day working-copy rule:** the PRD §8.4 listed a
  7-day GCS lifecycle for reference *working copies*. Reuse deliberately keeps
  them for the 90/30-day tier instead — make sure the uploads-bucket lifecycle
  matches (don't apply a 7-day rule that would delete reusable references).
