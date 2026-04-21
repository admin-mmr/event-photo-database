# Fixing Google Photos Album Creation Error (HTTP 403)

## Problem

When the admin Photos Overview page tries to create an album (for example "2026-03-15 NYC Half Marathon"), the Library API returns:

```
HTTP 403: { "error": { "code": 403, "message": "Request had insufficient authentication scopes.", "status": "PERMISSION_DENIED" } }
```

## Root Cause — Google Photos API scope deprecation (March 31, 2025)

On March 31, 2025 Google removed three OAuth scopes from the Photos Library API:

- `https://www.googleapis.com/auth/photoslibrary`
- `https://www.googleapis.com/auth/photoslibrary.readonly`
- `https://www.googleapis.com/auth/photoslibrary.sharing`

Any API call that authenticates **only** with one of those scopes now returns `403 PERMISSION_DENIED` with the "Request had insufficient authentication scopes" message — which is exactly what this deployment is hitting.

Our `appsscript.json` previously listed `photoslibrary` and `photoslibrary.sharing`, so the deployed OAuth token has no scope that the Library API still accepts.

References:
- [Updates to the Google Photos APIs](https://developers.google.com/photos/support/updates)
- [Authorization scopes](https://developers.google.com/photos/overview/authorization)

## The Fix

### 1. Replace the deprecated scopes (done in this commit)

`gas-app/src/appsscript.json` now declares:

- `https://www.googleapis.com/auth/photoslibrary.appendonly` — create albums, upload media items
- `https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata` — edit/manage albums and items created by this app

These are the replacement scopes Google kept after the March 2025 cleanup. The Library API now only lets an app see and manage data it created itself, which matches exactly how this project works (we track every album we create in the `Photo_Albums` sheet).

### 2. Push and redeploy

From `gas-app/`:

```bash
npm run build
npm run push
```

Then in the Apps Script editor:

1. **Deploy → Manage deployments → pencil ✏️ → New version → Deploy.**
2. Open the published web app URL as the admin account.
3. Google will show a new consent screen listing the two `photoslibrary.*` scopes above. Click **Allow**.
4. Revisit **Admin → Photos** and click **Backfill All** (or **Retry** on the failing event).

Note: if you skipped the consent screen in the past by clicking through quickly, Google will silently reuse the old token. If after redeploying you still see the same 403, force re-auth by visiting:

```
https://myaccount.google.com/permissions
```

remove this app, then reload the web app and go through the consent dialog again.

### 3. Sharing (what changed)

The `albums:share` endpoint and `photoslibrary.sharing` scope are gone. The app no longer tries to auto-share albums — `shareableUrl` in the `Photo_Albums` sheet is now the same as `productUrl` (owner-only until manually shared).

If you want a public link to an album, open it in Google Photos (as the owner), click **Share**, and paste the resulting link into the `shareableUrl` column manually. Automating this is no longer possible through the Library API.

### 4. What the app can still do

- Create new albums (`photoslibrary.appendonly`)
- Upload photos to albums it created (`photoslibrary.appendonly`)
- Update metadata on albums it created (`photoslibrary.edit.appcreateddata`)

### 5. What the app can no longer do

- List or read albums it did not create (the `photoslibrary` and `photoslibrary.readonly` scopes are gone). This is fine for this project because we already store every album ID we create in the `Photo_Albums` sheet.
- Programmatically share albums.

## Current OAuth Scopes in appsscript.json

- `https://www.googleapis.com/auth/drive` — Drive file access
- `https://www.googleapis.com/auth/spreadsheets` — Sheets access
- `https://www.googleapis.com/auth/script.external_request` — external HTTP calls
- `https://www.googleapis.com/auth/userinfo.email` — user email
- `https://www.googleapis.com/auth/script.scriptapp` — ScriptApp API
- `https://www.googleapis.com/auth/photoslibrary.appendonly` — create albums, upload photos
- `https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata` — edit app-created albums/items

## Why the old fix doc was wrong

A previous version of this file said "you just need to redeploy." That was true for a stale-token case (adding a new scope without redeploying means the old token lacks the new scope). But in this case the scope itself was removed by Google — no amount of re-authorizing `photoslibrary` will ever succeed again. The actual fix is to declare the replacement scopes.
