# Volunteer resumable uploads — implementation notes

Draft implementation of GCS-first **resumable** uploads for the volunteer
upload flow, replacing the gas-app "upload straight to Drive, DO NOT close this
window or you lose everything" experience. Bytes land in a GCS staging bucket
via a resumable session (resume after a dropped connection or a closed tab),
then a server-side step copies them into Drive and triggers the indexer.

## What was added

**Shared** (`shared/src/schemas/upload.ts`) — Zod contracts for the two
endpoints, plus the accepted-MIME allowlist and per-file size cap.

**API**
- `services/volunteerUploadService.ts` — validates the upload-link token
  against the master Sheet's `Upload_Links` tab, mints a GCS resumable session
  with ADC (no credential ever reaches the browser), and `enqueueStagedBatch`
  copies each staged original into the event's Drive folder then triggers the
  indexer (see "Handoff" below).
- `services/driveService.ts` — `getDriveToken(scope)` now mints per-scope DWD
  tokens, and `uploadFileToDrive()` does a multipart create into a Drive folder
  with the read-write scope.
- `routes/volunteerUpload.ts` — `POST /api/volunteer/upload/session` and
  `POST /api/volunteer/upload/complete`. Public (no Firebase auth); the link
  token is the gate. `/session` is additionally gated by a per-token rate limit
  (`volunteerUploadRateLimit`) and reCAPTCHA Enterprise
  (`requireRecaptcha('volunteer_upload')`) — both no-op when unconfigured / in
  tests / limit 0, so dev and the demo keep working without keys.
- `lib/creditedFileName.ts` — pure-TS port of the gas-app credited-filename
  builder; the handoff renames each original to `<Club>_<Photographer>_<orig>`.
- `lib/config.ts` — `VOLUNTEER_STAGING_BUCKET`, `VOLUNTEER_STAGING_PREFIX`,
  `VOLUNTEER_UPLOAD_ORIGIN`.
- `server.ts` — mounts `volunteerUploadRouter`.

**Web**
- `lib/uploadDb.ts` — IndexedDB persistence of session URIs (keyed by
  token+name+size+lastModified, 7-day TTL) so a reopened tab resumes.
- `lib/resumableUpload.ts` — the chunked PUT protocol with offset query, retry
  with backoff, and progress callbacks.
- `pages/VolunteerUpload.tsx` — the page (drag/drop, progress, ETA, reworded
  "safe to close and resume" banner, receipt).
- `App.tsx` — public route `/upload/:token` outside the auth gate (refactored
  the signed-in pages onto a layout route).

## Flow

1. Browser `POST /api/volunteer/upload/session` `{ token, batchId, fileName,
   mimeType, size }` → server validates the link, calls GCS
   `createResumableUpload()`, returns `{ uploadId, objectName, sessionUri }`.
2. Browser PUTs the file to `sessionUri` in 8 MiB chunks. On reconnect/reopen it
   sends `Content-Range: bytes */<total>` to learn the committed offset and
   resumes. Session URI + offset persist in IndexedDB.
3. On finish, browser `POST /api/volunteer/upload/complete` with the staged
   object names → `enqueueStagedBatch` copies each original into the event's
   Drive folder and triggers the indexer.

## Handoff (`enqueueStagedBatch`) — wired

For each staged object name from `/complete`:
1. Resolve the event's Drive folder id from the `events` Firestore doc
   (`driveFolderId`); a missing folder raises `not_configured` (→ 503).
2. Verify the object exists and is non-zero (guards a client that called
   `/complete` before its PUTs finished); missing/empty are logged + skipped.
3. Build the credited name (`<Club>_<Photographer>_<originalName>`) from the
   link + stamped metadata; skip + clean up if that name + size already exists
   in Drive (or earlier in this batch). Otherwise `download()` the bytes and
   `uploadFileToDrive()` them into the folder under the credited name, then
   `delete()` the staged copy (lifecycle is the backstop).
4. Trigger `photo-indexer` once for the event — only if ≥1 file was copied.

A single file's copy failure is logged and skipped, not fatal to the batch;
the returned count drives the receipt. Each object is buffered in memory for
the copy (fine for photos; revisit with a streamed copy if large videos become
common). The Drive write uses the new `drive` scope — operator step A below.

## Required infra (operator steps)

Run the provisioning script — it creates a dedicated staging bucket, applies
CORS, grants `roles/storage.objectAdmin` to `api-runtime@`, and sets a 7-day
delete + abort-incomplete-upload lifecycle:

```bash
./infra/scripts/provision-volunteer-uploads.sh mmr-data-pipeline https://mmr-data-pipeline.web.app
```

The bucket is dedicated (`<project>-uploads-staging`) rather than the Find Me
uploads bucket so the purge lifecycle never touches reference selfies. The
script prints the two steps it cannot do for you:

- **A. Drive write scope (Workspace Admin console).** The copy step needs the
  read-write Drive scope; the read path keeps `drive.readonly`. Add
  `https://www.googleapis.com/auth/drive` to the DWD client (same client id as
  the indexer) under Security → API controls → Domain-wide delegation.
- **B. api env vars.** `gcloud run services update event-photo-api
  --update-env-vars=VOLUNTEER_STAGING_BUCKET=…,VOLUNTEER_UPLOAD_ORIGIN=…`
  (merge — never `--set-env-vars`, which blanks `MATCHER_URL`/sync token).

## Tests (added)

- `web/src/lib/resumableUpload.test.ts` — `committedFromRange` offset parsing,
  `backoffMs` exponential-backoff schedule, and `queryOffset` resume-probe
  behaviour (308/200/201/5xx) with `fetch` stubbed.
- `api/test/volunteerUploadService.test.ts` — link validation (valid / invalid
  / revoked / non-fatal name lookup), the staging-name helpers, and
  `enqueueStagedBatch` (credited-name copy + delete + single index trigger, dedup
  vs. existing Drive files + within-batch, same-name-different-size is NOT a dup,
  club-only prefix when no photographer, skip missing/empty, basename fallback,
  no-trigger-when-nothing-copied, `not_configured` when the event has no folder).
- `api/test/creditedFileName.test.ts` — the ported credited-name builder
  (prefix assembly, non-ASCII, idempotency, club-only, fallback, truncation).

## Abuse protection + dedup + credit (implemented)

- **Abuse protection — DONE.** `/session` is gated by `volunteerUploadRateLimit`
  (Firestore fixed-window counter keyed on the LINK TOKEN, since the route is
  unauthenticated and a leaked link is the abuse vector — `VOLUNTEER_UPLOAD_LIMIT`
  / `VOLUNTEER_UPLOAD_WINDOW_SEC`, default 2000/hour, 0 disables, fails OPEN) and
  by reCAPTCHA Enterprise (`requireRecaptcha('volunteer_upload')`). The browser
  acquires a token via `web/src/lib/recaptcha.ts` (no-op unless
  `VITE_RECAPTCHA_SITE_KEY` is set) and sends it in `X-Recaptcha-Token`. To turn
  the gate on in prod, set the three `RECAPTCHA_*` api env vars + the site key.
- **Duplicate check + credited filename — DONE (server-side).** `enqueueStagedBatch`
  renames each staged original to `<Club>_<Photographer>_<orig>` via
  `buildCreditedFileName` (club from the link, photographer stamped onto the
  staging object at session-create time from the optional name field on the
  page), then skips any file whose credited name + byte size already exists in
  the event's Drive folder (or appeared earlier in the same batch). The receipt
  reports `accepted` + `skippedDuplicates`. Dedup listing failure is non-fatal
  (proceeds without dedup; the indexer dedups by content hash downstream).

## Deliberately NOT done

- **EXIF/GPS scrub — intentionally skipped.** Per product decision, location
  EXIF/GPS is kept in the file. (The gas-app client strips GPS via
  `sanitizeJpegMetadata`; we do not replicate that here.)
```
