# MM Runners Photo Archive — Features & Roadmap

**System**: 湘舍动公益文件系统 / MM Runners Photo Archive  
**Version**: 1.0 (GAS)  
**Last Updated**: April 2026  
**Status**: All 5 phases complete

---

## Part 1 — Implemented Features (v1.0)

### 1.1 Authentication & Authorization

| Feature | Description |
|---------|-------------|
| Google OAuth single sign-on | Users log in with their existing Google account — no separate registration, no password management |
| Role-based access control | Three roles: `admin` (full access), `user` (upload + browse), `api_client` (programmatic REST access only) |
| Session-based auth | Every request checks the GAS session for the active Google account; no tokens to manage client-side |
| Inactive account blocking | Deactivated users are denied access at login time; they see a clear error message with instructions to contact admin |
| Admin self-service UI | All user and club management is done through the web interface — no manual spreadsheet editing required after initial setup |

### 1.2 User Management (Admin)

| Feature | Description |
|---------|-------------|
| Add users | Admin fills in email, running club, and role; record is written to the Users sheet immediately |
| Email normalization | User emails are stored and matched case-insensitively (normalized to lowercase) |
| Edit users | Admin can update a user's running club or role at any time |
| Deactivate users | Deactivating blocks login without deleting the user's history; deactivated users are shown grayed-out in the table |
| Reactivate users | Deactivated users can be reactivated in one click |
| Paginated user list | The user table paginates to keep the page responsive for large user bases |
| Bulk onboarding | For large batches, rows can be pasted directly into the Users sheet following the column order |

### 1.3 Club Management (Admin)

| Feature | Description |
|---------|-------------|
| Clubs sheet | An admin-managed `Clubs` sheet is the live source of truth for approved running clubs |
| Auto-seeding | On first run, the system seeds the Clubs sheet from the built-in default list (New Bee, Misty Mountain, Nankai, Admin) |
| Add clubs | Admin can add new clubs via the Admin UI — display name + normalized folder name |
| Edit clubs | Admin can update a club's display name or normalized name |
| Deactivate / reactivate clubs | Deactivated clubs no longer appear in upload and registration selectors; history is preserved |
| Normalized name validation | Normalized names must match the pattern `[A-Za-z][A-Za-z0-9]*(_[A-Za-z][A-Za-z0-9]*)*` — safe for use as Drive folder names |

### 1.4 Event Management (Admin)

| Feature | Description |
|---------|-------------|
| Create events | Admin enters a name and date; the system generates the folder name (`YYYY-MM-DD_Event_Name`) and creates the Drive folder automatically |
| Folder name preview | As the admin types, a real-time preview shows the exact folder name that will be created in Drive |
| Duplicate prevention | If an event with the same folder name already exists, creation is blocked with a clear error message |
| Edit events | Admin can update the display name or date (the Drive folder name is immutable once created) |
| Sortable event list | Events are listed newest-first by default; clicking the date column header toggles ascending/descending order |
| Date range filter | Admins can filter the event list by date range |
| Direct Drive links | Each event row has a folder icon that opens the Google Drive folder in a new browser tab |
| No delete | Events are never deleted — they may have upload history attached. Events can be effectively "closed" by deactivating the associated club folders |

### 1.5 Photo Upload (All Users)

| Feature | Description |
|---------|-------------|
| 4-step guided upload flow | Step 1: select event → Step 2: view existing club folder → Step 3: choose files → Step 4: results summary |
| Event picker with date filter | Users see a card grid of events; a date range filter helps narrow the list for large event counts |
| Club folder view (read-only) | Before uploading, users see what their club has already uploaded to the selected event |
| Multi-file selection | Browser file picker supports selecting multiple files in a single action |
| File type filtering | Only JPEG, PNG, and HEIC files are accepted; other types (PDF, video, RAW) are silently skipped and counted in the summary |
| File size limit | 50 MB per file; 200 MB per upload session. Oversized files are flagged before upload begins |
| Duplicate detection | Each file is compared against all existing files in the club's event folder by filename and byte size; exact matches are flagged |
| Duplicate resolution | Detected duplicates are shown to the user; the user can choose to skip or overwrite each one |
| Automatic batch folder | Every upload session creates a new Layer 3 folder: `YYYYMMDD-HHMMSS_username` |
| Original filenames preserved | Files are uploaded flat into the batch folder with original names unchanged |
| Per-file progress | Upload progress is shown file-by-file; the button is disabled during upload to prevent double submission |
| Upload summary screen | After completion, the user sees: photos uploaded, total size, duplicates skipped, non-photo files skipped |

### 1.6 Upload Logging

| Feature | Description |
|---------|-------------|
| Upload_Log sheet | Every upload session writes one record: event ID, club, uploader, batch folder name/ID, file count, total size, skip counts, timestamp, source |
| Source tracking | Records whether the upload came from the web app (`web_app`) or the REST API (`api`) |
| Immutable log | Upload log entries are append-only; no editing or deletion |
| Admin-visible | All upload logs are visible to admins in the Summary dashboard and directly in the Google Sheet |

### 1.7 Admin Summary & Reconciliation Dashboard

| Feature | Description |
|---------|-------------|
| Date range picker | Admin selects a date range; all summary data filters accordingly |
| Upload stats by event | For each event in the range: list of clubs that uploaded, photo count, total size |
| Events with no uploads | A separate "attention list" highlights events that have zero upload activity |
| Folder naming violations | Scans Layer 1 and Layer 2 of the Drive hierarchy for naming convention violations; lists them with folder name and violation type |
| CSV export | The full summary can be exported as a CSV file |
| Exception email alerts | Admin can trigger an email to themselves (and optionally other addresses) when violations are detected |

### 1.8 Folder Naming Enforcement

| Feature | Description |
|---------|-------------|
| Layer 1 validation | Event folders must match `YYYY-MM-DD_Title_Case_Name`; the date portion is validated as a real calendar date |
| Layer 2 validation | Club folders must match an approved club name from the Clubs sheet |
| Layer 3 auto-generation | Upload batch folders are always auto-generated; users cannot name them |
| Violation scanning | `scanLayer1Violations()`, `scanLayer2Violations()`, `scanAllViolations()` — called on-demand from the Summary dashboard and the Events page |
| Violations banner | The Admin Events page shows an orange warning banner if any violations are detected in the background scan |

### 1.9 Cross-Organization REST API

| Feature | Description |
|---------|-------------|
| `api_check_folder` (GET) | Given an event folder name, returns the Drive folder ID or `null` |
| `api_list_files` (GET) | Given a Drive folder ID, returns a JSON list of files (name, size, MIME type, modified date) |
| `api_upload_file` (POST) | Accepts a base64-encoded photo + metadata (event ID, club name); runs the full validation and duplicate-check pipeline; logs to Upload_Log |
| API key authentication | API key is passed as the `?api_key=` query parameter (GAS Web Apps cannot read HTTP headers); the key is the api_client user's email address |
| Rate limiting | Each API key is limited to 60 requests per hour; the counter is tracked in the `Rate_Limit` sheet using a fixed-window approach |
| Standard error responses | All API responses follow `{ status, code, message, data }` — consistent HTTP-style codes (200, 400, 403, 409, 415, 429, 500) |
| Partner client example | A ready-to-use GAS client script (`example/partner-client.gs`) is included for partner organizations to copy and configure |

---

## Part 2 — Future Features Wishlist (v2 and Beyond)

The following features are not in v1 due to technical constraints of Google Apps Script, scope, or complexity. They are strong candidates for a planned v2 migration to Node.js + Firebase.

### 2.1 High Priority

| Feature | Value | Notes |
|---------|-------|-------|
| **EXIF-based duplicate detection** | Prevents true duplicates even when filenames differ (e.g., after camera-roll renaming) | Requires reading image binary data; GAS 50 MB payload limit makes this impractical in v1 |
| **RAW photo format support** | Allows professional photographers to upload CR2, ARW, NEF files | Storage and preview costs are significant; needs admin-configurable per-event toggle |
| **Thumbnail preview in file browser** | Users can visually confirm uploads before and after; admins can spot check folders | GAS HtmlService can serve Drive thumbnail URLs; proof-of-concept feasible in v1 but slow |
| **Advanced admin user audit log** | Track all admin actions (who added/edited/deactivated whom and when) | Append-only audit sheet; straightforward to add in v1 |
| **Scheduled folder violation scans** | Catch naming violations proactively instead of only on manual request | GAS time-based triggers can run daily; add a dedicated Violations sheet for persistence |

### 2.2 Medium Priority

| Feature | Value | Notes |
|---------|-------|-------|
| **Batch download for admins** | Admin can download all photos for a specific event/club as a ZIP | Google Drive Folder download API; can be triggered from the Summary dashboard |
| **Photo search and tagging** | Users can search by filename; admins can add event-level tags visible to all users | Requires a Tags sheet or Firestore; natural fit for v2 |
| **Event archival / soft delete** | Allows admins to mark old events as archived, hiding them from active views without losing data | Add `status` column to Events sheet; filter archived events in the UI |
| **Multi-admin notifications** | Exception emails go to a configurable list of admin addresses, not just the requesting admin | Add a `notification_emails` config to Script Properties |
| **Upload progress for large batches** | Show real-time progress across the entire batch (e.g., "3 of 12 files uploaded") | Current implementation updates per-file; aggregate progress bar is a UI enhancement |
| **Reactivate events** | Allow admins to "re-open" an event for additional uploads after it was considered complete | UI toggle; no Drive changes needed |

### 2.3 Longer-Term (v2 Migration)

| Feature | Value | Notes |
|---------|-------|-------|
| **Node.js + Firebase migration** | Removes GAS execution time limits, enables background jobs, webhooks, and better query performance | Naming conventions, folder structure, and all business logic stay the same |
| **Firestore database** | Replace Google Sheets as the database for better query speed and real-time updates at scale | Migration path: export Sheets CSV → import to Firestore |
| **Webhook notifications** | Push notifications to Slack/email when uploads complete, violations are detected, or quota limits are approached | GAS has no outbound webhooks; requires Node.js + Cloud Functions |
| **Nested folder import from external Drive** | Allow partner orgs to share a Drive folder and have the system import its structure automatically | Complex tree traversal; natural fit for Node.js |
| **Video support** | Extend the upload pipeline to accept MP4/MOV | Storage and processing costs need a separate design; GAS 50 MB payload limit is a blocker in v1 |
| **Mobile-optimized upload** | A lightweight mobile UI or PWA for uploading directly from a phone's camera roll | Current UI is responsive but not optimized for touch; revisit in v2 |
| **Multi-organization support** | Host one system with separate tenants for different running organizations | Requires tenant isolation in Drive and Sheets; architectural change for v2 |
| **Photo analytics dashboard** | Charts showing upload trends by club, event, and time period | Aggregate queries are slow in Sheets; Firestore + BigQuery is the right stack |
| **Service account OAuth for API clients** | Replace email-as-API-key with proper OAuth 2.0 service accounts for partner organizations | More secure; requires partner org to create a GCP service account |

---

## Summary

**v1.0 is feature-complete.** All 5 planned phases have been implemented and tested (≥85% code coverage across all modules). The system is production-ready for the current scale of the MM Runners organization.

The next major investment is the **v2.0 migration** to Node.js + Firebase, which will unlock background processing, webhooks, and better performance at scale while keeping all existing folder conventions and user workflows intact.
