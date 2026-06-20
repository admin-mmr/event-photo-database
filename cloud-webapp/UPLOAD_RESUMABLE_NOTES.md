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
  with ADC (no credential ever reaches the browser), and exposes
  `enqueueStagedBatch` (the Drive-copy + index handoff — currently a stub).
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
   object names → server records the batch and (TODO) copies to Drive + indexes.

## Required infra (NOT done by the code — operator steps)

### 1. Bucket CORS on the staging bucket

The browser PUTs cross-origin to `storage.googleapis.com` and must be able to
read the `Range` response header to resume. Apply CORS to
`VOLUNTEER_STAGING_BUCKET`:

```json
[
  {
    "origin": ["https://<your-web-origin>"],
    "method": ["PUT", "POST", "GET", "HEAD"],
    "responseHeader": ["Content-Type", "Range", "Location", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
```

Apply with:

```bash
gcloud storage buckets update gs://mmr-data-pipeline-uploads --cors-file=cors.json
```

Set `VOLUNTEER_UPLOAD_ORIGIN` to the same origin so the signed session is bound
to it.

### 2. IAM

`createResumableUpload()` with ADC needs the api runtime SA to write to the
staging bucket: grant `roles/storage.objectAdmin` (or objectCreator + a way to
query offsets) on the bucket to `api-runtime@`.

### 3. Lifecycle rule (cost hygiene)

Give the staging bucket a lifecycle rule to delete objects (and abort
unfinished multipart/resumable uploads) after ~7 days, so abandoned sessions
don't accumulate. Prefer a dedicated `*-uploads-staging` bucket over reusing the
Find Me uploads bucket so the rule doesn't touch reference selfies.

## TODO before production

- **Wire `enqueueStagedBatch`**: verify each staged object exists + is non-zero,
  copy originals from staging into the event's Drive folder (preserving the
  credited filename), then trigger `photo-indexer`. NOTE: `driveService` only
  requests `drive.readonly` today — the copy needs a `drive` write scope on the
  DWD client (Workspace Admin console, same client id), or write directly to a
  GCS-native originals path and skip Drive.
- **Abuse protection**: add reCAPTCHA Enterprise + a per-token rate limit on
  `/session` (a leaked link otherwise lets anyone fill the bucket).
- **EXIF/GPS scrub**: the gas-app client strips GPS before upload
  (`sanitizeJpegMetadata`). Port that into `resumableUpload.ts` (sanitize the
  ArrayBuffer before slicing chunks) or do it server-side during the Drive copy.
- **Tests**: unit-test the offset parser + retry logic in `resumableUpload.ts`
  and the link validation in `volunteerUploadService.ts`.
- **Duplicate check + credited filename**: the gas-app flow renames files to the
  photographer credit and skips duplicates; fold that into the session request.
```
