# Photos_NNN Migration Runbook — shortcuts → real JPGs

One-time migration that replaces the existing Drive **shortcuts** in every
event's `Photos_NNN` buckets with **real JPG files** (JPEG sources copied
byte-for-byte, other formats converted to JPG via the Cloud Run image-convert
service), then trashes the old shortcuts.

Entry point: `migratePhotoShortcutsToFiles()` in `gas-app/src/main.ts`
(super-admin guarded). Per-event variant: `migrateEventPhotoShortcutsToFiles(eventId)`.

> Run this **after** the new code is pushed and Cloud Run is configured. It is
> idempotent, resumable, and non-destructive (shortcuts are trashed, not
> hard-deleted).

---

## 0. Prerequisite — Cloud Run must be configured

The migration only converts non-JPEG photos if Cloud Run is reachable; otherwise
it leaves those shortcuts in place (reported as `skippedNoCloudRun`).

In the Apps Script editor: **Project Settings (gear) → Script Properties** and
confirm `CLOUD_RUN_URL` is set to your deployed `image-convert` URL (not the
`…REPLACE_ME…` placeholder). If it isn't, follow `cloud-run/DEPLOY_RUNBOOK.md`
first.

---

## 1. Push the new code to Apps Script

From the `gas-app/` folder on your machine:

```bash
cd gas-app
npm run login   # only the first time, if clasp isn't authenticated
npm run push    # builds, stamps, and runs `clasp push`
```

## 2. Open the editor and select the function

```bash
npm run open    # or open the project at script.google.com
```

In the editor's function dropdown (top toolbar), select
**`migratePhotoShortcutsToFiles`**.

## 3. Run it

Click **Run**. On the first run Google prompts you to authorize the new Drive
scopes — approve them. Must be run by a **super-admin** account (the function
checks and silently exits for anyone else).

## 4. Watch progress

Open **Executions** (left sidebar) or **View → Logs**. The final log line
summarizes the run:

```
[migratePhotoShortcutsToFiles] Done — events=… failed=… copied=… converted=… shortcutsTrashed=… dangling=… skippedNoCloudRun=…
```

| Counter            | Meaning                                                        |
|--------------------|----------------------------------------------------------------|
| `copied`           | JPEG shortcuts replaced by a byte-for-byte copy                |
| `converted`        | Non-JPEG shortcuts replaced by a Cloud Run conversion          |
| `shortcutsTrashed` | Old/redundant shortcuts moved to trash                         |
| `dangling`         | Shortcuts whose target no longer exists, removed               |
| `skippedNoCloudRun`| Non-JPEG shortcuts left in place because Cloud Run was unset    |
| `failed`           | Events that errored (see the `Errors:` log line)               |

## 5. Re-run until done

The migration is heavy (one Cloud Run conversion per non-JPEG) and may hit the
**6-minute GAS execution limit** and stop partway — that's expected. Simply run
it again; it resumes where it left off because a shortcut is only trashed once
its real file exists.

**You're finished when a run reports `shortcutsTrashed=0` and
`skippedNoCloudRun=0`.**

---

## Troubleshooting & notes

- **`skippedNoCloudRun` > 0** → Cloud Run wasn't reachable. Fix `CLOUD_RUN_URL`
  (see step 0) and re-run.
- **Very large single event timing out** → run `migrateEventPhotoShortcutsToFiles`
  for that one event instead. Add a tiny wrapper in `main.ts` that calls it with
  the target `eventId`, or run it from the editor with the id hard-coded
  temporarily.
- **Verify before trusting it** → after the first run, open a `Photos_001`
  folder in Drive and confirm the entries are real images (image thumbnail),
  not shortcut icons.
- **Rollback** → replaced shortcuts are in **Drive trash** for 30 days and can be
  restored. The new JPG copies carry a private `appProperties.sourcePhotoId`
  tag; deleting them and re-running the normal rebuild restores shortcuts only
  if you also revert the code.
- **Idempotent** → safe to run any number of times; a fully migrated catalogue
  is a fast no-op.

---

## Testing a single file + watching the Cloud Run logs

Before (or instead of) a full run, you can convert one specific file end-to-end
and watch it land in Cloud Run.

### A. Convert one file by ID — `debugConvertImage()`

This calls the convert service directly (no rebuild/migration) and logs the
full response.

1. Apps Script editor → **Project Settings (gear) → Script Properties**, add:

   ```
   TEST_CONVERT_SOURCE_FILE_ID = <Drive ID of a NON-JPEG image, e.g. a .png>
   TEST_CONVERT_DEST_FOLDER_ID = <Drive ID of a scratch folder for the output JPG>
   ```

   (Get a file ID from its Drive URL `…/d/<FILE_ID>/…`; a folder from
   `…/folders/<FOLDER_ID>`.)

2. `npm run push`, then in the editor select **`debugConvertImage`** → **Run**
   (super-admin only).

3. Read the execution log. Success ends with:

   ```
   ✅ Converted OK — new JPG file ID: <id> (sourceMime=image/png, cloudRunMs=…)
   ```

   Useful failure signals: `error=not_configured` → `CLOUD_RUN_URL` Script
   Property isn't set; `error=unsupported_format` on a **JPEG** is expected
   (JPEGs are copied, not converted — test with a PNG/HEIC/WEBP).

### B. See the Cloud Run service logs

**Console:** Cloud Run → `image-convert` → **Logs** tab (filter to the last few
minutes around your test).

**Command line** (region/project from `cloud-run/DEPLOY_RUNBOOK.md`):

```bash
# last 50 lines
gcloud run services logs read image-convert \
  --region us-east4 --project mmrunners-photo-prep --limit 50

# live tail while you run debugConvertImage
gcloud beta run services logs tail image-convert \
  --region us-east4 --project mmrunners-photo-prep
```

A successful PNG conversion looks like:

```
[a1b2c3d4] POST /convert from …
[a1b2c3d4] source=<fileId> mime=image/png name=<file>.png
[a1b2c3d4] done  destFileId=<newId>  destSize=…  elapsed=…ms  result=ok
```

The `mime=image/png` line proves Cloud Run received it as a PNG; `result=ok`
confirms the JPG was produced. The `request_id` and `destFileId` match what
`debugConvertImage` prints on the Apps Script side, so you can line up both ends.
If Cloud Run shows **nothing**, the request never left Apps Script — check the
execution log for `not_configured` or an IAM/`unauthorized` error.

---

## What changed in the code (for reference)

- `Photos_NNN` now holds real JPGs instead of shortcuts
  (`specialFoldersService.rebuildEventPhotoFolders`).
- Dedupe key for copies is `appProperties.sourcePhotoId`
  (`driveShortcutClient.ts`).
- The orphan sweep (`removeShortcutsForTargets`) also trashes copies whose
  source was deleted.
- `Videos/` and `Album/` folders are unchanged — still shortcuts.
