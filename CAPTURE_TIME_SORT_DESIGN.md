# Capture-Time Sorting — Design

**Status:** proposal · **Date:** 2026-06-20 · **Owner:** admin@mmrunners.org

Goal: let people view event photos in the order they were *taken* (not uploaded),
on **two surfaces**:

1. **Event gallery** (cloud-webapp) — a "Sort by: Time / Name" toggle.
2. **Direct Google Drive browsing** — viewers who open the Drive folder and use
   Drive's own sort.

Decisions locked in (this doc builds on them):

- **Approach:** rename files with a capture-time prefix **and** store a
  `takenAt` field in Firestore.
- **Filename format:** `YYYYMMDD-HHMMSS_<credit>_<original>`.
- **Where:** renaming is owned by the GAS upload layer.

---

## 1. Why both a filename prefix *and* a stored field

The two surfaces have different capabilities, so neither mechanism alone covers both:

| Surface | Can it sort by EXIF capture time? | What it *can* sort by |
|---|---|---|
| Google Drive folder (web/mobile) | **No** — Drive's UI never exposes EXIF `DateTimeOriginal` as a sort key | Name, Last modified, Last opened |
| Event gallery (our code) | Only if we store it | Any field we put in Firestore |

So:

- For **Drive-direct browsing**, the *only* lever is the filename. If the name
  starts with a zero-padded `YYYYMMDD-HHMMSS`, then **Drive's "Sort by Name"
  becomes "sort by capture time"** for free. This is exactly the trick your batch
  folders already use (`buildLayer3FolderName` → `YYYYMMDD-HHMMSS_<user>`).
- For the **gallery**, a real `takenAt` field is cleaner and faster than parsing
  the name, and it survives even when a file has no EXIF (see fallbacks).

Doing both means one canonical, human-readable name *and* a queryable field, with
no second source of truth to drift.

---

## 2. The capture timestamp — definition & fallback chain

Define a single value, `takenAt`, resolved by the **first available** of:

1. **EXIF `DateTimeOriginal`** (+ `SubSecTimeOriginal` when present) — the real
   shutter time. Authoritative.
2. **Drive `imageMediaMetadata.time`** — Drive parses EXIF server-side and exposes
   this via the Drive v3 REST API. Same value as (1) when Drive has finished
   processing the upload (note: it can lag seconds–minutes after upload).
3. **Drive `createdTime`** — when the file landed in Drive (≈ upload time).
4. **Drive `modifiedTime`** — last resort (what the system stores today).

Record **which tier was used** (`takenAtSource: "exif" | "drive_exif" | "created"
| "modified"`) so the UI can distinguish "real capture time" from "best guess",
and so a later backfill can upgrade guesses to real EXIF.

**Timezone:** EXIF `DateTimeOriginal` carries no zone. Treat it as the camera's
local wall-clock and render it verbatim (don't shift it). This keeps a single
event's photos internally consistent, which is all the sort needs. Store the raw
string; if `OffsetTimeOriginal` exists, keep it alongside but don't let it reorder
within an event.

**Format of the prefix:** `YYYYMMDD-HHMMSS`. Add a tie-breaker (below) when two
photos share the same second.

---

## 3. Filename scheme

```
YYYYMMDD-HHMMSS[_SSS]_<Club>_<Photographer>_<originalName>
└──── capture time ───┘ └──── existing credit prefix ────┘
        (new)               (buildCreditedFileName today)
```

Example:

```
20260620-143052_MMR_JaneDoe_IMG_4231.JPG
```

Composition rules (extend, don't rewrite, `creditedFileName.ts`):

- Prepend the capture-time block **before** the existing credit prefix, so the
  string is still sortable by leading characters and the credit stays intact.
- Keep `buildCreditedFileName`'s **idempotency** guarantee: if a name already
  starts with a `YYYYMMDD-HHMMSS` block, do **not** stack another one
  (re-uploads / re-processing stay stable). Detect with
  `/^\d{8}-\d{6}(?:_\d{3})?_/`.
- Keep the 240-char cap; the time block is fixed-width (15–19 chars) so it just
  shrinks the truncation headroom slightly.
- **Tie-breaker for bursts:** if EXIF `SubSecTimeOriginal` exists, append it as
  `_SSS` (milliseconds). If not, the upload layer appends a 3-digit per-second
  sequence within the batch (`_000`, `_001`, …). This avoids Drive's own
  collision suffix (`name (1).jpg`), which would *break* name-sort ordering.

When EXIF is missing entirely (tier 3/4), still apply a prefix using the fallback
time so the file remains chronologically grouped; the `_NNN` sequence keeps order
stable within that batch.

---

## 4. Pipeline — where each step happens

```
 Browser (uploader)                GAS upload layer                 Indexer (cloud-run)            Gallery API + UI
──────────────────         ─────────────────────────         ───────────────────────         ────────────────────
 read EXIF from File   →   authoritative rename on Drive  →   write takenAt to Firestore  →   sort toggle (time|name)
 build candidate name      (+ imageMediaMetadata backfill)    photos doc                       Drive: sort by name
```

### 4a. Browser — read EXIF where the bytes are

This is the key constraint: **`DriveApp` cannot read EXIF**, the Advanced Drive
Service isn't enabled, and in the **volunteer flow the bytes never reach GAS**
(`uploadHandlers.ts` comment). The browser, however, already holds the `File`
object and already does the credit rename client-side.

- Parse `DateTimeOriginal` + `SubSecTimeOriginal` in the browser from the file
  bytes (small dependency, e.g. `exifr`, or a ~40-line `DataView` reader for the
  APP1 segment — JPEG/HEIC/most camera RAW carry it).
- Build the candidate name `YYYYMMDD-HHMMSS[_SSS]_<credit>_<orig>` and upload
  under it. Send the parsed `takenAt` + `takenAtSource` as metadata alongside.

### 4b. GAS — authoritative rename + backfill

GAS owns the final name (defence-in-depth — never trust the client name, per the
existing `applyServerSideRename`):

- Extend `applyServerSideRename` to also prepend the time block via the updated
  `buildCreditedFileName`.
- The client EXIF value is *untrusted*. To verify/repair it server-side, read
  **Drive `imageMediaMetadata.time`** via the v3 REST client you already use for
  `md5Checksum` (`driveShortcutClient.ts` pattern, `UrlFetchApp` + `fields=
  imageMediaMetadata(time,width,height),createdTime,modifiedTime`). Because Drive's
  EXIF parse can lag the upload, do this in the existing post-upload pass (the same
  place md5/dedup runs) rather than synchronously in the upload request.
- If the REST value disagrees with the client's, the REST value wins and the file
  is renamed to match. If neither EXIF source is present, fall back to
  `createdTime` and tag `takenAtSource` accordingly.

> Alternative if you'd rather not add a client EXIF reader now: skip 4a and let
> GAS derive `takenAt` purely from Drive `imageMediaMetadata.time` in the
> post-upload pass, then rename. Simpler, but ordering isn't visible until Drive
> finishes parsing (the lag), and you lose sub-second burst ordering.

### 4c. Indexer — persist the field

`cloud-webapp/indexer/job.py` already downloads bytes and already depends on
`piexif`. In `upsert_photo` (currently no time field), add:

```python
"takenAt": taken_at_iso,          # e.g. "2026-06-20T14:30:52"
"takenAtSource": taken_at_source, # "exif" | "drive_exif" | "created" | "modified"
```

Resolution order in the indexer: parse EXIF from the bytes it already has
(authoritative, also fixes any file uploaded before the client reader shipped) →
else Drive `modifiedTime` it already carries. This makes the indexer a
self-healing backfill: re-running it upgrades `takenAtSource` to `"exif"`.

---

## 5. Gallery — the sort toggle

**API** (`cloud-webapp/api/src/routes/gallery.ts`): today the query has no
`orderBy` and only selects `photoId, name, contentHash`. Change to:

- Accept `?sort=time|name` (default `time`).
- `sort=time` → `.orderBy('takenAt').orderBy('name')` (name as deterministic
  tiebreak). `sort=name` → `.orderBy('name')`.
- Select `takenAt` / `takenAtSource` and return them in `GalleryPhoto` so the UI
  can show a date header / "approx" badge for non-EXIF tiers.
- Needs a **Firestore composite index** on `photos(eventId ASC, takenAt ASC,
  name ASC)`. Add it to the index config and deploy before flipping the default.
- Photos with `takenAt == null` sort last; consider backfilling so none are null.

**UI:** a simple segmented control "Time | Name". Optionally group thumbnails
under day headers using `takenAt` (this is the Google-Photos-like view).

---

## 6. Drive-direct browsing

No code path needed beyond the rename — once names start with `YYYYMMDD-HHMMSS`,
tell viewers to **Sort by → Name (A→Z)** in Drive and they get chronological
order. Document this one line in the volunteer/viewer guide. The fixed-width,
zero-padded format guarantees lexicographic == chronological through year 9999.

---

## 7. Edge cases

- **No EXIF (screenshots, PNGs, messaging-app-stripped, scans):** fall to
  `createdTime`; still prefixed and grouped, flagged `takenAtSource != exif`.
- **Bursts / same second:** `_SSS` sub-second when available, else per-second
  `_NNN` sequence — never rely on Drive's `(1)` suffix.
- **Wrong camera clock:** garbage in, garbage out; the source tag at least makes
  it auditable. Out of scope to correct.
- **Re-uploads / re-processing:** idempotent prefix check prevents double-prefix.
- **Videos / audio:** already skipped by `skipByPrefix: ["video/","audio/"]`;
  leave naming unchanged or use container `creationTime` if you want them sorted
  too (separate follow-up).
- **HEIC / RAW:** EXIF still present; client reader and `piexif`/Drive handle the
  common cases. Verify with a sample from your actual cameras.

---

## 8. Migration / backfill for existing photos

1. Ship the indexer change first (§4c) and **re-index existing events** — this
   populates `takenAt` for everything already in Firestore from the stored bytes,
   no Drive renames required. Gallery time-sort works immediately.
2. Ship the gallery index + toggle (§5), default `sort=time`.
3. Ship the upload-layer rename (§3–4) for *new* uploads.
4. (Optional) One-off GAS job to rename *existing* Drive files to the new scheme
   for the Drive-direct-browsing crowd. Idempotent, so safe to re-run; gate behind
   a dry-run like `migrationService` already does.

Ordering matters: gallery value lands in steps 1–2 with zero Drive mutation; the
riskier bulk rename (step 4) is last and optional.

---

## 9. Concrete change list

| File | Change |
|---|---|
| `gas-app/src/utils/creditedFileName.ts` | Prepend `YYYYMMDD-HHMMSS[_SSS]` block; extend idempotency regex; unit tests |
| `gas-app/src/routes/uploadHandlers.ts` | `applyServerSideRename` includes time block; accept client `takenAt` metadata |
| `gas-app/src/services/driveShortcutClient.ts` (or sibling) | REST `files.get?fields=imageMediaMetadata(time),createdTime` backfill |
| `gas-app` client/upload UI | Read EXIF `DateTimeOriginal`/`SubSecTimeOriginal` from `File`; build candidate name |
| `cloud-webapp/indexer/job.py` | `upsert_photo` writes `takenAt` + `takenAtSource`; EXIF parse with `modifiedTime` fallback |
| `cloud-webapp/api/src/routes/gallery.ts` | `?sort=time|name`, `orderBy`, return `takenAt` |
| shared types (`GalleryPhoto`, `ListPhotosResponse`) | add `takenAt`, `takenAtSource` |
| Firestore indexes | composite `photos(eventId, takenAt, name)` |
| gallery UI | Time/Name toggle; optional day grouping |
| viewer/volunteer guide | "Sort by Name in Drive = chronological" note |

---

## TL;DR

Read the real capture time once, in the browser where the bytes live; have GAS
rename to `YYYYMMDD-HHMMSS_<credit>_<orig>` (authoritative, with a Drive-REST
`imageMediaMetadata.time` backfill); have the indexer also store `takenAt` in
Firestore. The filename prefix gives Drive-direct viewers chronological order via
plain name-sort; the stored field powers a Time/Name toggle in the gallery. Roll
out indexer + gallery first (no Drive mutation, immediate win), upload rename
next, bulk rename of old files last and optional.
