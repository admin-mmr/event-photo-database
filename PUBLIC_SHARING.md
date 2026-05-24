# Public Sharing Architecture

## Why this document exists

Google deprecated the Photos Library API's album-sharing endpoints on
March 31, 2025. With the OAuth scopes this app is permitted to request
(`photoslibrary.appendonly` + `photoslibrary.edit.appcreateddata`), the
`albums.get` endpoint returns 403/404 for our own albums even after the
owner manually flips "Anyone with the link can view". `shareInfo` is no
longer returned, so we cannot programmatically retrieve a public album
URL from Google Photos.

This was a real problem for the public spreadsheet: every album row would
land with `Permission = Inaccessible` and no working public link, even
though the photos themselves were uploaded fine.

The workaround `ALBUM_OVERRIDES` Script Property (`albumOverridesService.ts`)
lets an admin pin per-album values by hand, but it doesn't scale past a few
albums.

This document describes the systematic alternative the codebase now uses.

## The architecture in one sentence

We publish **Drive folder URLs**, not Google Photos URLs, as the canonical
public-browse link — because Drive sharing is still 100% programmable in
2026 and the system already maintains a parallel Drive hierarchy of
shortcut folders that mirror every uploaded photo and video.

## The pieces

### Existing infrastructure we leverage

- **Photos_NNN shortcut folders** (`specialFoldersService.ts`).
  After every batch sync, one `Photos_001`, `Photos_002`, … folder is
  created directly under the event folder. Each holds Drive shortcuts
  pointing at every photo for that event, up to
  `MAX_SHORTCUTS_PER_PHOTOS_FOLDER` (800) per folder. The shortcut surface
  is browseable in the standard Drive UI — grid view, thumbnails,
  click-to-open, click-to-download.
- **Videos folders.** Per `(event, club, tag)` triple, a sibling `Videos/`
  folder containing shortcuts to every video for that scope. Same browsing
  experience as Photos_NNN.
- **Special_Folders sheet.** Authoritative ledger of these folders'
  Drive IDs, URLs, and file counts. Powers the `Folders` tab of the public
  spreadsheet.

### New infrastructure (this change)

- **`services/drivePermissionsService.ts`** (new module).
  Wraps the Drive v3 REST API's `permissions.create` endpoint to grant
  `{ role: 'reader', type: 'anyone' }` on a folder. Idempotent. No new
  OAuth scope required — `https://www.googleapis.com/auth/drive` already
  covers it. Mirrors the UrlFetchApp style already used by
  `driveShortcutClient.ts` so we don't have to enable the Advanced Drive
  Service in `appsscript.json`.
- **Auto-share at folder creation.** `rebuildEventPhotoFolders()` and
  `rebuildClubVideoFolder()` now call `tryGrantAnyoneRead(folderId)`
  immediately after `getOrCreateSubfolder()`. New folders are public
  by construction.
- **One-shot backfill function.** `backfillSpecialFoldersSharing()` walks
  every row in the Special_Folders sheet and grants the same permission on
  each existing folder. Exposed three ways:
  - **Admin UI** — Photos page → "Share All Drive Folders" button (teal,
    in the "Publish to Public Sheet" section).
  - **HTTP handler** — `serverBackfillSpecialFoldersSharing` for
    `google.script.run`.
  - **GAS editor** — `backfillSpecialFoldersSharing` global function for
    direct execution / time-driven triggers.
- **Public sheet — new "Drive Folder" column.** The `Albums` tab on the
  public spreadsheet now carries a `Drive Folder` column between `Photos`
  and `Album Link`. Each row links to that event's `Photos_001` Drive
  folder. `Album Link` is preserved for the rare cases where a Photos URL
  works, but visitors should use Drive Folder as the canonical link.

## One-time setup the admin must do

The new code grants share permission on individual `Photos_NNN` and
`Videos` folders, not on the root folder. That's intentional — sharing
the root automatically would also leak everything else under it (Users
sheet, Audit_Log sheet, internal admin folders, etc.).

For the per-folder grants to actually work, the script's effective user
needs the **OAuth scope already in `appsscript.json`**
(`https://www.googleapis.com/auth/drive` — already there) and **owner or
editor access** on the folders. Both are true by default because the
script user is who creates the folders in the first place.

**However**, if you want even simpler browsing — one shared parent that
inherits down — you can additionally:

1. In Drive, open the root events folder (the one with ID matching
   `ROOT_FOLDER_ID` in Script Properties).
2. File → Share → "Anyone with the link" → Viewer.
3. Done. Every descendant folder (events, clubs, Photos_NNN, Videos)
   inherits the permission.

That root share is **optional**. The per-folder grants this code now
performs are enough on their own; the root share is defense-in-depth and
useful if a member wants to browse the full archive in one click.

⚠️ **Don't share the root if you have any non-public data anywhere under
it.** Drive inheritance is one-way: everything below the shared folder
becomes visible to anyone with the link.

## Deploying

1. Push the build (`clasp push` from `gas-app/`).
2. Open the admin **Photos** page in the web app.
3. Click **"Share All Drive Folders"** in the Publish section. This
   retroactively shares every folder created before the auto-share hook
   landed. Output toast tells you `created` (newly shared) vs
   `alreadyShared` (idempotent no-ops) vs `errors`.
4. Click **"Rebuild Sheet Only"** in the same section to refresh the
   public spreadsheet so the new `Drive Folder` column appears.
5. Open the public sheet — every event row should now have a clickable
   Drive Folder link, browseable by anyone with the URL.

## Ongoing operations

- **New uploads** automatically share their `Photos_NNN` and `Videos`
  folders as part of `syncBatchToAlbums`. No admin action required.
- **If a folder ever loses its share** (manually un-shared in Drive UI,
  permission inheritance change, etc.), the next sync for the same event
  will re-grant it because the auto-share hook is idempotent. The
  "Share All Drive Folders" button also recovers it on demand.
- **`ALBUM_OVERRIDES` Script Property** can still be used to pin a Photos
  album URL for a one-off case, but it's no longer the strategic answer.
  Leave it unset for most deployments.

## What stays manual

Google Photos albums themselves still need to be shared by hand inside
photos.google.com if you want the Photos UI's slideshow / face grouping
features to be public. The Library API cannot do this, and we cannot
script around it. The Drive Folder column makes this optional — most
viewers will be perfectly happy browsing photos in Drive.

## Related code

- `services/drivePermissionsService.ts` — the grant API
- `services/specialFoldersService.ts` — auto-share hooks + backfill function
- `services/publicSpreadsheetService.ts` — new Drive Folder column on Albums tab
- `routes/photosHandlers.ts` — `serverBackfillSpecialFoldersSharing`
- `main.ts` — `backfillSpecialFoldersSharing` GAS-editor runner
- `ui/templates/admin/photos.html` — "Share All Drive Folders" admin button
