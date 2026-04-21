# MM Runners Photo Archive — User Guide

**Version**: 2.2 | **Last Updated**: April 2026

---

## Quick Start

### Sign In
All users sign in with Google OAuth. After first login, users are authorized in the Users sheet by an administrator.

### For End Users
1. **Upload photos**: Dashboard → Upload Photos → select event → choose files → 4-step flow
2. **View photos**: Dashboard → Browse Drive to see organized folders in Google Drive
3. **Share albums**: Contact admin for Google Photos album links (auto-created per event)

### For Administrators
1. **Create events**: Events → New Event (generates YYYY-MM-DD_EventName folder automatically)
2. **Manage users**: Users → Add/Edit/Deactivate users and assign roles
3. **Manage clubs**: Clubs → Add/Edit/Deactivate running clubs
4. **View reports**: Summary → upload stats by event/club, violations, export CSV

---

## System Architecture

### Three-Level Folder Structure (Google Drive)

```
📁 MM Runners Photo Archive
├── 📁 YYYY-MM-DD_EventName          (Level 1: Event, admin creates)
│   ├── 📁 ClubName                  (Level 2: Club, auto-created on first upload)
│   │   └── 📁 YYYYMMDD-HHMMSS_user  (Level 3: Batch, auto-generated per session)
│   │       ├── photo1.jpg
│   │       └── photo2.jpg
│   └── 📁 AnotherClub
│       └── ...
└── 📁 2025-10-30_Another_Event
    └── ...
```

### Folder Naming Rules

| Layer | Pattern | Example | Validated |
|-------|---------|---------|-----------|
| Event (L1) | `YYYY-MM-DD_Title_Case_Name` | `2025-11-03_NYC_Marathon` | ✅ Strict |
| Club (L2) | Must match approved club in Clubs sheet | `New_Bee` | ✅ Strict |
| Batch (L3) | `YYYYMMDD-HHMMSS_username` | `20251103-093500_cathylin` | Auto-generated |
| Files (L4+) | Original filename preserved | `DSC_0042.jpg` | Type-check only |

---

## User Roles & Permissions

| Role | Permissions |
|------|-------------|
| **admin** | Full access: manage users/clubs/events, view reports, reconcile uploads |
| **user** | Upload photos, browse events, view club folder |
| **api_client** | Programmatic REST API access (no web UI) |

---

## Photo Upload (4-Step Flow)

### Step 1: Select Event
Choose an event from the card grid. Use date filter to narrow list if needed.

### Step 2: View Club Folder
See existing batch folders for your club at this event (read-only). Click **Continue** to proceed.

### Step 3: Choose Files
- **Supported types**: JPEG, PNG, HEIC only
- **File limits**: 50 MB per file, 200 MB per batch
- **Duplicates**: System detects by filename + size; choose skip or overwrite

### Step 4: Results Summary
```
✅ Uploaded: N photos, X MB
⏭️ Skipped duplicates: N
🚫 Skipped non-photos: N
```

Photos automatically sync to Google Photos albums (event + club albums).

---

## Admin Tasks

### Event Management

**Create event:**
1. Events → New Event
2. Enter name (e.g., "Boston Marathon")
3. Select date
4. System generates folder name `YYYY-MM-DD_Event_Name` and creates Drive folder + Google Photos album

**Edit event:**
- Click edit icon → update name or date (folder name is immutable)

**Check for violations:**
- Events page scans Level 1-2 for naming violations
- Orange banner appears if violations found; click **View Details** to see and fix

### User Management

**Add user:**
1. Users → Add User
2. Enter email, select club, choose role (admin/user/api_client)
3. User can sign in immediately

**Edit user:** Click edit icon → update club or role

**Deactivate user:** Click deactivate icon → user cannot sign in (history preserved)

**Bulk import:** Paste rows into Users sheet with columns: email, running_club, role, status, added_date, added_by

### Club Management

**Add club:**
1. Clubs → Add Club
2. Display Name: human-readable (e.g., "New Bee Runners")
3. Normalized Name: folder name (e.g., "New_Bee") — must match regex `[A-Za-z][A-Za-z0-9]*(_[A-Za-z][A-Za-z0-9]*)*`

**Edit club:** Click edit icon → update names (existing Drive folders unchanged)

**Deactivate club:** Click deactivate icon → club removed from upload/user-registration dropdowns (folders preserved)

### Reconciliation & Reporting

**Summary Dashboard:**
1. Summary → Select date range
2. View tables: uploads by event/club, events with zero uploads, naming violations
3. **Export CSV**: Download full report
4. **Exception Email**: Send violations report to admin email

---

## Data Model (Google Sheets)

### Users Sheet
| email | running_club | role | status | added_date | added_by |
|-------|-------------|------|--------|------------|---------|

### Events Sheet
| event_id | event_name | event_date | folder_name | drive_folder_id | created_by | created_at |
|----------|-----------|-----------|------------|-----------------|-----------|----------|

### Upload_Log Sheet
| log_id | event_id | club_name | uploaded_by | batch_folder_name | batch_folder_id | file_count | total_size_mb | skipped_duplicates | skipped_non_photo | upload_timestamp | source |
|--------|----------|----------|------------|------------------|-----------------|-----------|---------------|-------------------|------------------|------------------|--------|

### Clubs Sheet
| display_name | normalized_name | status | created_date |
|-------------|-----------------|--------|--------------|

### Photos_Albums Sheet (v1.x)
| albumId | albumType | eventId | clubName | albumTitle | albumUrl | shareableUrl | createdAt | lastSyncAt | syncedFileCount |
|---------|-----------|---------|----------|-----------|----------|-------------|-----------|-----------|-----------------|

---

## Google Photos Albums

**Auto-created per event:**
- **Event album**: Contains all clubs' photos for the event (created when event is created)
- **Club album**: Contains one club's photos for the event (created on first upload from that club)

**Sync timing:**
- Event creation → event album created
- First club upload → club album created
- Each upload completion → photos pushed to both albums

**Share albums:**
- Contact admin for shareable links
- Or run `serverGetEventAlbums({ eventId: "<eventId>" })` in GAS editor

**Manual sync (admin):**
- `serverSyncAlbum({ eventId: "<eventId>" })` — sync one event
- `serverBackfillAlbums({})` — sync all events (idempotent; safe to re-run)

---

## REST API (Partner Organizations)

### Prerequisites
- Registered as `api_client` user
- Receive: Web App URL + API key (your registered email)

### Authentication
Pass API key as query parameter: `?api_key=your.email@partnerorg.com`

### Rate Limit
60 requests per hour per API key

### Endpoints

**Check folder** (GET):
```
GET {BASE_URL}?action=api_check_folder&event_folder_name=2025-11-03_NYC_Marathon&api_key=...
```
Response: `{ status, code, data: { folderId, exists } }`

**List files** (GET):
```
GET {BASE_URL}?action=api_list_files&folder_id=DRIVE_FOLDER_ID&api_key=...
```
Response: `{ status, code, data: [ { name, size, mimeType, modifiedTime }, ... ] }`

**Upload file** (POST):
```
POST {BASE_URL}?action=api_upload_file&api_key=...
Body: { eventId, clubName, fileName, mimeType, base64Data }
```
Response: `{ status, code, data: { fileId, batchFolderName } }`

### Error Codes
| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request |
| 403 | Forbidden (invalid API key) |
| 404 | Not found |
| 409 | Duplicate file |
| 415 | Unsupported file type |
| 429 | Rate limit exceeded |
| 500 | Server error |

**Example client**: See `example/partner-client.gs` in repository

---

## Troubleshooting

### Login Issues
| Error | Solution |
|-------|----------|
| "Your account is not registered" | Contact admin to add your email to Users sheet |
| "Your account has been deactivated" | Contact admin to reactivate |
| "Authorization required" after deployment | Reopen app; Google will prompt for new OAuth scopes; click Allow |

### Upload Issues
| Error | Solution |
|-------|----------|
| "Unsupported file type" | Use JPEG, PNG, or HEIC only |
| "File too large" | File must be ≤50 MB; batch ≤200 MB |
| "Duplicate detected" | Choose skip or overwrite; or check club folder history |
| Upload fails mid-process | Retry; some files may have uploaded partially |

### Event/Folder Issues
| Error | Solution |
|-------|----------|
| Event not visible in picker | Admin must create event first |
| Naming violation banner | Manually rename or delete violating folders in Drive; refresh |
| Event created but album not created | Run `serverSyncAlbum({ eventId })` in GAS editor |
| Photos uploaded but not in album | Run `serverSyncAlbum({ eventId })` to retry sync |

### API Issues
| Error | Solution |
|-------|----------|
| "Invalid API key" (403) | Verify key is your registered email |
| "Rate limit exceeded" (429) | Wait 1 hour for counter to reset |
| `api_check_folder` returns `exists: false` | Create event via admin UI first |

---

## Maintenance & Support

### For Administrators
- **Deployment**: See `gas-app/SETUP.md`
- **User on-boarding**: Add to Users sheet (email, club, role)
- **Event setup**: Create events before users upload
- **Monitoring**: Review Summary dashboard regularly for violations and activity

### GAS Functions (Admin)
```javascript
// Sync specific event to Google Photos
serverSyncAlbum({ eventId: "<eventId>" })

// Sync all events (idempotent)
serverBackfillAlbums({})

// Get album links for an event
serverGetEventAlbums({ eventId: "<eventId>" })
```

### Reporting
- Upload stats: Summary → select date range → view/export
- Violations: Summary → "Naming violations" section → click "Send Exception Email"
- CSV export: Summary → "Export CSV"

---

## Contact

**System Administrator**: cathy.lin@mmrunners.org  
**Email**: admin@mmrunners.org

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.2 | Apr 2026 | Phase 6: Google Photos albums; consolidated documentation |
| 2.1 | Mar 2026 | REST API, rate limiting, cross-org access |
| 2.0 | Feb 2026 | Admin summary, reconciliation, violation scanning |
| 1.0 | Jan 2026 | Core: upload, user management, club management |
