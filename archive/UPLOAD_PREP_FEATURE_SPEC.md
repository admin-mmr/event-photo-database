# Face Detection Upload Prep — Feature Specification

**Status:** Ready for implementation
**Author context:** Distilled from a design brainstorm between Cathy (product owner, super admin) and Claude. All open design questions have been decided.
**Audience:** Implementer (human or LLM). This document is self-contained — no prior chat context is required.

---

## 1. Feature summary

Super admins need to prepare a flat, JPG-only bundle of photos from one event, suitable for manual upload to an external face-detection application. The SSOT (source of truth) lives in Google Drive and contains a mix of JPG, PNG, HEIC, RAW, and video files in per-event folders. The output is a parallel `_UploadPrep/<EventName>/` folder in the same Drive, containing **only JPGs**, produced by copying existing JPGs and converting supported non-JPG images. Every produced file has a mapping row back to its source file.

The flow the user sees:

1. Super admin opens the Apps Script web app and clicks **Prep Upload Files**.
2. A dropdown lists all event folders in the SSOT root.
3. User picks one event, clicks **Run**.
4. The system runs **incrementally** — files already in the per-event manifest are skipped. New or changed source files are processed. Progress streams to the UI.
5. When done, the user opens `_UploadPrep/<EventName>/` in Drive and manually uploads the JPGs to the face-detection app.

---

## 2. Decisions already made (do not revisit without asking Cathy)

| # | Decision | Value |
|---|---|---|
| D1 | Target structure | Flat: `_UploadPrep/<EventName>/*.jpg` (no subfolders) |
| D2 | Filename collision policy | Keep original stem, append `__2`, `__3`, … on collision. Extension lowercased to `.jpg`. |
| D3 | Live Photo MP4 next to HEIC | Skip the MP4 (video policy), convert the HEIC. |
| D4 | JPG quality | `92` |
| D5 | Resizing | None in v1 (target app size limits unknown). Leave a `maxDim` config hook for later. |
| D6 | EXIF | **Preserve** EXIF. **Bake in** orientation (rotate pixels to be physically upright, reset orientation tag to 1). |
| D7 | Already-JPG files | Copy as-is via Drive `files.copy`. Do **not** re-encode. |
| D8 | Re-run policy | Incremental by default — skip if `source_fileId` + `source_md5Checksum` already in manifest. `force=true` flag re-processes everything. |
| D9 | UploadPrep location | `_UploadPrep/` directly at the SSOT root (same Drive folder that contains the event folders). |
| D10 | Manifest format | **Per-event CSV** at `_UploadPrep/<EventName>/_manifest.csv`. Plus a small global `_UploadPrep/_index.csv` listing which events have been prepped and when. |
| D11 | Scope of one run | **One event per run.** No "run all." |
| D12 | Formats to convert | **JPG** (copy), **PNG**, **HEIC/HEIF**, **RAW** (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW), **TIFF**, **WEBP**, **BMP**, **AVIF**. First frame for animated WEBP/GIF. |
| D13 | Formats to skip | All videos (`MP4, MOV, AVI, MKV, WMV, FLV, WEBM, 3GP, M4V`), audio, PDFs, archives, and anything with a MIME type not starting with `image/`. Each skipped file still gets a manifest row with `action=skipped` and `skip_reason`. |
| D14 | Conversion backend | **Google Cloud Run** (Python) — because Apps Script V8 cannot convert HEIC/RAW and `Blob.getAs(MimeType.JPEG)` is unreliable even for PNG. |
| D15 | Auth between Apps Script and Cloud Run | **Forward the user's OAuth access token** via `Authorization: Bearer <token>` header. Cloud Run uses that token to call the Drive API, so permissions match the user. No service-account-to-Drive sharing needed. Cloud Run itself is protected by IAM — caller must be the Apps Script's service identity. |
| D16 | Super-admin gating | Email allowlist constant in Apps Script, checked via `Session.getEffectiveUser().getEmail()` before any work runs. |
| D17 | Dry-run | Supported via `dryRun=true` flag. Writes manifest rows with `action=would_copy` / `would_convert` but does not create files. |

---

## 3. Architecture

```
                  ┌────────────────────────────────────────────┐
                  │ Google Drive (user's)                       │
                  │                                             │
                  │  <SSOT root>/                               │
                  │    20260315-NYRR-纽半马/  ← event folder    │
                  │      IMG_2655.JPG                           │
                  │      IMG_5001.HEIC                          │
                  │      IMG_5001.MP4  (skip)                   │
                  │      ...                                    │
                  │    _UploadPrep/         ← created by tool   │
                  │      _index.csv                             │
                  │      20260315-NYRR-纽半马/                  │
                  │        _manifest.csv                        │
                  │        IMG_2655.jpg                         │
                  │        IMG_5001.jpg  (from HEIC)            │
                  └────────┬─────────────────────┬──────────────┘
                           │ Drive API           │ Drive API
                           │ (user token)        │ (user token)
                ┌──────────┴─────┐      ┌────────┴─────────────┐
                │ Apps Script    │ HTTPS│ Cloud Run (Python)   │
                │ web app        ├─────►│ image-convert        │
                │ (existing)     │ Bearer│                      │
                │                │ token │ Pillow               │
                │ - UI sidebar   │       │ + pillow-heif        │
                │ - orchestrator │◄──────┤ + rawpy              │
                │ - manifest I/O │  JSON │                      │
                │ - JPG copies   │       │ Downloads source,    │
                │ - calls Run for│       │ converts, uploads    │
                │   non-JPG      │       │ result, returns      │
                │ - super-admin  │       │ new fileId.          │
                │   gating       │       └──────────────────────┘
                └────────────────┘
```

### Why this split
- Apps Script handles file enumeration, orchestration, and simple copies (native `DriveApp.makeCopy`) — fast and free.
- Cloud Run handles only the expensive pixel work, using mature Python image libraries (HEIC and RAW have no viable JS equivalent).
- The user's own OAuth token flows through to Cloud Run, so Drive permissions are enforced identically on both sides. No service account sharing needed.

---

## 4. Data contracts

### 4.1 Per-event manifest — `_UploadPrep/<EventName>/_manifest.csv`

UTF-8, comma-separated, header row required. One row per source file **attempted** (including skipped).

| Column | Type | Example | Notes |
|---|---|---|---|
| `event_name` | string | `20260315-NYRR-纽半马` | Matches the SSOT folder name exactly |
| `source_file_id` | string | `1aB2c...` | Drive file ID of source |
| `source_name` | string | `IMG_5001.HEIC` | Drive `name` |
| `source_mime_type` | string | `image/heic` | Drive `mimeType` |
| `source_md5_checksum` | string | `d41d8cd...` | Drive `md5Checksum` (binary files only; empty for Google-native) |
| `source_size_bytes` | int | `3456789` | |
| `source_modified_time` | ISO8601 | `2026-03-15T12:34:56.000Z` | Drive `modifiedTime` |
| `dest_file_id` | string | `1xY9z...` | Blank if skipped or dry-run |
| `dest_name` | string | `IMG_5001.jpg` | Final name in UploadPrep (after collision resolution) |
| `action` | enum | `copied`, `converted`, `skipped`, `would_copy`, `would_convert`, `would_skip`, `error` | |
| `skip_reason` | string | `video`, `not_an_image`, `unsupported_format`, `error: <msg>` | Blank unless `action=skipped` or `error` |
| `jpg_quality` | int | `92` | Blank if copied or skipped |
| `exif_preserved` | bool | `true` | Blank if skipped |
| `processed_at` | ISO8601 | `2026-04-23T14:10:02.000Z` | |
| `run_id` | string | `run_20260423T141001Z` | Groups rows from one run |

On re-run, existing rows are **kept**. New rows are **appended**. A source file is considered "already done" if a row exists with matching `source_file_id` AND matching `source_md5_checksum` AND `action IN ('copied','converted')`. Any other combination (missing row, changed checksum, prior error) means it gets processed this run.

### 4.2 Global index — `_UploadPrep/_index.csv`

| Column | Example |
|---|---|
| `event_name` | `20260315-NYRR-纽半马` |
| `event_folder_id` | `1Evn...` |
| `prep_folder_id` | `1Prp...` |
| `last_run_id` | `run_20260423T141001Z` |
| `last_run_at` | `2026-04-23T14:12:33.000Z` |
| `last_run_by` | `cathy.lin@mmrunners.org` |
| `files_total` | `309` |
| `files_copied` | `269` |
| `files_converted` | `10` |
| `files_skipped` | `30` |
| `files_errored` | `0` |

Overwrite the matching row each run (keyed by `event_name`).

### 4.3 Cloud Run API — `POST /convert`

**Request headers**
- `Authorization: Bearer <user OAuth token from Apps Script>`
- `Content-Type: application/json`

**Request body**
```json
{
  "sourceFileId": "1aB2c...",
  "destFolderId": "1Prp...",
  "destName": "IMG_5001.jpg",
  "jpgQuality": 92,
  "maxDim": null,
  "bakeOrientation": true,
  "preserveExif": true
}
```

**Success response (200)**
```json
{
  "ok": true,
  "destFileId": "1xY9z...",
  "destSizeBytes": 1823456,
  "sourceMimeType": "image/heic",
  "conversionMs": 842
}
```

**Error response (4xx/5xx)**
```json
{
  "ok": false,
  "error": "unsupported_format",
  "message": "MIME type image/x-unknown-raw not supported"
}
```

Valid `error` codes: `unauthorized`, `source_not_found`, `unsupported_format`, `download_failed`, `conversion_failed`, `upload_failed`, `internal`.

---

## 5. GCP setup — full instructions (assumes basic account only)

These commands assume you have a Google account and have installed the `gcloud` CLI locally. Replace `PROJECT_ID` with your chosen project ID (must be globally unique, e.g. `mmrunners-photo-prep`). Replace `REGION` with one close to you — `us-east4` (N. Virginia) pairs well with the existing `America/New_York` timezone.

### 5.1 One-time project setup

```bash
# Install & auth (skip if already done)
# https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud auth application-default login

# Create project
export PROJECT_ID=mmrunners-photo-prep
export REGION=us-east4
gcloud projects create "$PROJECT_ID" --name="MMRunners Photo Prep"
gcloud config set project "$PROJECT_ID"

# Link billing (required for Cloud Run). Find your billing account ID:
gcloud billing accounts list
# Then:
export BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"

# Enable APIs
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  drive.googleapis.com \
  iamcredentials.googleapis.com
```

### 5.2 Create a service account for Cloud Run (runtime identity)

Cloud Run needs an identity to run under. It does **not** need Drive access itself — it uses the caller's forwarded OAuth token for Drive — but it does need the ability to log and be invoked.

```bash
gcloud iam service-accounts create photo-prep-runner \
  --display-name="Photo Prep Cloud Run runtime"

export RUNNER_SA="photo-prep-runner@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 5.3 Deploy the Cloud Run service

See Section 6 for the Python source. After you have a `cloud-run/` folder with `main.py`, `requirements.txt`, and `Dockerfile`:

```bash
cd cloud-run

gcloud run deploy image-convert \
  --source . \
  --region "$REGION" \
  --service-account "$RUNNER_SA" \
  --no-allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --max-instances 5 \
  --concurrency 4 \
  --set-env-vars="PYTHONUNBUFFERED=1"
```

Note the URL that's printed — it looks like `https://image-convert-<hash>-uc.a.run.app`. Save this as `CLOUD_RUN_URL`; Apps Script will need it.

### 5.4 Grant the Apps Script identity permission to invoke Cloud Run

Apps Script executes under the user's identity when `executeAs: "USER_ACCESSING"` (already set in `appsscript.json`). So every super admin who will run this feature needs invoke permission:

```bash
# For each super admin email:
gcloud run services add-iam-policy-binding image-convert \
  --region "$REGION" \
  --member="user:cathy.lin@mmrunners.org" \
  --role="roles/run.invoker"
```

If the super-admin list grows, repeat per user. Alternatively, grant a Google Group:

```bash
gcloud run services add-iam-policy-binding image-convert \
  --region "$REGION" \
  --member="group:photo-prep-admins@mmrunners.org" \
  --role="roles/run.invoker"
```

### 5.5 Add Cloud Run ID token scope to Apps Script manifest

Apps Script must be able to mint an ID token to call a private Cloud Run service. Edit `gas-app/appsscript.json` — add this scope to `oauthScopes`:

```
"https://www.googleapis.com/auth/cloud-platform"
```

Users will be prompted to re-consent on first use.

### 5.6 Verify

```bash
# Get an ID token for a quick smoke test (as yourself):
gcloud auth print-identity-token \
  --audiences="https://image-convert-<hash>-uc.a.run.app"

# Then:
curl -X POST "$CLOUD_RUN_URL/healthz" \
  -H "Authorization: Bearer <paste-token>"
# Expect: {"ok":true,"version":"..."}
```

---

## 6. Cloud Run service — Python (`cloud-run/`)

### 6.1 Layout

```
cloud-run/
├── Dockerfile
├── requirements.txt
├── main.py
└── README.md
```

### 6.2 `requirements.txt`

```
flask==3.0.3
gunicorn==22.0.0
requests==2.32.3
Pillow==10.4.0
pillow-heif==0.18.0
rawpy==0.23.1
numpy==2.0.1
piexif==1.1.3
```

### 6.3 `Dockerfile`

```dockerfile
FROM python:3.12-slim

# System deps for HEIF and RAW
RUN apt-get update && apt-get install -y --no-install-recommends \
    libheif1 \
    libjpeg62-turbo \
    libpng16-16 \
    libtiff6 \
    libwebp7 \
    libopenjp2-7 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PORT=8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "300", "main:app"]
```

### 6.4 `main.py` — required behavior

Implement a Flask app with two endpoints:

- `GET /healthz` — returns `{"ok": true, "version": "<git sha or date>"}`. No auth required.
- `POST /convert` — requires `Authorization: Bearer <token>` header. Behavior:

1. Parse JSON body (see §4.3).
2. Extract the user's access token from `Authorization`. Reject with 401 if missing.
3. `GET https://www.googleapis.com/drive/v3/files/{sourceFileId}?fields=id,name,mimeType,md5Checksum,size` using that token — confirms the user has access and returns metadata.
4. `GET https://www.googleapis.com/drive/v3/files/{sourceFileId}?alt=media` to download the bytes. Stream to a `tempfile.NamedTemporaryFile`.
5. Dispatch on MIME type / extension:
   - `image/jpeg` → treated as error here (Apps Script should have copied it directly; return `unsupported_format` with a clear message).
   - `image/heic`, `image/heif` → open via `pillow_heif.open_heif(...).to_pillow()`.
   - `image/png`, `image/webp`, `image/tiff`, `image/bmp`, `image/avif`, `image/gif` → `PIL.Image.open(...)`. For transparency, flatten onto white background.
   - RAW extensions (`.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, `.raf`, `.orf`, `.rw2`, `.pef`, `.srw`) → `rawpy.imread(...).postprocess()`, wrap in `Image.fromarray`.
   - Anything else → 400 `unsupported_format`.
6. EXIF handling:
   - Extract EXIF via `piexif.load(source_bytes)` when possible (Pillow's `.info['exif']` also works for most).
   - If `bakeOrientation` (always true in v1): apply `ImageOps.exif_transpose(img)` to rotate pixels, then set EXIF `Orientation` tag to `1`.
   - If `preserveExif`: write EXIF back when saving with `exif=<bytes>`. If source has no EXIF (e.g. RAW post-convert), skip silently.
7. If `maxDim` is set (not in v1): `img.thumbnail((maxDim, maxDim), Image.LANCZOS)`.
8. Save as JPG: `img.convert("RGB").save(tmp_out, "JPEG", quality=jpgQuality, optimize=True, exif=exif_bytes_or_b"")`.
9. Upload to Drive:
   - Multipart upload to `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` with metadata `{"name": destName, "parents": [destFolderId], "mimeType": "image/jpeg"}` and the JPG bytes. Use the same user token.
   - Capture the returned `id`.
10. Return success JSON (see §4.3).
11. On any exception, log with `logging.exception(...)`, return 500 with appropriate `error` code.

**Important implementation notes:**
- Do **not** cache files on disk between requests. Use `tempfile.TemporaryDirectory()` and clean up in `finally`.
- Cloud Run instance memory is 2Gi — RAW files can be 50–80 MB decoded to 200+ MB as numpy arrays. Release references promptly.
- Set `Pillow`'s `Image.MAX_IMAGE_PIXELS = None` at startup to avoid DecompressionBomb warnings on legitimate large files.
- `pillow_heif.register_heif_opener()` must be called once at module import.
- Log every request with request ID, source file ID, source MIME, duration, result.

### 6.5 Redeploy on code changes

```bash
cd cloud-run
gcloud run deploy image-convert --source . --region "$REGION"
```

---

## 7. Apps Script module (`gas-app/src/`)

### 7.1 File additions

| File | Purpose |
|---|---|
| `src/config/superAdmins.ts` | Email allowlist + `CLOUD_RUN_URL` constant |
| `src/services/uploadPrepService.ts` | Core orchestration logic |
| `src/services/cloudRunClient.ts` | Wrapper around UrlFetchApp for the convert service |
| `src/services/manifestService.ts` | Read/write per-event manifest CSV + global index CSV |
| `src/routes/uploadPrepRoutes.ts` | HTTP endpoints called by the sidebar |
| `src/ui/templates/uploadPrepSidebar.html` | UI for event selection + progress |
| `src/ui/js/uploadPrepSidebar.js` | Client-side JS for the sidebar |
| `tests/uploadPrepService.test.ts` | Jest tests (mock Drive + UrlFetchApp) |

Register the new routes in `src/routes/router.ts` and add a menu entry in `main.ts`.

### 7.2 `src/config/superAdmins.ts`

```typescript
export const SUPER_ADMINS: readonly string[] = [
  'cathy.lin@mmrunners.org',
  // Add more as needed
] as const;

export const CLOUD_RUN_URL = 'https://image-convert-<hash>-uc.a.run.app';

export const UPLOAD_PREP_ROOT_NAME = '_UploadPrep';
export const MANIFEST_FILENAME = '_manifest.csv';
export const INDEX_FILENAME = '_index.csv';

export const JPG_QUALITY_DEFAULT = 92;

export const FORMAT_POLICY = {
  copy: new Set(['image/jpeg']),
  convert: new Set([
    'image/png', 'image/heic', 'image/heif', 'image/tiff',
    'image/webp', 'image/bmp', 'image/avif', 'image/gif',
  ]),
  // RAW is dispatched by extension since Drive often gives 'application/octet-stream'
  convertByExt: new Set([
    'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
  ]),
  skipByPrefix: ['video/', 'audio/'],
  skipByExt: new Set([
    'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', '3gp', 'm4v',
    'mp3', 'wav', 'flac',
    'pdf', 'doc', 'docx', 'zip', 'rar', '7z',
  ]),
};
```

### 7.3 `src/services/uploadPrepService.ts` — required functions

```typescript
export interface PrepEventRequest {
  eventFolderId: string;
  dryRun?: boolean;    // default false
  force?: boolean;     // default false — bypass incremental skip
}

export interface PrepEventResult {
  runId: string;
  eventName: string;
  counts: { total: number; copied: number; converted: number; skipped: number; errored: number };
  durationMs: number;
}

// Main entry point called by the route handler.
// Pipeline:
//  1. assertSuperAdmin()
//  2. Resolve event folder + ensure _UploadPrep/<EventName>/ exists
//  3. Load (or create) per-event manifest into a Map keyed by source_file_id
//  4. List source files (pages of 100 via Drive API)
//  5. For each file:
//       a. Classify: copy | convert | skip
//       b. If not force and manifest has matching (file_id + md5), skip (already done)
//       c. Resolve dest_name with collision check against manifest + existing files
//       d. Execute: DriveApp.getFileById(src).makeCopy(destName, destFolder)  (copy case)
//          or  cloudRunClient.convert(...)                                     (convert case)
//          or  record skip row
//       e. Append manifest row (in-memory)
//  6. Write manifest.csv back to Drive
//  7. Upsert _index.csv row
//  8. Return counts
export function prepareEventForUpload(req: PrepEventRequest): PrepEventResult;

// Enumerates subfolders of SSOT root. Excludes _UploadPrep itself.
export function listEventFolders(): Array<{ id: string; name: string }>;

// Fast stats for the UI before a run:
export function getEventPrepStatus(eventFolderId: string): {
  eventName: string;
  sourceFileCount: number;
  alreadyPreppedCount: number;
  newOrChangedCount: number;
  lastRunAt?: string;
};
```

### 7.4 `src/services/cloudRunClient.ts`

```typescript
import { CLOUD_RUN_URL } from '../config/superAdmins';

export interface ConvertRequest {
  sourceFileId: string;
  destFolderId: string;
  destName: string;
  jpgQuality: number;
  maxDim: number | null;
  bakeOrientation: boolean;
  preserveExif: boolean;
}

export interface ConvertResponse {
  ok: boolean;
  destFileId?: string;
  destSizeBytes?: number;
  sourceMimeType?: string;
  conversionMs?: number;
  error?: string;
  message?: string;
}

export function convertImage(req: ConvertRequest): ConvertResponse {
  const idToken = ScriptApp.getIdentityToken(); // for Cloud Run IAM
  const userToken = ScriptApp.getOAuthToken();  // for Drive API inside Cloud Run

  const res = UrlFetchApp.fetch(`${CLOUD_RUN_URL}/convert`, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      // Cloud Run IAM: requires an ID token
      'X-Cloud-Run-Auth': `Bearer ${idToken}`,
      // Drive API inside the service: user's access token
      'Authorization': `Bearer ${userToken}`,
    },
    payload: JSON.stringify(req),
    muteHttpExceptions: true,
  });

  // Cloud Run enforces IAM at the edge — it reads Authorization by default.
  // Since we need Authorization for Drive, send the ID token on a custom header
  // and have main.py honor either. Alternatively, use --allow-unauthenticated
  // and enforce ID-token-in-custom-header ourselves. See §7.6.

  return JSON.parse(res.getContentText()) as ConvertResponse;
}
```

> **Auth subtlety**: Cloud Run's built-in IAM check reads the `Authorization` header and expects a Google-signed ID token. We need `Authorization` for the *user's* Drive token. Two ways to resolve:
>
> **(Recommended)** Deploy with `--no-allow-unauthenticated` and send the ID token in `Authorization`, the user token in a custom header like `X-User-Access-Token`. Update Python accordingly. *This means §4.3 above is revised: user token lives in `X-User-Access-Token`, ID token in `Authorization`.*
>
> **(Simpler, less secure)** Deploy with `--allow-unauthenticated` and enforce a shared secret or ID-token-verify-ourselves in `main.py`. Avoid if possible.
>
> Go with the recommended approach. Update the Cloud Run spec in §4.3 and §6.4 step 2 accordingly: read Drive token from `X-User-Access-Token`.

### 7.5 `src/services/manifestService.ts` — required functions

```typescript
export interface ManifestRow { /* matches §4.1 columns */ }
export interface IndexRow    { /* matches §4.2 columns */ }

export function loadManifest(prepFolderId: string): ManifestRow[];
export function writeManifest(prepFolderId: string, rows: ManifestRow[]): void;
export function upsertIndex(indexFolderId: string, row: IndexRow): void;
```

- Use a proper CSV writer/parser — quote fields containing commas/quotes/newlines, escape embedded quotes by doubling.
- Event folder names may contain Chinese characters and spaces. Write file as UTF-8 with BOM so Excel opens it correctly.
- Use `Utilities.newBlob(csvText, 'text/csv', filename)` and overwrite existing file via `DriveApp.getFileById(...).setContent(...)`; create if missing.

### 7.6 `src/routes/uploadPrepRoutes.ts`

Expose (as callable from `google.script.run`):
- `uploadPrep_listEvents()` → `Array<{id, name}>`
- `uploadPrep_getStatus(eventFolderId)` → status stats
- `uploadPrep_run(eventFolderId, options)` → streams progress (see below) and returns final counts

**Progress streaming**: Apps Script doesn't support true streaming. Use `PropertiesService.getUserProperties()` or a `CacheService` key to store a progress counter (`run_<runId>_done`, `run_<runId>_total`) updated every N files. The sidebar polls `uploadPrep_getProgress(runId)` every 2s.

Every handler must first call `assertSuperAdmin()`:

```typescript
function assertSuperAdmin(): void {
  const email = Session.getEffectiveUser().getEmail();
  if (!SUPER_ADMINS.includes(email)) {
    throw new Error('Forbidden: super admin only');
  }
}
```

### 7.7 Sidebar UI

Minimal UI:
- Dropdown of events (sorted by name desc)
- Below the dropdown: live stats (source count, already prepped, new/changed)
- Checkbox: "Force re-process all files"
- Checkbox: "Dry run"
- Button: **Run**
- Progress bar + log area during run
- Final summary card with link to the generated `_UploadPrep/<EventName>/` Drive folder

### 7.8 Menu wiring — `src/main.ts`

Add to `onOpen` (or wherever menus are built):

```typescript
const email = Session.getEffectiveUser().getEmail();
if (SUPER_ADMINS.includes(email)) {
  ui.createMenu('Super Admin')
    .addItem('Prep Upload Files…', 'showUploadPrepSidebar')
    .addToUi();
}
```

---

## 8. Edge cases and required behaviors

- **Chinese / Unicode folder names**: All file + folder name handling must be UTF-8 clean end-to-end. CSV writes must include BOM. URL encoding must use `encodeURIComponent`.
- **Filename collisions across subfolders**: Although the current SSOT is flat per event, future additions may not be. Collision policy applies whenever the resolved `destName` already exists in the manifest *or* in the dest folder.
- **Stem conflict with extension change**: If SSOT has both `IMG_5001.JPG` and `IMG_5001.HEIC`, the JPG copy keeps `IMG_5001.jpg` (lowercased); the HEIC conversion becomes `IMG_5001__2.jpg`. Manifest makes this traceable.
- **Live Photos (`IMG_5001.HEIC` + `IMG_5001.MP4`)**: HEIC is converted, MP4 is skipped with `skip_reason=video`. Both rows are in the manifest.
- **Already-JPG with uppercase extension (`.JPG`)**: Dest name always lowercases the extension to `.jpg`.
- **Zero-byte or corrupt source**: Cloud Run returns `conversion_failed`; Apps Script records `action=error` with the message. Run continues.
- **Cloud Run cold start**: First request in a run may take 15–30s. That's fine; show a spinner.
- **Cloud Run timeout**: Set to 300s, enough for a ~100 MB RAW file. If larger files appear, bump `--timeout` and `--memory`.
- **Apps Script 6-minute execution limit**: A single `uploadPrep_run` call processing hundreds of files will exceed this. Implement **chunked processing** — the handler processes up to `BATCH_SIZE=50` files and returns a "continuation token" (next page token + run ID). The sidebar JS loops `uploadPrep_runBatch(...)` until done. Keep run state in `CacheService` (6h TTL).
- **Idempotent resume**: If a run is interrupted, re-running with the same event (no `force`) picks up where it left off naturally — manifest skip logic handles it.
- **Google Docs / Sheets files in the event folder**: Skipped with `skip_reason=not_an_image` (MIME starts with `application/vnd.google-apps`).
- **Hidden files** (starting with `.` or `_`): Skipped with `skip_reason=not_an_image` if they're not images. The `_UploadPrep` folder itself must be excluded from source enumeration by ID, not by name.
- **The SSOT root folder ID** must be configurable — store it in `src/config/constants.ts` (it likely exists already). If not, add `SSOT_ROOT_FOLDER_ID`.

---

## 9. Testing checklist

Implementer must verify before marking done:

- [ ] `gcloud run services list` shows `image-convert` running.
- [ ] `curl $CLOUD_RUN_URL/healthz` with a valid ID token returns `{"ok":true}`.
- [ ] Apps Script menu shows **Super Admin → Prep Upload Files…** only for emails in `SUPER_ADMINS`.
- [ ] Non-super-admins cannot call `uploadPrep_run` directly (server-side assertion still trips).
- [ ] Dry run against the sample event `20260315-NYRR-纽半马` produces a manifest with 309 rows, 269 `would_copy`, 10 `would_convert`, 30 `would_skip`, and creates no files.
- [ ] Real run against the same event produces 269 copied JPGs and 10 converted JPGs in `_UploadPrep/20260315-NYRR-纽半马/`.
- [ ] Re-running immediately with no changes yields zero work: `copied=0, converted=0, skipped=309` (skip reason `already_prepped` — add this skip_reason in the incremental path).
- [ ] Converted HEIC is visually correct, rotated upright, and has an EXIF `DateTimeOriginal` matching the source.
- [ ] A synthetic PNG with transparency converts to a JPG with white background, not black.
- [ ] A synthetic RAW file (e.g. `.dng` sample) converts successfully.
- [ ] Filename collision: two sources with same stem different ext both appear with `__2` suffix on the second.
- [ ] Unicode: event folder `20260315-NYRR-纽半马` works end-to-end; manifest opens correctly in Excel and Google Sheets.
- [ ] Jest tests pass (`npm test` in `gas-app/`).
- [ ] `gas-app/.gitignore` is unchanged; `_UploadPrep` is only in Drive, not in the repo.

---

## 10. Implementation order (suggested)

1. Cloud Run service — build `main.py`, `Dockerfile`, deploy, verify `/healthz` and `/convert` work against a hand-picked HEIC file using `curl`.
2. Apps Script config + `cloudRunClient.ts` — verify end-to-end conversion of one file triggered from the Apps Script IDE.
3. `manifestService.ts` — write/read CSV round-trip test.
4. `uploadPrepService.ts` — classification + orchestration, no UI yet. Test via Apps Script IDE with hard-coded event ID.
5. Chunked/resumable execution for 6-min limit.
6. Routes + sidebar UI.
7. Menu wiring + super-admin gating.
8. Jest tests.
9. Full end-to-end test against the sample event.

---

## 11. Known non-goals (v1)

- Resizing to meet face-detection app limits (size limits unknown; add later via `maxDim`).
- Automatic upload to the face-detection app itself (manual upload per requirement).
- Multi-event batch runs.
- Running outside Google Drive (e.g., local CLI).
- Deleting UploadPrep files when source is deleted (no mirror mode in v1).
- Non-super-admin self-service prep.

---

## 12. Source format cheat sheet

| Source | MIME | Extensions | Handler |
|---|---|---|---|
| JPEG | `image/jpeg` | `.jpg .jpeg` | Apps Script copy |
| PNG | `image/png` | `.png` | Cloud Run (flatten transparency) |
| HEIC/HEIF | `image/heic`, `image/heif` | `.heic .heif` | Cloud Run (pillow-heif) |
| TIFF | `image/tiff` | `.tif .tiff` | Cloud Run |
| WEBP | `image/webp` | `.webp` | Cloud Run (first frame if animated) |
| BMP | `image/bmp` | `.bmp` | Cloud Run |
| GIF | `image/gif` | `.gif` | Cloud Run (first frame) |
| AVIF | `image/avif` | `.avif` | Cloud Run |
| Canon RAW | octet-stream | `.cr2 .cr3` | Cloud Run (rawpy) |
| Nikon RAW | octet-stream | `.nef` | Cloud Run (rawpy) |
| Sony RAW | octet-stream | `.arw` | Cloud Run (rawpy) |
| Adobe DNG | octet-stream | `.dng` | Cloud Run (rawpy) |
| Fuji RAW | octet-stream | `.raf` | Cloud Run (rawpy) |
| Olympus RAW | octet-stream | `.orf` | Cloud Run (rawpy) |
| Panasonic RAW | octet-stream | `.rw2` | Cloud Run (rawpy) |
| Pentax RAW | octet-stream | `.pef` | Cloud Run (rawpy) |
| Samsung RAW | octet-stream | `.srw` | Cloud Run (rawpy) |
| Video | `video/*` | many | **Skip** |
| Audio | `audio/*` | many | **Skip** |
| PDF / docs / archives | various | `.pdf .doc* .zip .rar .7z` | **Skip** |
| Google-native | `application/vnd.google-apps.*` | — | **Skip** |

---

## 13. References for the implementer

- Google Drive v3 API — files list/get/download/copy/upload: https://developers.google.com/drive/api/reference/rest/v3/files
- Cloud Run from Apps Script (auth): https://cloud.google.com/run/docs/authenticating/service-to-service
- `ScriptApp.getIdentityToken()` and `ScriptApp.getOAuthToken()`: https://developers.google.com/apps-script/reference/script/script-app
- pillow-heif docs: https://pillow-heif.readthedocs.io/
- rawpy docs: https://letmaik.github.io/rawpy/api/
- Pillow EXIF handling: https://pillow.readthedocs.io/en/stable/reference/ExifTags.html

---

**End of specification.** If anything here is ambiguous, ask Cathy before inventing behavior.
