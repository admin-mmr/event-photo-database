# MM Runners Photo Archive — User Manual

**Version**: 2.1  
**Platform**: GAS Photo Management Platform  
**System Administrator**: cathy.lin@mmrunners.org  
**Last Updated**: April 2026

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Sign In & Access](#2-sign-in--access)
3. [Dashboard](#3-dashboard)
4. [Uploading Photos](#4-uploading-photos)
5. [Admin: User Management](#5-admin-user-management)
6. [Admin: Club Management](#6-admin-club-management)
7. [Admin: Event Management](#7-admin-event-management)
8. [Admin: Summary & Reports](#8-admin-summary--reports)
9. [REST API (Partner Organizations)](#9-rest-api-partner-organizations)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. System Overview

### 1.1 What Is the MM Runners Photo Archive?

The MM Runners Photo Archive is an event photo management tool built for the MM Runners organization. It runs on Google Apps Script and integrates with Google Drive and Google Sheets, giving every running club a unified way to upload, archive, and browse event photos.

Version 2.1 includes all five development phases: upload flow, user management, club management, event management, admin summary dashboard, and a cross-organization REST API.

### 1.2 Key Features

- Automatic organization of Google Drive photo folders by event and club
- Google account single sign-on — no separate registration required
- Admin-managed user accounts (add, edit, deactivate, reactivate)
- Admin-managed club registry (add, edit, deactivate, reactivate)
- Event management: create and edit events with automatic Drive folder sync
- Full upload log — every batch upload is recorded with metadata
- Folder naming validation to keep the directory structure consistent
- Admin summary dashboard: upload stats by event and club, CSV export, exception email alerts
- Cross-organization REST API: partner GAS scripts can query and upload photos programmatically

### 1.3 User Roles

| Role | Permissions |
|------|-------------|
| Regular user (`user`) | Sign in, browse the event list, view club folders, upload photos for their own club |
| Administrator (`admin`) | All user permissions + manage system users, clubs, and events + access the summary dashboard |
| API client (`api_client`) | Programmatically query event folders, list files, and upload photos via the REST API (no web UI access) |

> Your role is assigned by the system administrator. To request a change, contact cathy.lin@mmrunners.org.

### 1.4 Three-Level Folder Structure

All photos are stored in Google Drive using the following three-level hierarchy:

```
📁 [ROOT] MM Runners Photo Archive
│
├── 📁 YYYY-MM-DD_EventName          ← Level 1: main event folder (admin creates)
│   │                                    e.g. 2025-11-03_NYC_Marathon
│   │
│   ├── 📁 ClubName                  ← Level 2: club folder (auto-created on first upload)
│   │   │                                e.g. New_Bee | Misty_Mountain | Nankai
│   │   │
│   │   └── 📁 YYYYMMDD-HHMMSS_user  ← Level 3: batch folder (auto-created per upload session)
│   │       │                             e.g. 20251103-093500_cathylin
│   │       ├── photo1.jpg
│   │       └── photo2.jpg
│   │
│   └── 📁 AnotherClub
│       └── ...
│
└── 📁 2025-10-30_Another_Event
    └── ...
```

| Level | Name format | Example | Validated? |
|-------|-------------|---------|-----------|
| Level 1 (Event) | `YYYY-MM-DD_TitleWord_TitleWord` | `2025-11-03_NYC_Marathon` | Yes |
| Level 2 (Club) | Must match an approved club name | `New_Bee` | Yes |
| Level 3 (Batch) | `YYYYMMDD-HHMMSS_username` | `20251103-093500_cathylin` | Auto-generated |
| Files (Level 4+) | Original filename preserved | `DSC_0042.jpg` | Type check only |

---

## 2. Sign In & Access

### 2.1 Prerequisites

- A Google account that has been registered in the system by an administrator
- A modern browser (Chrome, Edge, or Firefox recommended)
- A stable internet connection

### 2.2 Sign In Steps

1. **Open the system URL** — Paste the Web App URL provided by your administrator into your browser address bar. Bookmark it for easy access.
2. **Click "Sign in with Google"** — You will be redirected to Google's login page.
3. **Select your Google account** — If multiple accounts are logged in to your browser, select the one registered in the system.
4. **Authorize access** — On first login, Google will ask you to grant Drive and Sheets access. Click "Allow."
5. **Access the dashboard** — After authorization, you will be taken to your personal dashboard.

### 2.3 Common Sign-In Errors

| Error message | Cause | Solution |
|---------------|-------|----------|
| Your account is not registered | That Google account has not been added to the system | Contact the administrator to add your account |
| Your account has been deactivated | The administrator has deactivated your account | Contact the administrator to reactivate it |
| Access denied (insufficient permissions) | You attempted to access a page your role does not permit | Return to the dashboard; contact the administrator if you need upgraded access |

---

## 3. Dashboard

### 3.1 Layout

After signing in you will see the dashboard. It has three main areas:

- **Top navigation bar**: Shows the system title and your logged-in account. Admins also see navigation links for Users, Events, Clubs, and Summary.
- **Welcome banner**: Displays your account, role, and running club.
- **Quick-access tiles**: Show the features available for your role.

### 3.2 Quick-Access Tiles

| Tile | Available to | Function |
|------|-------------|----------|
| User Management | Admins only | Add, edit, or deactivate system users |
| Club Management | Admins only | Add, edit, or deactivate running clubs |
| Events | Admins only | Create and manage event folders |
| Summary | Admins only | View upload summary, naming violation reports, export CSV, send exception emails |
| Upload Photos | All users | Upload photos to an event folder |
| Browse Drive | All users | Open Google Drive to view uploaded photos |

> Admin users see four additional tiles (User Management, Club Management, Events, Summary). Regular users only see Upload Photos and Browse Drive.

---

## 4. Uploading Photos

This chapter covers how to upload event photos. All users (including admins) can upload; photos are automatically stored in your club's folder under the selected event.

### 4.1 Before You Upload

- Confirm that the event you want to upload to has been created by an administrator.
- Photos must be in JPEG (`.jpg`/`.jpeg`), PNG (`.png`), or HEIC (`.heic`) format.
- Single file limit: 50 MB. Batch limit: 200 MB per upload session.

### 4.2 Upload Flow (4 Steps)

#### Step 1: Select Event

The upload page shows all events as a card grid. Each card shows the event name and date.

- Use the **date range filter** at the top to narrow the list.
- Click any event card to select it. The card highlights and you proceed to Step 2.

#### Step 2: View Your Club's Current Folder (Read-Only)

After selecting an event, the system loads your club's existing uploads for that event.

- The folder tree shows existing batch folders and file counts.
- This step is read-only — you cannot delete or move files here.
- If your club has no uploads yet, a "No uploads yet" message is shown.
- Click **Continue to Upload** to proceed to Step 3.

#### Step 3: Choose Photo Files

Click **Choose Files** or drag and drop files onto the upload area.

- Unsupported file types are automatically filtered out (only JPEG, PNG, and HEIC are kept).
- Files exceeding 50 MB are flagged as errors and skipped.
- If the batch total exceeds 200 MB, a warning is shown; split your upload into multiple sessions.
- **Duplicate detection**: the system checks each file against all existing files in your club's event folder by filename and file size. Detected duplicates are listed; you choose to skip or overwrite each one.

#### Step 4: Results Summary

After upload completes:

| Summary item | Meaning |
|-------------|---------|
| Uploaded: N photos, X MB | Files successfully uploaded to Drive |
| Skipped duplicates: N | Files that matched existing files (by name and size) |
| Skipped non-photos: N | Files filtered out due to unsupported file type |

### 4.3 Where Are My Photos?

Photos are saved in Google Drive at:

```
Root folder / Event folder / Your club folder / Batch folder (timestamp) /
```

Click the **Browse Drive** tile on the dashboard to jump directly to Google Drive.

### 4.4 Upload Tips

- Do not close the browser tab during upload; it may interrupt the upload.
- For large batches (>200 MB), split into multiple sessions of 3–5 uploads each.
- Each upload session creates a new batch folder with a timestamp, so multiple sessions for the same event are organized automatically.

---

## 5. Admin: User Management

> This chapter is for administrators only.

### 5.1 Opening User Management

Click the **User Management** tile on the dashboard, or click **Users** in the top navigation bar. The page lists all registered users and their status.

### 5.2 Adding a User

1. Click **Add User** — the form expands at the top of the page.
2. Fill in the **Email** field with the user's Google account email.
3. Select a **Running Club** from the dropdown.
4. Select a **Role**: `user` (regular user) or `admin` (administrator).
5. Click **Create User**. The record is written to the Users sheet immediately.

The new user can sign in immediately with their Google account — no separate notification is required.

### 5.3 Editing a User

Click the edit icon (pencil) next to any user. You can update their running club or role. Click **Save**.

### 5.4 Deactivating a User

Deactivating blocks the user from signing in but preserves all their upload history.

1. Find the user in the table.
2. Click the deactivate icon. An inline confirmation prompt appears with the user's name.
3. Confirm the action. The user's status changes to `inactive` and the row is shown in grey.

### 5.5 Reactivating a User

For deactivated users, click the reactivate icon. The user's status returns to `active` and they can sign in again immediately.

### 5.6 Bulk User Import

For large-scale onboarding, paste rows directly into the Users sheet in the following column order:

| email | running_club | role | status | added_date | added_by |
|-------|-------------|------|--------|------------|---------|
| user@example.com | New_Bee | user | active | 2026-04-17 | cathy.lin@mmrunners.org |

Use `role` values `admin`, `user`, or `api_client`. Use `status` value `active`.

---

## 6. Admin: Club Management

> This chapter is for administrators only.

Clubs determine which folder names are valid at Level 2 of the Drive hierarchy, and which options appear in the running club selector when adding users and uploading photos.

### 6.1 Opening Club Management

Click the **Club Management** tile on the dashboard, or click **Clubs** in the top navigation bar.

### 6.2 Adding a Club

1. Click **Add Club**.
2. Fill in the **Display Name** (human-readable, e.g. `Sunrise Runners`).
3. Fill in the **Normalized Name** — this is the actual Drive folder name (e.g. `Sunrise_Runners`). Rules:
   - Must start with a letter
   - May contain letters, digits, and underscores
   - No consecutive underscores; no leading or trailing underscores
4. Click **Save**. The club is available immediately for user registration and photo uploads.

### 6.3 Editing a Club

Click the edit icon next to any club. You can update the display name or normalized name. Click **Save**.

> Changing a club's normalized name does not rename existing Drive folders. Only new uploads will use the updated name.

### 6.4 Deactivating a Club

Deactivated clubs no longer appear in upload or user-registration selectors, but their Drive folders and upload history are fully preserved.

Click the deactivate icon next to the club, then confirm.

### 6.5 Reactivating a Club

Click the reactivate icon next to any deactivated club. The club reappears in all selectors immediately.

---

## 7. Admin: Event Management

> This chapter is for administrators only.

### 7.1 Opening Event Management

Click the **Events** tile on the dashboard, or click **Events** in the navigation bar.

### 7.2 Creating an Event

1. Click **New Event** — the form expands.
2. Enter the **Event Name** (letters, numbers, and spaces only; max 100 characters). As you type, a real-time preview shows the Drive folder name that will be created.
3. Enter the **Event Date** using the date picker.
4. Click **Create Event**. The system:
   - Validates the name and date
   - Generates the folder name (`YYYY-MM-DD_Event_Name`)
   - Creates the Drive folder under the root folder
   - Writes the event record to the Events sheet
5. The new event appears at the top of the table.

### 7.3 Editing an Event

Click the edit icon (pencil) on any event row. You can update the display name or date. The Drive folder name is **immutable** — it cannot be changed after creation. Click **Save**.

### 7.4 Browsing Events

- Click the **Date** column header to toggle ascending/descending sort.
- Use the **From / To** date pickers above the table to filter by date range.
- Click the folder icon on any event row to open its Google Drive folder in a new tab.

### 7.5 Naming Violation Alerts

When the Events page loads, the system silently scans Level 1 and Level 2 of the Drive hierarchy for naming violations. If violations are found, an orange banner appears at the top of the page. Click **View Details** to see the full list of offending folder names and violation types.

---

## 8. Admin: Summary & Reports

> This chapter is for administrators only.

### 8.1 Opening the Summary Dashboard

Click the **Summary** tile on the dashboard, or click **Summary** in the navigation bar.

### 8.2 Date Range & Filters

Use the **From / To** date pickers to set the reporting period. All data on the page updates automatically.

### 8.3 Upload Statistics

The main table shows, for each event in the selected period:

- Which clubs uploaded photos
- Number of photos and total size per club
- Grand total for the event

### 8.4 Events with No Uploads

A separate section lists events that had zero upload activity in the selected period. Use this list to follow up with clubs that may have missed their upload window.

### 8.5 Naming Violations

The violations section shows any Level 1 or Level 2 Drive folders whose names do not comply with the naming convention. For each violation:

- Folder name
- Parent folder name
- Layer (1 or 2)
- Violation type

### 8.6 CSV Export

Click **Export CSV** to download the full summary report as a comma-separated file. The file can be opened in Excel or Google Sheets for further analysis.

### 8.7 Exception Email Alert

Click **Send Exception Email** to email the violation report to the administrator's registered address. The email lists all naming violations detected in the current scan.

---

## 9. REST API (Partner Organizations)

This chapter is for technical users at partner organizations who want to upload photos programmatically without using the web interface.

### 9.1 Prerequisites

- Your organization must be registered as an `api_client` user by the MM Runners administrator.
- You will receive: the Web App URL and your API key (your registered email address).
- You must have access to Google Apps Script or another environment that can make HTTP requests.

### 9.2 Authentication

Pass your API key as a query parameter on every request:

```
?api_key=your.email@partnerorg.com
```

There is no separate token exchange. GAS Web Apps do not support reading custom HTTP headers, so the API key is always a query parameter.

### 9.3 Rate Limit

Each API key is limited to **60 requests per hour**. One file upload = one request. Exceeding the limit returns HTTP 429 with the message "Rate limit exceeded."

### 9.4 Available Endpoints

**Check folder** (GET)

```
GET {WEB_APP_URL}?action=api_check_folder&event_folder_name=2025-11-03_NYC_Marathon&api_key=...
```

Returns: `{ status: "success", data: { folderId: "...", exists: true } }` or `{ data: { exists: false } }`

**List files** (GET)

```
GET {WEB_APP_URL}?action=api_list_files&folder_id=DRIVE_FOLDER_ID&api_key=...
```

Returns: `{ status: "success", data: [ { name, size, mimeType, modifiedTime }, ... ] }`

**Upload file** (POST)

```
POST {WEB_APP_URL}?action=api_upload_file&api_key=...
Body: { eventId, clubName, fileName, mimeType, base64Data }
```

Returns: `{ status: "success", data: { fileId, batchFolderName } }` or an error with `code` and `message`.

### 9.5 Standard Response Format

All responses follow:

```json
{
  "status": "success" | "error",
  "code": 200 | 400 | 403 | 404 | 409 | 415 | 429 | 500,
  "message": "Human-readable description",
  "data": { ... }
}
```

Common error codes:

| Code | Meaning |
|------|---------|
| 400 | Bad request — missing or invalid parameters |
| 403 | Forbidden — invalid or missing API key |
| 409 | Conflict — duplicate file detected |
| 415 | Unsupported media type — file type not allowed |
| 429 | Too Many Requests — rate limit exceeded |
| 500 | Internal server error |

### 9.6 Partner Client Example

A ready-to-use GAS client script is included in the repository at `example/partner-client.gs`. Copy the file into your GAS project, set the `XIANGSHEIDONG_BASE_URL` and `API_KEY` constants, and run the functions.

---

## 10. Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "Your account is not registered" on login | Your Google account is not in the Users sheet | Contact the administrator to add your account |
| "Your account has been deactivated" | Your account status is inactive | Contact the administrator to reactivate your account |
| Upload fails with "Unsupported file type" | The file is not JPEG, PNG, or HEIC | Convert the file, or contact the administrator if you need a new format supported |
| Files are marked as duplicates unexpectedly | Another club member already uploaded the same files | Check the club folder — they may have been uploaded in a previous session |
| Event not visible in the upload picker | The event has not been created yet by an admin | Contact your administrator to create the event |
| "Rate limit exceeded" in API | Your api_client key sent more than 60 requests in an hour | Wait until the hour resets, or contact the administrator to review your request pattern |
| Naming violation banner on Events page | A Drive folder at Level 1 or 2 does not follow the naming convention | Review the violation list, identify the folder, and rename or delete it manually in Google Drive |
| Changes pushed with `clasp push` not live | The live deployment has not been updated | In the GAS editor, create a new deployment version (Deploy → Manage deployments) |

For issues not covered here, contact: **cathy.lin@mmrunners.org**
