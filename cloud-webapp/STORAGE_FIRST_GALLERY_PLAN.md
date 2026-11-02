# Design: storage-first gallery (Drive becomes the archive, not the critical path)

> **Status: proposal, 2026-11-02. No code has changed.** Implementation starts
> only after the owner signs off on §10 (open decisions). Written after the NYC
> Marathon (event `4207f053`, 2026-11-01/02), where uploads took 20–90+ minutes
> to reach the gallery.

## TL;DR

- **Recommended identity: `photoId = "c1_" + claimId(eventId, md5)`**, a
  deterministic id computed from the event and the bytes' MD5. Every component
  can compute it from the staged object *or* the later Drive copy without a
  lookup. So a Drive copy that lands after the photo is already in the gallery
  maps to **the same id by construction** and never becomes a second photo.
  It is the same key the upload worker's md5 claim already uses, so "duplicate"
  and "same photo" become one rule instead of two.
- **Existing photos keep their Drive-fileId ids forever.** We don't rename them.
  New photos get `c1_` ids. The indexer finds a photo by MD5 under either scheme,
  so the two coexist in one event. `match_runs`, `match_feedback`, verdicts and the
  judged eval sets stay valid.
- **The indexer gets a fast, add-only "ingest" pass** that reads the staging
  bucket directly, with no Drive listing. The existing Drive pass becomes
  **"reconcile"**: it attaches Drive copies to photos already indexed and detects
  deletions. The Drive copy runs in parallel and is no longer needed before a
  photo becomes visible.
- **Top 3 risks** (detail in §9):
  1. **The reconcile pass reading "not in Drive" as "deleted".** Once photos can
     exist before their Drive copy, that rule would wipe every not-yet-archived
     photo from the gallery and sweep its derivatives. The removal rule must
     become "was archived, and every Drive copy is now gone".
  2. **Recovery and the never-completed sweep reading "indexed" as "in Drive".**
     Both filter staged objects by "md5 already in the photo index". After this
     change that check is true *before* the Drive copy, so they would silently
     stop archiving to Drive. The staging lifecycle would then delete the only
     original outside the derivatives bucket.
  3. **The single-writer store makes ingest wait behind reconcile.** Each run
     rewrites the whole store, and only one run per event can be in flight. A
     long reconcile (Drive listing + store rewrite at 100k photos) blocks the
     fast path for its whole duration. The marathon-scale fix is the segmented
     store in §5.4, which is a decision for the owner.

---

## 1. Why: where the 20–90 minutes go today

```
browser ──PUT──▶ GCS staging ──/complete──▶ Cloud Tasks worker ──copy──▶ Drive
                                            (enqueueStagedBatch)           │
                                                                           ▼
gallery ◀── Firestore photos + derivatives ◀── indexer job ◀── Drive listing + download
```

Every photo must make **three serial Drive round trips** before the gallery can
show it:

1. **The worker copies it into Drive** (`volunteerUploadService.ts`
   `enqueueStagedBatch`). This is paced by the shared Drive rate limit, limited by
   the 750 GB/day per-account cap, and preceded by a listing of the whole event
   for the duplicate check (~32 s at 5k photos, and it grows with the event).
2. **The indexer lists the whole Drive tree** (`indexer/job.py` `run()` →
   `drive.list_images`) to find what changed.
3. **The indexer downloads each changed photo from Drive** (`drive.download`)
   to embed it and mirror `orig/web/thumb` into the derivatives bucket.

Then the store and manifest are written at the **end** of the run. Steps 1–3 are
the critical path even though the bytes were safe in GCS before step 1 started.
PRs #87/#88/#89/#90 made step 1 faster and more reliable. None of them can take
Drive off the path, because **photoId is the Drive fileId**, so a photo cannot
exist until Drive gives it one.

## 2. Goal and non-goals

**Goal:** a volunteer photo shows up in the gallery a few minutes after its
bytes reach staging (target: p95 under 5 min for a 100-file flush on an event
of ≤10k photos). The Drive copy runs in parallel and stays a complete archive.

**Non-goals (deliberately):**

- **Drive stays the archive and the human-browsable tree.** The managed
  folders (Photos_NNN / Album / Videos), the public folder index and the
  `Upload_Log` row all stay Drive-driven and keep lagging the way they do now.
  The Sheet stays the source of truth for events/links (CLAUDE.md).
- **Photos added straight to Drive** (an admin dropping files into the folder)
  keep working through the reconcile pass, as today.
- **No rename of existing photo ids.** That is §3.3's whole point.
- **Videos** are not indexed today and still aren't. They take the archive
  path only.
- **No change to how originals are served.** They are still delivered only as
  signed derivatives-bucket URLs (CLAUDE.md "Never serve photo bytes through
  `/api/**`").

---

## 3. Photo identity

### 3.1 What depends on photoId today

`photoId == Drive fileId` (`indexer/job.py:16`). It is:

| Where | How it uses the id |
|---|---|
| Firestore `photos/<photoId>` | doc id; the gallery lists these (`routes/gallery.ts`) |
| Derivatives bucket | `<eventId>/photos/{orig/<id>.<ext>, web/<id>.jpg, thumb/<id>.jpg}` (`gcsService.ts`, `job.py`) |
| `embeddings/manifest.json` | `photos` map key; `faces[]`/`persons[]` rows' `photoId` |
| Matcher / outfit-tagger | opaque string in results, anchors, crops (`matcher/store.py`, `outfit-tagger/*`) |
| `match_runs`, `match_feedback`, verdict batches | `resultPhotoIds`, `scores{}`, `photoId` |
| Admin photo delete (`gallery.ts` DELETE) | **`trashFile(photoId)` and `releaseClaimsForDriveFile(photoId)`, which assume id == Drive id** |
| Stranded-derivatives sweep | joins manifest ∖ Firestore docs on the id |

Only the last two rows actually *assume* the id is a Drive id; everything else
treats it as an opaque string. That is what makes coexistence cheap.

### 3.2 Options considered

| Scheme | Exists before Drive? | Later Drive copy → same photo? | Duplicates | Verdict |
|---|---|---|---|---|
| **A. Content id: `c1_` + `claimId(eventId, md5)`** | yes | **yes, by construction**: Drive lists `md5Checksum` for free | collapse by construction (same bytes → same id) | **Recommended** |
| B. Upload id (the staged object's uuid) | yes | only if the worker stamps the id into `appProperties` and the indexer reads it back; a Drive-only file still needs another scheme | a re-upload of the same bytes mints a *second* id, so the md5 dedup stays a separate system | rejected |
| C. Keep the Drive fileId, show a "pending" placeholder | no | n/a | n/a | rejected: the photo still isn't searchable or viewable until Drive answers |

**Why A:**

1. **Matching is free.** The Drive listing already returns `md5Checksum` (the
   indexer's dedup reads it today). A Drive file maps to its photo with no extra
   Drive call, no `appProperties` round trip and no lookup table.
2. **The worker copies bytes unchanged.** The credit rename and the capture-time
   rename change the *name* and `modifiedTime`, never the bytes. GCS's
   `md5Hash` (base64, normalized to lowercase hex by the storage adapter) and
   Drive's `md5Checksum` are the same value for the same bytes. (This is checked
   before anything ships; see §8 step 0.)
3. **It unifies two rules we already enforce.** The md5 claim (authoritative
   duplicate check, CLAUDE.md) and the indexer's collapse by md5 both treat "same
   md5 in the same event" as "same photo". Making that the identity removes the
   "canonical = first in relPath order" step that **caused the 3,663 stranded
   derivatives**. Those were duplicates whose photoId flipped when the canonical
   Drive copy left; with A the id cannot flip.
4. **Idempotent everywhere.** A retry, a recovery, the never-completed sweep, a
   re-uploaded duplicate, or an indexer run killed after writing docs but before
   the manifest all compute the same id. A killed run is re-done, never
   duplicated.
5. **Joinable with the claim.** `claimId(eventId, md5)` is already the
   `upload_dedup` doc id (`uploadDedupService.ts`). Prefixing it makes "the claim
   for this photo" a key lookup.

**What A costs:**

- **Edited bytes make a new photo.** Rotating or editing a photo inside Drive
  changes its md5: the old id is removed and a new one is added. Today the
  Drive id survives and only the vectors change. Search results are recomputed
  per search, so the only loss is that old `match_feedback` rows on the old id
  become historical. Rare, and acceptable.
- **MD5 is not collision-resistant against an adversary.** A crafted collision
  could make an uploader's photo read as a duplicate and be skipped. The system
  already dedups on md5 at both the claim and the indexer, so this adds no new
  exposure.
- **An MD5 must always be known.** GCS always records one for a
  single-resumable-session object. On **Azure**, browser-committed blobs carry
  *no* Content-MD5 (`lib/storage/blobStore.ts`). The ingest pass computes it
  from the bytes it downloads anyway, and stamps it into the blob's metadata
  (`computedMd5`) so later runs don't download it again. Until the worker does
  the same, the worker's claim on Azure stays keyed on `name|size` and doesn't
  join the photo id. That is an Azure-port item (§10, D7).

**Id format:** `c1_` + 40 lowercase hex = 43 chars. That is valid as a
Firestore doc id, a GCS key segment and a URL path segment, and can't be
mistaken for a Drive id (Drive ids are ~33 chars of `[A-Za-z0-9_-]`). The `1`
versions the scheme, so a future change (say, SHA-256 of the bytes) can coexist
the same way.

### 3.3 Coexistence and migration: don't migrate

- **Legacy photos keep their Drive-fileId photoId permanently.** Renaming them
  would mean re-keying ~109 GiB of `orig/` derivatives, every Firestore doc,
  every manifest row, and every `match_runs`/`match_feedback`/verdict reference.
  The judged P@20 baselines (`eval/`) are keyed on those ids too. None of that
  buys anything once lookup goes through md5.
- **New photos from either source get a `c1_` id**, minted by the indexer.
- **One lookup serves both schemes.** The indexer builds `md5 → photoId` from the
  previous manifest's `photos` map. For any staged object or Drive file:
  `photoId = md5_map.get(md5) or c1(eventId, md5)`. A legacy photo absorbs a new
  staged upload of the same bytes. A new photo absorbs its later Drive copy.
  - **This map must load even when vectors are discarded.** Today `FORCE_REINDEX=1`
    and a `modelVersion` change both set `prev_photos = {}` (`job.py` `run()`).
    That is harmless now because Drive ids are stable. With the new scheme it
    would re-mint every legacy photo as `c1_`, and since `removed` is computed
    from `prev_photos`, **the old docs would never be deleted**: the whole event
    would be duplicated in the gallery. The identity map must come from the
    previous manifest no matter what `force` or the model version say. Only the
    vectors are discarded. If the manifest is missing, fall back to Firestore
    `photos where eventId == X select(md5)`.
- **Drive files with no `md5Checksum`** (Google-native types; never seen for
  images) keep `photoId = Drive fileId`, exactly as today: unknown never
  collapses.
- Photo docs gain `idScheme: "c1"`. Absent means `"drive"`. Nothing branches on
  it except the admin delete fallback (§6.1); it's there for audits.

### 3.4 New photo-doc fields

| Field | Meaning |
|---|---|
| `idScheme` | `"c1"` for new ids; absent for legacy |
| `source` | `"staging"` or `"drive"`: where the indexer first read the bytes |
| `driveFileIds: string[]` | every non-managed Drive file in the event with this md5 (sorted by relPath). Replaces the meaning of `driveFileId`, which is kept = `driveFileIds[0]` for back-compat |
| `archivedAt` | first time a reconcile pass saw a Drive copy (ISO). `null` = **not yet archived**. Backfilled to `addedAt` for every legacy photo on its first reconcile |
| `staged: {object, batchId}` | the staging object the photo was ingested from (cleared once staging GC removes it) |
| `upload: {linkId, clubName, tag, photographerName, originalName}` | the credit metadata, copied from the staged object's custom metadata at ingest (the object is transient; this is not) |

The manifest's `photos` map mirrors `driveFileIds`, `archivedAt`, `source` and
`staged`, so the indexer never has to read Firestore to plan a run.
`duplicateCount` becomes `len(driveFileIds) - 1`.

---

## 4. Staging is a source, not a waypoint

### 4.1 Staged-object lifetime

Today a staged object is deleted **right after its Drive copy succeeds** (or on a
*proven* duplicate). The bucket lifecycle is 7 days by default, 30 days while
`event-scale.sh up` is in effect, and 14 days after `down`. A healthy bucket is
almost empty.

New rule: **a staged object is deleted only when its photo is both indexed and
archived.** The proof is a Firestore `photos/<pid>` doc with `archivedAt` set,
*or* an md5 claim stamped with `driveFileId` whose photo doc exists. One function
in the api applies that predicate (`releaseStagedIfSafe`). It is called from:

- the archive worker, right after a successful copy (one `photos` doc read per
  file, batched with `getAll`): if the photo is already indexed, delete now,
  as today;
- **staging GC**, a step added to the hourly `findme-upload-sweep` tick, for
  everything else (the copy finished before the ingest pass reached it).

The indexer **never deletes staged bytes.** It only reads staging. That keeps
"only the worker deletes, and only on proof" (CLAUDE.md) true with one
implementation instead of a Python and a TypeScript copy.

The unproven-duplicate rule is unchanged: a skip on an *unstamped* claim never
deletes the staged object.

### 4.2 The lifecycle is still a deadline

Before a photo's Drive copy lands, its durable copies are the staged object and
the `orig/` mirror in the derivatives bucket. If the lifecycle deletes the
staged object first, the photo still displays and downloads (from `orig/`), but
the archiver has nothing to copy from. Two mitigations:

1. **The archiver falls back to `derivatives/<eventId>/photos/orig/<pid>.<ext>`**
   when the staged object is gone, using the credit metadata saved on the photo
   doc (§3.4). The bytes are identical (the mirror is a byte copy), so the md5,
   and with it the claim and the photo id, still agree.
2. **An alert on unarchived age:** any photo with `archivedAt == null` older than
   48 h (or 7 days while the event-scale settings are up). That turns "Drive
   silently stopped archiving" into a page instead of a lifecycle loss.

Keep the 14/30-day lifecycle numbers. Ingest normally runs well ahead of the
archive, so this change doesn't push the at-rest staging volume past what a Drive
backlog already holds.

### 4.3 Staging layout is unchanged

Objects stay at `<VOLUNTEER_STAGING_PREFIX>/<eventId>/<batchId>/<uploadId>.<ext>`
with the custom metadata `createResumableSession` stamps today. **The listing
is the ingest ledger.** No new collection is needed, because a GCS list returns
`md5Hash`, `timeCreated`, `contentType` and custom metadata for every object in
the page, and only finalized objects are listed (a half-done resumable session
isn't). A side effect: a session that never reached `/complete` is still
ingested, so finished photos from a closed tab become visible without waiting for
the sweep. The sweep then only has to archive them.

---

## 5. The indexer: two modes, one lock

`indexer/job.py` keeps one entry point with `INDEX_MODE=ingest|reconcile`
(default `reconcile`, which is today's behaviour plus §5.2). Both modes take the
same `indexState` in-flight claim (`services/indexTrigger.ts`), so they can never
race on the manifest. Every guard keyed off `indexState` (the stranded-derivatives
sweep's in-flight skip, the stale-run recovery) covers both.

### 5.1 `ingest`: staging → gallery, add-only

1. Require the `events/<eventId>` doc to exist. **This is how a deleted event
   is kept dead**, because staged bytes outlive event deletion by design (§6.6).
   `driveFolderId` is *not* required.
2. List staging under `<prefix>/<eventId>/`, keeping image MIME types only.
3. For each object: md5 from the listing (on Azure, computed; see §3.2), then
   `pid = md5_map.get(md5) or c1(eventId, md5)`. Skip it if `pid` is in the
   previous manifest, or if it's tombstoned (§6.1).
4. Process the rest exactly as `_process` does now, except the bytes come from
   `blobs.read(staging)` instead of `drive.download`: embed, read EXIF, mirror
   `orig/web/thumb`. `addedAt` = the object's `timeCreated`. `name` = the
   credited name (`buildCreditedFileName`, ported). `relPath` = the path the
   archive will land at (`Club/tag/<batchFolderName>/<name>`, using the folder
   name `/complete` already records on `upload_batches`).
5. Upsert each photo doc **as soon as its derivatives are written** (thumb
   before doc, the same ordering as today, so a listed photo never 404s its
   thumb), with `archivedAt: null`. Then write the store once at the end.
   - The gallery fills in photo by photo during the run. Find-Me sees the new
     photos when the store is written. A run killed in between leaves docs that
     aren't in the manifest; the next run computes the same ids and redoes
     them. The stranded-derivatives sweep can't touch them, because they have
     docs.
6. **Never removes anything.** No Drive listing, no `removed` set.

Trigger: each `/complete` flush (every `FLUSH_EVERY` = 100 files) calls
`triggerIndexJobUnlessInFlight(eventId, { mode: 'ingest' })`, the same guard
the worker uses now. index-scan gains a **staging fingerprint** (count + newest
`timeCreated` under the event's prefix) next to `computeDriveSig`, and triggers
`ingest` when it changes.

### 5.2 `reconcile`: Drive → attach archive copies, detect deletions

Today's run, with four changes:

1. **Ids go through the md5 map** (§3.3). A Drive file whose md5 is already
   indexed **attaches**: its id joins `driveFileIds`, `archivedAt` is set if
   null, and `name`/`relPath` take the Drive values (so the capture-time rename
   and name sort keep working). No download, no embed. Only md5s new to the
   index (admin drops) are downloaded from Drive and embedded.
2. **The "canonical = first by relPath" collapse goes away.** Every Drive copy
   of an md5 lands in that photo's `driveFileIds`, so `manifest.duplicates` is
   derived from it and no photo's id can flip.
3. **New removal rule** (risk #1). A photo is removed only when **all** of these
   hold:
   - `archivedAt` is set (it has been in Drive), **and**
   - none of its `driveFileIds`, and no other file with its md5, is in this
     listing, **and**
   - it isn't in `skipped_ids` (the existing carve-out for transient failures).

   A photo with `archivedAt == null` is **never** removed by reconcile, only by
   an explicit delete (§6.1). The `_remove_photo_blobs` sweep follows the same
   predicate, because it runs on the same `removed` list.
4. **Drive's view takes precedence over staging for name/relPath, never for
   identity.**

Cadence: as today (index-scan when the Drive fingerprint changes). During an
event, `event-scale.sh up` should stretch reconcile to every ~60 min, so the
fast path isn't blocked for long (§5.4).

### 5.3 The matcher's cache must notice new photos

`matcher/store.py` `EmbeddingStore.load_event` caches an event's vectors per
instance and **nothing calls `invalidate`** (observed in the code, not verified
in production). With scale-to-zero, instances recycle often enough that this
hasn't mattered. Under `event-scale.sh up` (min-instances=1, the warm window) a
warm matcher would keep serving the store as it was when it loaded, so faster
indexing would never reach Find-Me. Fix: on each `/match`, compare the
manifest's GCS `generation` (one metadata GET, ~10 ms) with the cached value
and reload when it changed. Small, independent of this design, and worth doing
first (§8 step 1).

### 5.4 Scaling limit: the single-writer store

Every run, in either mode, loads and rewrites the whole `faces.npy` /
`persons.npy` / `manifest.json` (≈23–25 KB per photo; 2.5 GB at 100k photos), and
only one run per event may be in flight. For events of ≤10k photos that's
seconds, and the design above meets the target. At NYC-Marathon scale:

- each ingest pass pays minutes of store I/O to add 100 photos, and
- a reconcile (a 100k-photo Drive listing plus the rewrite) holds the lock for
  tens of minutes, and ingest waits behind it.

**Segmented store** (proposed, decision D3): ingest writes
`embeddings/segments/<runId>/{faces.npy,persons.npy,manifest.json}` and never
rewrites the base. The matcher loads base + segments. Reconcile (or a periodic
compaction) folds segments into the base and applies removals. That also
delivers the ROADMAP's "indexer incremental checkpointing" item. It touches the
matcher, outfit-tagger and `audit-person-crops.sh` readers, so it's scoped as
its own phase (§8 step 6), not a prerequisite.

---

## 6. What changes in each consumer

### 6.1 Admin photo delete (`routes/gallery.ts` DELETE) and tombstones

Today: `trashFile(photoId)` → `deletePhotoDerivatives` → delete doc →
`releaseClaimsForDriveFile(photoId)`. **Two calls assume id == Drive id.**

New:

1. Write a **tombstone** `photo_tombstones/<pid>`: `{eventId, md5, deletedAt,
   by, stagedObjects: [...]}`.
2. Trash **every** id in `driveFileIds` (fall back to `[photoId]` when the
   field is absent and `idScheme` isn't `c1`). Soft delete only, with
   `Deleted_Files` rows (the G5.1 lifecycle). Never `files.delete`.
3. Delete the derivatives, then the doc (as today).
4. Release claims **by claim id** (`claimId(eventId, md5)`), not by Drive id.
5. Staged objects are **not deleted** (soft-delete only, CLAUDE.md). The
   tombstone makes them inert:
   - ingest skips any `pid` with a tombstone;
   - the archiver checks the tombstone before copying, skips if present, and
     leaves the object for the lifecycle;
   - reconcile soft-deletes (trash + `Deleted_Files` row) a Drive copy of a
     tombstoned `pid` **created before `deletedAt` + 1 h**. That catches a copy
     that was mid-flight when the admin deleted. A deliberate re-upload days
     later is a new photo (D5).

Restore (`adminDeletedFiles.ts` untrash) deletes the tombstone. The next
reconcile then sees the Drive file, computes **the same `c1_` id**, and the
photo returns with its match history intact. That's a small improvement on
today's behaviour.

### 6.2 Gallery list / lightbox (`routes/gallery.ts`)

No query change: it still lists `photos where eventId == X`, and photos without
an archive copy are listed like any other. The defensive per-page contentHash
de-dupe stays (harmless, and still needed for legacy events). Optional admin-only
badge: "not yet in Drive" when `archivedAt == null`.

### 6.3 Download / "Save to Photos" (`routes/download.ts`, `gcsService.signOrigUrl`)

**No change.** Both already read `<eventId>/photos/orig/<photoId>.<ext>` from the
derivatives bucket with a signed URL (302 / JSON of URLs). The ingest pass writes
that object for staged photos the same way it does for Drive photos. The
originals-via-signed-URL invariant holds untouched. The download filename comes
from the doc's `name`, which is the credited name before archive and the Drive
(capture-time-renamed) name after.

### 6.4 Find-Me matcher, `match_runs`, `match_feedback`, outfit-tagger

- **The matcher and outfit-tagger need no change.** photoId is an opaque string
  in manifest rows, results, anchors and crops, and outfit-tagger reads
  `orig/<pid>` exactly as written. They do need the cache fix in §5.3, and
  outfit-tagger events need re-preparing to pick up new photos (as today).
- **`match_runs` / `match_feedback` / verdict batches:** new rows simply carry
  `c1_` ids. Old rows keep legacy ids, which stay valid because legacy photos
  are never renamed. The eval tooling (`run_eval.py`, replay) needs no change.
- **The api's optional-on-the-wire tolerance** (anchor ids etc.) is unaffected.

### 6.5 Duplicate-files tool (`duplicateFilesService.ts`, `duplicateRemovalQueue.ts`)

It still removes redundant **Drive** files (layer 3). Changes:

- The survivor rule ("first in relPath order, by code point") stops being
  load-bearing. Under md5 identity, any surviving copy keeps the photo, and the
  next reconcile just shrinks `driveFileIds`. **Keep the rule anyway.** It is
  still deterministic, and before reconcile ships it still protects legacy
  photos whose id is the canonical's Drive id.
- After a removal run, the photo's `driveFileIds` lists trashed copies until the
  next reconcile. `reindexRecommended: true` already says so.
- It never sees staging, and it must never count a not-yet-archived photo as
  missing. It doesn't: it only reads Drive.
- All its non-negotiables (dry run by default, soft delete, enqueue + drain,
  managed folders never walked, no-md5 always kept) are unchanged.

### 6.6 Event deletion (`eventDeletionService.ts`)

The five stores and their order are unchanged, and **staged uploads are still
never deleted.** Additions:

- **The preview counts not-yet-archived photos** (`archivedAt == null`) and
  warns: *"N photos are not in Drive yet; deleting the derivatives removes one
  of their two remaining copies (the other is staging)."* Deleting an event is
  explicit intent, so this is a warning, not a block.
- Delete `photo_tombstones` where `eventId == X` with the other Firestore
  caches.
- **Ingest refuses an event with no `events` doc** (§5.1 step 1). That is what
  stops the kept staging bytes from re-creating the gallery of a deleted event.
  The archiver must refuse too: today the sweep can dispatch for a deleted
  event, and it fails in `resolveEventFolderId` every hour. Make that an
  explicit, logged skip.

### 6.7 Stranded-derivatives sweep (`sweep-stranded-derivatives.sh`) and the indexer's own sweep

- The four gates (absent from the manifest, **no Firestore doc**, event not in
  flight, older than 24 h) stay correct for `c1_` ids. Ingest takes the same
  `indexState` claim, so a mid-ingest object counts as in flight.
- The class of bug that created the backlog (canonical flips) can't recur for
  new photos (§3.2, point 3). The script stays useful for the legacy backlog.
- The indexer's `_remove_photo_blobs` uses the §5.2 removal rule. **It must not
  run on "absent from the Drive listing" alone.**

### 6.8 Upload recovery + never-completed sweep (`uploadRecoveryService.ts`, `uploadSweepService.ts`)

**This is risk #2.** Today `stranded = staged objects whose md5 is not in
Firestore photos.contentHash` (`uploadRecoveryService.ts` ~L213), and the sweep
marks a batch "nothing owed" on the same test. After ingest, a photo is in the
index **before** it's in Drive, so both would decide nothing is owed and stop
archiving.

New test: an object is **owed to Drive** unless its md5's claim is stamped with
a `driveFileId`, or its photo doc has `archivedAt` set. Everything else is
unchanged: dispatch reuses `enqueueStagedBatch`, the md5 claim stays the
authoritative check, and chunks stay staggered and costed by bytes.

**This change must ship before the ingest flag can be turned on for any event**
(§8). It is also correct on its own: "is it archived" is the question these
tools were always asking. "Is it indexed" was only a proxy that happened to be
equivalent while Drive was the only way into the index.

### 6.9 The archive worker (`enqueueStagedBatch`)

Mostly unchanged: same claim, `appProperties.uploadDedupKey` stamped in the
same request, the same throw-doesn't-prove-absence check, batch folder resumed
on retry, managed-folder rebuild. Changes:

- Staged deletion after a copy goes through `releaseStagedIfSafe` (§4.1).
- It checks the tombstone before copying (§6.1).
- It falls back to the `orig/` mirror when the staged object is gone (§4.2).
- It stamps `appProperties.photoId` next to `uploadDedupKey`. Nothing needs it
  for correctness (md5 does that), but it makes a Drive file self-describing
  for an operator.
- `upload_batches` phases: the worker no longer owns "in the gallery". See D6.

### 6.10 Managed folders, public folder index, Upload_Log

No change. They're built from Drive and keep following the archive. Photos_NNN
and Album shortcuts point at Drive file ids, which still exist once archived.
A photo appears in the gallery before it appears in Album. That's expected and
should be stated in the admin docs.

### 6.11 Capture time, `addedAt`, sorting

- `takenAt`: EXIF from the staged bytes, the same top tier as today, so the value
  doesn't change when the Drive copy attaches.
- `addedAt`: the staged object's `timeCreated` at ingest. Reconcile **does not**
  overwrite an existing `addedAt` with Drive's `createdTime`, which would make
  photos jump in the newest-first sort when the archive lands.
- `name` sort: a photo's name changes once, from the credited name to the
  capture-time-renamed Drive name. The prefix only adds a timestamp, so its
  position barely moves. Accepted.

---

## 7. Feature flag

Two switches, because the identity change and the ingest path roll out
separately:

| Switch | Where | Default | Controls |
|---|---|---|---|
| `PHOTO_ID_SCHEME=c1` | indexer env | `drive` until §8 step 2 | whether **new** photos get `c1_` ids. The md5 map and the §5.2 removal rule are **unconditional**, so flipping back to `drive` is safe: existing `c1_` photos are found by md5 and kept |
| `events/<id>.ingestMode = "storage-first"` | per event (Firestore, set by admin UI/script) | absent = `drive` | whether `/complete` and index-scan trigger `ingest` for this event |
| `STORAGE_FIRST_ENABLED` | api env | `false` | global kill switch over the per-event field |

**Turning ingest off is safe:** reconcile still archives and indexes everything
through Drive, as today. Photos ingested while it was on keep their `c1_` ids,
and their Drive copies attach to them.

---

## 8. Rollout order and verification

Each step ships and is verified on its own. **Steps 0–4 change nothing a user
can see.**

0. **Measure md5 parity (read-only).** For every `upload_dedup` claim on
   `4207f053` stamped with a `driveFileId`, compare the claim's md5 with Drive's
   `md5Checksum` for that file. Expect 100%. Any mismatch (a transform we don't
   know about) blocks the whole design. Also confirm every staged object on the
   GCS side has an `md5Hash` (not composite).
1. **Matcher cache revalidation (§5.3).** Independent; worth shipping now.
2. **Consumers stop assuming id == Drive id:** admin delete via `driveFileIds`
   with a fallback, claim release by claim id, tombstones (§6.1); recovery/sweep
   "owed = not archived" (§6.8); `releaseStagedIfSafe` + staging GC (§4.1). Verify:
   - **No behaviour change on today's data.** Every legacy photo is archived by
     definition, so the recovery dry run on recent events must report the same
     owed set before and after.
   - Unit tests pin "indexed but not archived ⇒ owed" and "unstamped claim ⇒
     staged object kept".
3. **Indexer identity (`reconcile` with the md5 map, `PHOTO_ID_SCHEME=drive`).**
   The map, `driveFileIds`/`archivedAt` backfill, the new removal rule, and the
   map loaded under `FORCE_REINDEX`/model-version change. Verify on a copy of a
   real event's manifest, then on a small live event:
   - the set of photo ids is **identical** before and after (no legacy id
     changes; any difference must be a real Drive deletion);
   - a `FORCE_REINDEX=1` run keeps every id;
   - trashing a duplicate pair's canonical copy in a test event **keeps** the
     photoId (today it flips);
   - `audit` (below) shows zero duplicate contentHash per event.
4. **`PHOTO_ID_SCHEME=c1`.** New Drive-only photos get `c1_` ids. Verify a
   test-event photo end to end: gallery, lightbox, Save to Photos, ZIP, Find-Me
   (including an anchor on it), feedback vote, admin delete → restore (the same
   id comes back).
5. **Ingest behind `ingestMode`, on a test event first.** Pause the upload queue
   (or point the link at an event whose Drive copy is held), upload 50 photos,
   and check:
   - photos appear with `archivedAt == null` and no Drive file;
   - resuming the queue attaches each Drive copy to **the same** id: zero new
     docs, `driveFileIds` populated, `archivedAt` set;
   - staged objects are deleted only after both conditions hold;
   - kill tests: kill an ingest run mid-way (docs without a manifest, redone
     idempotently by the next run); kill the worker mid-copy (the existing claim
     path); admin-delete a photo while its copy is mid-flight (the tombstone
     trashes the late copy).

   Then one real small event, then a big one with `event-scale.sh up`.
6. **Segmented store (§5.4)**, if D3 says yes, before the next 50k+ photo event.

**Standing checks** (one script, `infra/scripts/audit-storage-first.sh`,
read-only, exit non-zero on a violation):

- photos per event grouped by `contentHash` with more than one doc → must be 0;
- `archivedAt == null` older than the alert threshold → list;
- staged objects with no photo doc, older than 2 h, not tombstoned → list
  (ingest is behind or failing);
- each photo doc has its `thumb`/`web`/`orig` objects (sampled);
- **guard against a vacuous check**, as CLAUDE.md warns for the stranded-derivatives
  sweep: assert that a known-archived photo is reported archived and a
  known-staged one isn't, so a broken `archivedAt` read can't look like an
  all-clear.

**Metric:** time-to-visible = photo doc `createTime` − staged `timeCreated`, p50
and p95 per event, logged by ingest. This is the number the whole change exists
to move.

---

## 9. Risks (ranked)

1. **The reconcile removal rule (§5.2.3).** If anything keeps treating "not in
   this Drive listing" as "deleted", every unarchived photo disappears from the
   gallery on the next reconcile *and* its derivatives are swept. Together with
   an expired staging object, that is permanent loss. Mitigations: the
   `archivedAt` gate, unit tests in `test_job.py` pinning "unarchived ⇒ never
   removed", and the step 3 check that the id set is unchanged.
2. **Recovery/sweep reading "indexed" as "archived" (§6.8).** A silent stop of
   the Drive archive, found only when someone notices Drive is missing photos.
   By then the lifecycle may have taken the staged copies. Mitigations: ship the
   §6.8 change in step 2, *before* any event can ingest; alert on unarchived age
   (§4.2); fall back to the `orig/` mirror.
3. **One store writer per event (§5.4).** At marathon scale, ingest waits
   behind reconcile and every pass rewrites gigabytes. That doesn't break
   correctness, but it erases the latency win exactly when it matters.
   Mitigations: the reconcile cadence knob in `event-scale.sh`; the segmented
   store (D3).

Also worth watching:

- **Identity map skipped on force/model change (§3.3).** That would duplicate
  a whole event. Pinned by a test.
- **A deleted event resurrected from kept staging bytes (§6.6).** Prevented by
  ingest requiring the `events` doc.
- **Azure md5 gap (§3.2).** The ingest pass handles it; the worker's claim key
  doesn't, until D7.
- **Gallery ≠ Drive for a while.** Admins used to "if it's in Drive it's in the
  gallery and vice versa" now see photos that aren't in Drive yet. The
  unarchived badge and the alert make that legible.

---

## 10. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Identity scheme | **`c1_` + `claimId(eventId, md5)`** (§3.2 A) |
| **D2** | Migrate legacy photo ids? | **No, coexist permanently** (§3.3). Renaming breaks match history and judged eval sets for no gain |
| **D3** | Build the segmented store (§5.4) as part of this work, or ship ingest with the single-writer store and do segments before the next 50k+ event? | Ship without segments (steps 0–5 meet the target for ≤10k-photo events); **schedule segments before the 2027 marathon season** |
| **D4** | Staging retention: keep 7/14/30-day lifecycles plus the `orig/` fallback, or hold staged objects until archived regardless of age? | **Keep the lifecycles + `orig/` fallback + unarchived-age alert.** Holding forever means a stuck archive is a silent, growing bill |
| **D5** | Tombstone scope: a deleted photo blocks (a) only the staged objects and Drive copies in flight at deletion (+1 h window), or (b) its md5 in that event forever? | **(a).** Today a re-upload after an admin delete comes back, and (b) would quietly change that |
| **D6** | What the volunteer upload page promises: add a "visible in gallery" phase ahead of "saved to Drive" (`received → visible → archived`)? | **Yes.** It's the user-facing point of the change. Wording needs the owner's sign-off |
| **D7** | Azure: compute md5 server-side in the worker too, so its claim joins the photo id (today it falls back to `name|size` there)? | Yes, as part of the Azure migration plan, not this one |
| **D8** | First production event for `ingestMode = storage-first` | A small club event with an organizer who knows it's a pilot. Not a marquee race |

---

## 11. Cost

All figures are list prices (us-central1, verify before relying on them). The
billing export is still not enabled, so none of this can be checked from the CLI
today.

| Line | Today | Storage-first | Delta |
|---|---|---|---|
| **Staging storage** (Standard, ~$0.020/GB-mo) | held until the Drive copy: minutes normally, days in a 750 GB/day backlog | held until **indexed and** archived. Ingest normally finishes first, so ≈ the same | ≈ $0 normally. Worst case, if we chose to hold 100k photos (~600 GB) a full month: ~$12 |
| **Indexer reads** | from Drive (no charge) | from staging, same region as the job: **no network egress**; Class B reads ~$0.004 per 10k | ~$0.04 per 100k photos |
| **Indexer compute** | one long run per change set | more, shorter runs; each pays a fixed overhead (cold start, model load, store load/write) | small events: noise. **100k-photo event: ~$0.04 overhead per ingest pass** (≈180 s × 8 vCPU × $0.000018 + 180 s × 32 GiB × $0.000002). Every 5 min for a day ≈ **$11/day** while the event-scale settings are up. The segmented store (D3) removes most of it |
| **Matcher** | one reload per instance lifetime | one reload per manifest change (§5.3) | more frequent cold loads during an event. Shows up as latency, not a billing line, under scale-to-zero |
| **Firestore** | ~1 write per photo | +1 attach write per photo (archive lands), +1 doc read per file in the worker | ~$1.80 per 500k photos (writes ~$0.18/100k) |
| **Derivatives storage** | 3 objects per photo | the same 3 objects; fewer stranded (no canonical flips) | ≤ 0 |
| **Internet egress to users** (the real meter, CLAUDE.md: Aug 2026 was $20 of $30) | signed `orig`/`web`/`thumb` URLs from the derivatives bucket | **identical mechanism and objects** | $0 per photo. Photos become visible sooner, so a live event's downloads may start earlier, but the bytes per download don't change |
| **Drive** | free | still free; the same copies, just off the critical path | $0 |

**Net:** pennies per event at today's sizes. The only line that scales is
indexer overhead at 100k-photo events (~$10/day during the event window), and
that's an argument for D3, not against the design. The zero-idle-cost policy is
untouched: ingest is a Cloud Run Job execution that only runs when staging
changed, and the new GC step lives inside the existing hourly sweep tick.
