# Managed folders — enablement & cutover (gas-app → cloud-webapp)

Operational steps to turn on the post-upload "special folders" pipeline
(Photos_NNN / Videos / Album + public folder index) in cloud-webapp. The code
ships **disabled** (`MANAGED_FOLDERS_ENABLED=false`), so deploying it changes
nothing until these steps are done. Mirrors the structure of `CUTOVER_RUNBOOK.md`.

## Prerequisites (one-time)

1. **DWD scopes** — no new scope. The pipeline uses the `drive` (read/write) and
   `spreadsheets` scopes already authorized on the DWD client for the upload and
   control-plane paths. Permission grants, shortcut creates, `files.copy`, and
   `appProperties` all fall under `drive`.

2. **Public folder index Sheet** — create a new, empty Google Sheet; share it
   **Anyone with the link → Viewer** (optionally also Publish to web). Copy its
   file id from `/d/<ID>/edit` and set `PUBLIC_FOLDER_INDEX_SHEET_ID`. Leave
   unset to skip the public mirror (folders are still built; just not published).
   The Photo Folders / Video Folders / per-club tabs are created automatically.

3. **Image-convert service (optional, for non-JPEG real JPGs)** — under the
   storage-minimizing policy JPEGs are linked as shortcuts and only non-JPEG
   sources (PNG/HEIC/WEBP) are materialised as real JPGs. That conversion needs
   the Cloud Run image-convert service (gas-app's `CLOUD_RUN_URL`):
   - Confirm the service is deployed and reachable.
   - Grant the api runtime SA invoker on it:
     `gcloud run services add-iam-policy-binding <convert-svc> --region=us-central1 --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" --role=roles/run.invoker`
   - Set `IMAGE_CONVERT_URL` to the service URL.
   - If left unset, non-JPEG photos fall back to a shortcut (functional; just no
     in-bucket JPG, and the original format opens via the shortcut).

## Enable

4. **Deploy** with the flag on (env merged by `deploy-api.sh`, which now knows
   these vars):

   ```bash
   MANAGED_FOLDERS_ENABLED=true \
   PUBLIC_FOLDER_INDEX_SHEET_ID=<sheet id> \
   IMAGE_CONVERT_URL=<convert service url> \
   ./infra/scripts/deploy-api.sh mmr-data-pipeline
   ```

   The `Special_Folders` tab is created on the master Sheet on the first write.

5. **No new scheduler job.** The periodic full rebuild is folded into the
   existing `findme-index-scan` job (`POST /api/admin/index-scan`): for each
   event whose Drive content changed since the last scan it rebuilds the folders,
   then refreshes the public index once. The inline post-upload hook covers the
   live path; the scan is the safety net + out-of-band-change catcher.

## One-time backfill (existing events)

6. After enabling, from the admin UI (Folders page) or via the API:
   - **Backfill sharing** — `POST /api/admin/folders/backfill-sharing` makes every
     pre-existing managed folder public so the folder-index links work.
   - **Migrate photo shortcuts** (optional) — `POST /api/admin/folders/migrate-photo-shortcuts`
     converts historical NON-JPEG shortcuts in Photos_NNN buckets to real JPGs.
     JPEG shortcuts are intentionally left as shortcuts. Idempotent/resumable;
     re-run until it reports zero conversions for very large catalogues.

## Verify

7. Upload a small batch through a volunteer link to a test event and confirm:
   - `<Event>/Photos_001/` holds shortcuts for JPEGs and (if convert is on)
     real `.jpg` files for any HEIC/PNG/WEBP.
   - `<Event>/<Club>/<Tag>/Videos/` and `/Album/` hold the expected shortcuts.
   - The `Special_Folders` tab has one row per managed folder with a current
     `LAST_REFRESHED_AT`.
   - The public index Sheet shows Photo Folders / Video Folders / the club tab.
   - Manually `POST /api/admin/folders/rebuild/<eventId>` reproduces the same
     state (idempotent — no duplicate shortcuts/rows).

## Tuning & rollback

8. **Drive rate limiting** — all Drive calls are paced + retried by
   `driveRateLimit`. If you ever see `403 rateLimitExceeded`, raise
   `DRIVE_MIN_INTERVAL_MS` (e.g. 200 ≈ 5 req/s) and/or `DRIVE_MAX_RETRIES`.
   To go faster on a quiet project, lower `DRIVE_MIN_INTERVAL_MS`.

9. **Rollback** — set `MANAGED_FOLDERS_ENABLED=false` and redeploy (or just
   update the env var on the service). The inline hook, the index-scan rebuild,
   and the delete sweep all no-op immediately; nothing already built is removed.

## Cost notes (per CLAUDE.md)

- No new always-on service; the rebuild runs inside the existing api request /
  the existing index-scan job, both scale-to-zero.
- Photos buckets favour shortcuts (no duplicate storage) except where a real JPG
  is needed for a non-JPEG source.
- Public index tabs are tiny (folder rows), so they don't implicate the
  Hosting-egress rule — photo bytes are never served through this path.
