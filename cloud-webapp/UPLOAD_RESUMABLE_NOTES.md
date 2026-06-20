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
  token is the gate.
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
3. `download()` the bytes and `uploadFileToDrive()` them into the folder,
   naming the Drive file from the `originalName` object metadata stamped at
   session-create time, then `delete()` the staged copy (lifecycle is the
   backstop).
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
  `enqueueStagedBatch` (copy + delete + single index trigger, skip
  missing/empty, basename fallback, no-trigger-when-nothing-copied,
  `not_configured` when the event has no Drive folder).

## TODO before production

- **Abuse protection**: add reCAPTCHA Enterprise + a per-token rate limit on
  `/session` (a leaked link otherwise lets anyone fill the bucket).
- **EXIF/GPS scrub**: the gas-app client strips GPS before upload
  (`sanitizeJpegMetadata`). Port that into `resumableUpload.ts` (sanitize the
  ArrayBuffer before slicing chunks) or do it server-side during the Drive copy.
- **Duplicate check + credited filename**: the gas-app flow renames files to the
  photographer credit and skips duplicates; fold that into the session request
  (`enqueueStagedBatch` currently keeps the uploaded `originalName` as-is).
```
