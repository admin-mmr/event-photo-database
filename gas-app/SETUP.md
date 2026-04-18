# 湘舍动公益文件系统 — Setup Guide (GAS v1)

This guide walks through everything needed to launch the web app from scratch and onboard the first wave of beta users. Complete each section in order.

---

## Prerequisites

- A Google account that will **own** the Drive folder, Sheets database, and GAS project (this should be the org account, not a personal one)
- [Node.js](https://nodejs.org/) v18+ and npm installed locally
- The `gas-app/` directory from this repo cloned to your machine

---

## Step 1 — Install dependencies and log in to clasp

```bash
cd gas-app
npm install
npm run login        # opens a browser OAuth flow — log in as the org Google account
```

`clasp login` saves a credential file at `~/.clasprc.json`. All subsequent `clasp` commands will act as this account.

---

## Step 2 — Create the Google Drive root folder

1. Go to [drive.google.com](https://drive.google.com) as the org account.
2. Create a new folder named exactly:
   ```
   湘舍动公益文件系统
   ```
3. Open the folder. Copy the folder ID from the URL bar:
   ```
   https://drive.google.com/drive/folders/<FOLDER_ID_HERE>
   ```
4. **Save this ID** — you will need it in Step 4.

> The app will create all event and club subfolders automatically inside this root. Do not create any subfolders manually.

---

## Step 3 — Create the Google Sheets database

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet.
2. Name it `湘舍动公益文件系统 — Database`.
3. Copy the spreadsheet ID from the URL bar:
   ```
   https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID_HERE>/edit
   ```
4. **Save this ID** — you will need it in Step 4.

### Create the four required sheets (tabs)

Rename the default "Sheet1" tab and add three more. The names must match exactly (case-sensitive):

| Tab name | Purpose |
|----------|---------|
| `Users` | Registered user accounts |
| `Events` | Race events and their Drive folder IDs |
| `Upload_Log` | Audit log of every upload session |
| `Rate_Limit` | Per-API-key request counters |
| `Clubs` | Approved running clubs (seeded automatically on first run) |

### Add header rows

Paste the following headers into **row 1** of each sheet (one value per column, left to right):

**Users**
```
email | running_club | role | status | added_date | added_by
```

**Events**
```
event_id | event_name | event_date | folder_name | drive_folder_id | created_by | created_at
```

**Upload_Log**
```
log_id | event_id | club_name | uploaded_by | batch_folder_name | batch_folder_id | file_count | total_size_mb | skipped_duplicates | skipped_non_photo | upload_timestamp | source
```

**Rate_Limit**
```
api_key | window_start | request_count
```

**Clubs**
```
displayName | normalizedName | status | addedDate | addedBy
```

> The `Clubs` sheet will be seeded automatically with default clubs when the app first accesses it. You only need to create the tab — leave it blank.

> Headers are for human readability only — the app accesses columns by index (0-based), so **column order must be exact**.

---

## Step 4 — Configure Script Properties

Script Properties store the two sensitive IDs so they are never hard-coded in source.

1. Open the GAS editor for this project:
   ```bash
   npm run open
   ```
   This opens `https://script.google.com/d/1xrjL0y7RXNQjD90hTErnCAOg6xYdwqZ5RMdDSBDFj7Pol8gyHxPHAcg8/edit` in your browser.

2. In the GAS editor, go to **Project Settings** (the gear icon ⚙️ in the left sidebar).
3. Scroll to **Script Properties** and click **Add script property** for each of the following:

| Property key | Value |
|---|---|
| `ROOT_FOLDER_ID` | The Drive folder ID from Step 2 |
| `SPREADSHEET_ID` | The Sheets ID from Step 3 |

4. Click **Save script properties**.

---

## Step 5 — Push the source code

From the `gas-app/` directory:

```bash
npm run push
```

`clasp` will transpile the TypeScript source from `src/` and upload it to the GAS project. You should see each file listed with a ✓ confirmation.

To push automatically on every save during development:
```bash
npm run push:watch
```

---

## Step 6 — Deploy as a Web App

1. In the GAS editor, click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Configure the deployment settings:

   | Setting | Value |
   |---------|-------|
   | Description | `v1 beta` (or any label you like) |
   | Execute as | **Me (owner)** |
   | Who has access | **Anyone with a Google Account** |

   > **Why "Me (owner)"?** The script must access the Sheets database and Drive folder that belong to the owner. If set to "User accessing the web app", each visitor would need their own Drive/Sheets permissions on those files — which defeats the purpose of a shared system.

   > **Why "Anyone with a Google Account"?** This forces visitors to sign in with Google before the script runs, so `Session.getActiveUser().getEmail()` always returns a real email. Setting it to "Anyone" (no login required) would make `getEmail()` return an empty string and break authentication entirely.

4. Click **Deploy**. Google will ask you to authorize the required OAuth scopes as the owner — click through and grant them. **This authorization step is mandatory** — skipping it causes a blank page with no error message.
5. Copy the **Web app URL** that appears (it looks like `https://script.google.com/macros/s/.../exec`).
6. **Save this URL** — you will share it with beta users.

> Every time you push new code and want to update the live deployment, go to **Deploy → Manage deployments**, click the pencil ✏️ icon, change the version to "New version", and click **Deploy**.

---

## Step 7 — Add the first admin user

The app checks the Users sheet on every login. Before anyone can use it, at least one admin must exist.

1. Open the **Users** sheet in Google Sheets.
2. Add a row manually in row 2 with the org admin's details:

   | email | running_club | role | status | added_date | added_by |
   |-------|-------------|------|--------|------------|---------|
   | `cathy.lin@mmrunners.org` | `Admin` | `admin` | `active` | `2026-04-10` | `setup` |

3. You can add additional admins the same way, or use the Admin UI once you are logged in.

> The `email` value must be a valid Google account that the person will use to log in. It is matched case-insensitively.

---

## Step 8 — Verify the deployment with the healthcheck

After every push + redeploy, run the healthcheck **before** any real testing. It catches the two most common silent failures immediately.

1. Open this URL in your browser (replace `<YOUR_APP_URL>` with the URL from Step 6):
   ```
   <YOUR_APP_URL>?action=healthcheck
   ```
2. You should see a diagnostic page. Check each item:

   | What you see | What it means |
   |---|---|
   | **Session email** shows your Google email | ✅ OAuth authorized, session working |
   | **Session email** is empty or shows ERROR | ❌ Re-authorize: open the app URL without `?action=healthcheck`, click through the Google permission dialog |
   | **Deployment URL** matches your app URL | ✅ Correct version is live |
   | Page itself fails to load (blank / refused) | ❌ `XFrameOptionsMode` is wrong — must be `ALLOWALL`, not `DEFAULT` |

3. Once the healthcheck is green, proceed to the full smoke test:
   - Open the app URL (without `?action=healthcheck`) while signed in as the admin added in Step 7
   - You should land on the **Dashboard** with the admin navigation panel
   - Go to **Admin → Events → Create Event**, enter a name and date, and submit
   - Confirm the event appears in the Events sheet and a matching Drive folder was created

If you see an error about missing Script Properties, revisit Step 4. If you see "Access Denied", double-check the email in the Users sheet exactly matches your Google account.

---

## Step 9 — Add beta users

Once the admin can log in successfully, add beta users through the Admin UI (no more manual sheet editing needed).

### Via the Admin UI

1. Log in as an admin and navigate to **Admin → Users → Add User**.
2. Fill in the form:

   | Field | Notes |
   |-------|-------|
   | Email | Must be the user's Google account email |
   | Running club | Must be one of: `New Bee`, `Misty Mountain`, `Nankai`, `Admin` |
   | Role | `user` for club members; `admin` for additional admins |

3. Click **Add User**. The record is written to the Users sheet immediately.

### Via the Users sheet (bulk onboarding)

For adding many users at once, paste rows directly into the Users sheet following the same column order as in Step 3. Use these values:

- `role`: `admin` or `user`
- `status`: `active`
- `added_date`: today's date in `YYYY-MM-DD` format
- `added_by`: your admin email

### Notifying beta users

Share the web app URL with each beta user. They will be able to log in immediately — the app uses their Google OAuth session and looks them up in the Users sheet on every request. No password or separate account registration is needed.

---

## Step 10 — Register API client keys (for partner orgs, optional)

If a partner running club wants to upload photos programmatically using the REST API (Phase 5), they need an `api_client` account.

1. In the Admin UI, add a new user with role **`api_client`** and use the partner org's email as the key.
2. Share the following with the partner org:
   - The web app URL (their `XIANGSHEIDONG_BASE_URL`)
   - The email address you registered as the `api_key`
   - A copy of `example/partner-client.gs` from this repo

> Rate limit: each API client key is capped at **60 requests per hour**. One file upload = one request.

---

## Managing clubs

Clubs are managed in the `Clubs` sheet of the database spreadsheet. The system seeds the sheet automatically on first run with the following default clubs:

| Display name | Normalized folder name |
|---|---|
| New Bee | `New_Bee` |
| Misty Mountain | `Misty_Mountain` |
| Nankai | `Nankai` |
| Admin | `Admin` |

### Adding or editing clubs after launch

Once the web app is running, use the **Admin UI** to manage clubs:

1. Log in as an admin and navigate to **Admin → Clubs**.
2. Click **Add Club** to create a new club, or click the edit icon next to an existing club.
3. Fill in the **Display Name** (human-readable, e.g. `Sunrise Runners`) and **Normalized Name** (used as the Drive folder name, e.g. `Sunrise_Runners`).
4. The normalized name must start with a letter, contain only letters, digits, and underscores, and have no consecutive underscores.
5. Click **Save**. The club is immediately available for user registration and photo uploads.

To **deactivate** a club, click the deactivate icon. Deactivated clubs no longer appear in the upload club selector, but their existing folders and upload history are preserved.

> **Legacy note**: In older versions, clubs were hardcoded in `src/config/constants.ts → APPROVED_CLUBS`. That list is still used as the initial seed but the Clubs sheet is now the live source of truth. Do not edit `APPROVED_CLUBS` to manage clubs after first deployment.

---

## Troubleshooting

**"Missing Script Properties" error on load**
→ Revisit Step 4. Make sure both `ROOT_FOLDER_ID` and `SPREADSHEET_ID` are set and saved.

**"Access Denied" after logging in**
→ The logged-in Google account is not in the Users sheet, or the email doesn't match exactly. Check for trailing spaces or capitalization differences.

**Changes pushed with `clasp push` are not reflected in the live URL**
→ You must create a new deployment version (Step 6). The `npm run push` command only updates the editor draft; it does not update a live deployment automatically.

**Spreadsheet read/write errors**
→ Make sure the org account (the one that ran `clasp login`) has **Editor** access to the Sheets file. If the spreadsheet was created by a different account, share it with the GAS owner email.

**Drive folder creation fails**
→ Confirm the org account has **Editor** access to the root Drive folder and that the `ROOT_FOLDER_ID` is the folder's ID (not a shared link or the full URL).

---

## GAS deployment gotchas (read before debugging)

These are silent failures that produce misleading symptoms. Check these before anything else.

**Blank page / "refused to connect" in the content area**
→ `XFrameOptionsMode` is set to `DEFAULT`. GAS serves HTML content inside an iframe from `googleusercontent.com`; the outer wrapper page is on `script.google.com`. These are different origins, so `SAMEORIGIN` blocks GAS's own iframe. Must always be `ALLOWALL`. See `pageRoutes.ts`.

**`Session.getActiveUser().getEmail()` returns empty string**
→ Two possible causes: (a) the app was not yet authorized by the owner after deploying with "Execute as: Me" — open the app URL and complete the Google permission dialog; or (b) "Who has access" was accidentally set to "Anyone" (no login) instead of "Anyone with a Google Account" — without a login requirement, Google does not populate the active user session.

**Auth works in the GAS editor preview but fails at the real URL (or vice versa)**
→ The editor preview URL (`/dev`) and the published URL (`/exec`) behave differently for `Session.getActiveUser()`. Always test auth using the published URL, never the editor preview. Use `?action=healthcheck` on the published URL to verify session state.

**Code changes are live in the editor but not at the published URL**
→ `clasp push` only updates the editor draft. You must go to **Deploy → Manage deployments → Edit → New version → Deploy** to push changes to the live URL. The `npm run push` alias does not auto-deploy.
