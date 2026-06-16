# Product Requirements Document — "Find Me" Face & Person Matching

**Project:** 湘舍动公益文件系统 (Event Photo Database)
**Feature:** Self-service photo discovery via face + person re-identification ("Find Me")
**Prepared for:** IT Department, Youth4AM / mmrunners
**Date:** June 8, 2026
**Status:** Draft for review
**Related docs:** `UX_AND_GCP_ASSESSMENT.md`, `STORAGE_AND_DATABASE_OPTIONS.md`, `cloud-webapp/ARCHITECTURE.md`, `UPLOAD_PREP_FEATURE_SPEC.md`, `PUBLIC_SHARING.md`

---

## 0. Decisions locked for this PRD

These were confirmed before drafting and are treated as fixed constraints. Everything below follows from them.

| # | Decision | Implication |
|---|---|---|
| D1 | **Matching engine:** open-source embedding model (e.g. InsightFace/ArcFace for faces, a person-ReID model for bodies) running in a Cloud Run container, with embeddings indexed in **Vertex AI Vector Search**. | Stays 100% on Google Cloud, no per-face vendor fees, full control of biometric data. No third-party face API. No turnkey "Google face-ID" exists — we build the matcher. |
| D2 | **Matching scope:** **face + outfit/person re-identification.** A query can match on facial similarity *and* clothing/body appearance. | Handles back-of-head, sunglasses, hats, and group shots where the face is small or turned. Two embedding spaces, fused at ranking time. |
| D3 | **Users & auth:** **Find Me is not publicly exposed.** It is reachable only via a **share link** to an event or by **member login** (Google sign-in via Firebase Auth). Plain gallery browsing can still follow `PUBLIC_SHARING.md`, but the selfie-upload/search action requires sign-in. | Firebase Auth (already in the stack). Gives us identity for consent, feedback attribution, rate-limiting, and per-user Drive storage. Reduces the risk surface of a public face-search tool. |
| D4 | **Subjects & consent:** **photos may include minors**, and the org **already has a photography/media release** covering attendees. | Media release covers *being photographed*. It does **not** automatically cover *biometric processing*. We layer a biometric-consent gate on top and apply stricter handling for minors (see §8). |
| D5 | **No Google Apps Script.** Full cloud version on the `cloud-webapp` stack. | The existing GAS app (`gas-app/`) is not extended. This feature ships as new routes/services inside `cloud-webapp` + the matcher microservice. |
| D6 | **Drive remains SSOT.** Event photos live in Google Drive (100 TB Workspace pool) as today; **user-uploaded match photos are also stored in Google Drive.** | Drive is archive/SSOT only. Serving and matching happen from Cloud Storage mirrors, per `STORAGE_AND_DATABASE_OPTIONS.md`. |
| D7 | **Identity reuse: enabled.** A signed-in member can **enroll a reference selfie once and reuse it across future events** rather than re-uploading every time. | Adds a persistent, opt-in **face enrollment** (`face_enrollments`). Higher convenience, but persistent biometric data — so it is opt-in, member-only, deletable any time, and out of scope for minor subjects unless a guardian enrolls on their behalf (§8.3). Changes the v1 non-goal that previously forbade persistent enrollment. |
| D8 | **Minor subjects:** **a guardian must perform the search** (guardian-attested). Confirmed as the default, pending legal review. | No lighter-weight self-attestation for minors in v1. |
| D9 | **Retention windows confirmed:** 90 days (adult) / 30 days (minor) for reference uploads and derived embeddings, aligned with the org safeguarding policy. | Implemented as the defaults in §8.4. |

---

## 1. Overview

### 1.1 Problem

After every event, photographers upload hundreds to thousands of photos to Google Drive. Attendees currently have no way to find the photos *they* appear in — they scroll entire albums or rely on someone tagging them. This is slow, frustrating, and means most attendees never see (or download) their own photos. Volunteers field repeated "can you find my pictures?" requests by hand.

### 1.2 Solution

A "Find Me" experience layered onto the event photo galleries. An attendee opens an event, taps **Find Me**, uploads a photo of themselves (ideally one showing the outfit they wore that day), and the system returns only the gallery photos they likely appear in — ranked by a fused face + outfit/person similarity score. They can upload several reference photos (each producing its own filtered set), batch-select results, and download or save to their phone. If a match is wrong, they can flag it, which feeds quality monitoring and model tuning.

### 1.3 Why this fits the existing plan

The migration plan in `UX_AND_GCP_ASSESSMENT.md` and the architecture in `cloud-webapp/ARCHITECTURE.md` already commit to Firebase Hosting + Cloud Run + Firestore + Cloud Storage + Firebase Auth, with Drive as cold SSOT and Cloud Storage as the hot serving origin. This feature is a natural extension: it adds (a) an indexing pipeline that computes embeddings for gallery photos, (b) a matcher microservice (same pattern as the existing `cloud-run/main.py` image-conversion service), and (c) new frontend pages and API routes. No new architectural paradigm is introduced.

### 1.4 Non-goals (v1)

- Not building general face search across *all* events at once (matching is scoped to one chosen event per query — bounds cost, latency, and privacy blast radius). Note: with identity reuse (D7) a member's *enrolled selfie* may be reused to search *new* events, but each search still runs against one event's index.
- Not auto-tagging or naming people. The system returns "photos similar to your reference," never "this is person X."
- Not a public face-search tool. Find Me is gated behind a share link or member login (D3). You can only search using a photo you upload or your own enrolled selfie; you cannot search for *other* people by name.
- Not replacing the existing admin curation/upload workflows in `gas-app`.
- Not real-time/live matching during an event. Indexing runs after photos land in Drive.

---

## 2. Goals & success metrics

| Goal | Metric | Target (90 days post-launch) |
|---|---|---|
| Attendees can find their own photos | % of attendees who run ≥1 search and download ≥1 photo | ≥ 40% of event attendees who open a gallery |
| Matching is accurate enough to trust | Precision@20 (fraction of top-20 results that truly contain the user), measured via feedback + spot audits | ≥ 0.85 |
| Few real photos missed | Recall on a labeled holdout set per event | ≥ 0.80 |
| Fast enough to feel instant | p95 end-to-end search latency (upload → results) | ≤ 6 s |
| Cheap enough for the credit | Monthly GCP spend attributable to this feature | ≤ $40/mo before credit; $0 after |
| Trustworthy on privacy | % of searches preceded by an accepted consent gate; biometric-data retention incidents | 100%; zero |
| Self-service deflection | Reduction in manual "find my photos" volunteer requests | ≥ 70% |

---

## 3. Personas

- **Attendee (primary).** An event participant, possibly a minor, on a phone over mobile data. Wants their photos with minimal friction. Cares about privacy and not creating an account beyond a quick Google sign-in.
- **Parent/guardian.** For attendees under 18, the consenting party. May themselves search on behalf of their child.
- **Photographer / event admin.** Uploads photos to Drive, triggers/oversees indexing, reviews flagged matches.
- **IT/operator (Youth4AM IT).** Owns the GCP project, cost, security, consent records, and incident response.

---

## 4. User experience & functional requirements

The six-step journey from the request, expanded into requirements. Each requirement has an ID (`FR-n`) and acceptance criteria.

### 4.1 Step 1 — Choose an event

**FR-1.** The app shows a list of events the user is allowed to see (public events per `PUBLIC_SHARING.md`, plus any private events they have a link/permission for). Each event card shows name, date, cover image, and photo count.

*Acceptance:* Events render from Firestore `events` collection; private events not surfaced without a valid share token; list paginates and loads p95 < 1.5 s.

### 4.2 Step 2 — View the event gallery

**FR-2.** Clicking an event opens its gallery — a responsive, lazy-loaded thumbnail grid served from Cloud Storage via Cloud CDN with signed URLs (never Drive hotlinks, per `STORAGE_AND_DATABASE_OPTIONS.md`).

**FR-3.** A persistent **Find Me** button is visible in the gallery (floating action button on mobile, header button on desktop).

*Acceptance:* Thumbnails use signed URLs with ≤ 60-min TTL; grid virtualizes so a 2,000-photo album scrolls smoothly on a mid-range phone; Find Me is reachable without scrolling.

### 4.3 Step 3 — "Find Me": upload a reference photo and get filtered results

**FR-4.** Tapping **Find Me** prompts the user to sign in with Google if not already (D3), then to upload or capture a reference photo. Copy recommends a photo that clearly shows their **face and the outfit they wore at this event**.

**FR-5.** Before any biometric processing, the user must pass the **consent gate** (§8.2). For self-identified minors, the parental-consent path applies. Consent is recorded with timestamp, scope, and version.

**FR-6.** The system computes face and person/outfit embeddings from the reference photo, queries the event's vector index, fuses scores, and returns a filtered, ranked grid of candidate photos with a similarity indicator (e.g. "strong / possible match" bands, not raw scores).

**FR-7.** If no face is detected in the reference, the app explains and offers to match on outfit/appearance only (D2), or to upload a clearer photo.

**FR-8.** Results show a clear empty-state if nothing crosses the threshold, with tips (try a different photo, check the outfit is visible).

*Acceptance:* p95 upload→results ≤ 6 s for an event index up to ~50k photos; consent gate cannot be bypassed; reference with no detectable person returns a graceful error, never a 500; results default to a tuned threshold favoring precision, with a "show more (lower confidence)" expander.

### 4.4 Step 4 — Multiple reference photos, each its own filter

**FR-9.** The user can upload several reference photos within a session. Each produces its **own independent result set**, presented as switchable tabs/chips (e.g. "Selfie 1 · 18 photos", "Selfie 2 · 7 photos"). A combined "All my matches (deduplicated)" view is also available.

**FR-10.** Each reference photo and its result set persists for the session and (for signed-in users) is retrievable in their history until expiry (§8.4).

*Acceptance:* Adding a reference never discards a previous one; switching tabs is instant (results cached client-side); the combined view dedupes by photo ID and merges scores by max.

**FR-10b (identity reuse, D7).** A signed-in member may **save a reference selfie as an enrollment** ("Remember me for future events"). On a new event, a one-tap **"Use my enrolled photo"** runs Find Me without re-uploading. Enrollment is explicitly opt-in, shown in a "My data" screen, and deletable at any time (cascades to embedding + Drive/Cloud Storage copies). Enrolling a minor follows the guardian path (§8.3). Enrollment carries its own consent record and retention (§8.4).

*Acceptance:* Enrollment is never automatic; a member can list, re-capture, and delete their enrolled selfie; deleting it removes the vector and all stored copies within the deletion-job SLA; minor enrollment is blocked unless guardian-attested.

### 4.5 Step 5 — Batch select, download, save to phone

**FR-11.** Results support multi-select (tap to select, "select all in this set", range select). A selection counter and a sticky action bar show **Download** and **Save**.

**FR-12. Download:** selected full-resolution photos are delivered as a zip (generated by the API streaming from Cloud Storage). For ≤ N photos (configurable, default 25) a direct multi-file download is offered; above that, a zip.

**FR-13. Save to phone's Photos:** on mobile, individual high-res images are exposed through the native share/save sheet (Web Share API Level 2 with files where supported; fallback to long-press save / direct download). True silent write to the OS photo library is not possible from a web app, so the UX uses the platform share sheet, which lets the user pick "Save to Photos / Gallery."

**FR-14.** Downloads are served via short-lived signed URLs; the API enforces that the requester is allowed to access that event's photos.

*Acceptance:* Batch of 25 full-res photos downloads as a single zip in p95 < 15 s on broadband; share sheet appears on iOS Safari and Android Chrome; no download link works after its signed-URL TTL; bulk download is rate-limited per user (§9).

### 4.6 Step 6 — Feedback when a match is wrong

**FR-15.** Every result photo has an unobtrusive **"Not me / wrong match"** control. Submitting it records: photo ID, the reference embedding ID, the user (if signed in), the fused score, and which signal(s) drove the match (face vs outfit). Optionally a free-text reason.

**FR-16.** Users can also positively confirm ("Yes, this is me") to provide labeled positives. Both feed the evaluation set and threshold tuning.

**FR-17.** Feedback immediately removes the photo from that user's current result set (optimistic UI) and is queued for review.

*Acceptance:* Feedback writes to Firestore `match_feedback`; submission is one tap + optional reason; feedback is visible in an admin review queue; aggregated false-positive rate per event is computed for §2 metrics.

### 4.7 Cross-cutting UX requirements

**FR-18.** Mobile-first, accessible (WCAG 2.2 AA): keyboard navigable, sufficient contrast, alt text, respects reduced-motion. Builds on the mobile fixes already shipped (`UX_AND_GCP_ASSESSMENT.md` §1).

**FR-19.** Localized EN + ZH, consistent with the existing bilingual UI.

**FR-20.** All states have explicit designs: loading, empty, no-face, low-confidence-only, over-rate-limit, consent-declined, and error.

### 4.8 Demo-feedback refinements (added 2026-06-15)

These come from hands-on use of the shipped demo fast-path (see DEV_PLAN §0 status banner, 2026-06-12) on the live event `d2307147-…`. Some are bugs in the demo slice; some are clarifications of requirements already specified above (FR-9/FR-11/FR-12/FR-15) that the demo deferred. Build tickets are in `FACE_MATCHING_DEV_PLAN.md` §5A.

**FR-1b (event name).** Each event must display its human-readable name, never a placeholder. The demo shows "Untitled event" because the Firestore `events` doc has no `name` (the indexer/sync never populated it). The indexer/Drive-sync must set `name` from the Drive folder name (with an admin-editable override), and the UI must fall back to a sensible label, never the literal "Untitled event", when a name is genuinely absent.

*Acceptance:* a freshly indexed event shows the Drive folder name on the Events list, the Gallery header, and the document title; admin can rename; no user-facing "Untitled event" string for an event that has photos.

**FR-2b (navigation back to event / events).** From the Gallery the user must be able to return to the event view and the Events list. Provide a back control (breadcrumb or back button) and ensure browser back works. The demo Gallery is a dead-end with no way back.

*Acceptance:* Gallery shows a persistent "← Events" (and event-level) affordance; browser back and the in-app control both return without a full reload or auth bounce; works on mobile.

**FR-2c (duplicate photos in the gallery).** The gallery must not show the same photo twice. Duplicates are de-duplicated at index time (preferred) and defensively at list time. Dedup key: content hash of the original (e.g. SHA-256 of bytes, or perceptual hash for re-encoded copies), not filename — the same shot can land in Drive under different names. A duplicate maps to a single `photoId`; its embeddings and gallery tile appear once.

*Acceptance:* indexing the live event produces no visually identical tiles; re-running index does not create new dupes; an audit query reports zero duplicate content hashes per event.

**FR-9b (show & switch the active reference selfie).** Results must make explicit **which uploaded selfie produced the current set**, and let the user switch between previously uploaded selfies to see each one's distinct result set. This sharpens FR-9/FR-10: the demo mixes results from multiple people's uploads into one undifferentiated set, which is the reported confusion. Each upload in the session/history is a selectable source (thumbnail + label + match count); selecting one shows only that selfie's matches; results never silently combine across different reference photos unless the user picks the explicit "All my matches (deduplicated)" view.

*Acceptance:* the active reference selfie thumbnail is visible above the results; an upload-history picker lists prior selfies for the session (and, for signed-in users, recent runs) with per-selfie match counts; switching selfies swaps the result set; no result set blends two different reference uploads except the explicitly-labeled combined view.

**FR-11/FR-12 reaffirmed — original-resolution batch download is the top-priority gap.** Batch ZIP download of **original full-resolution** files (FR-12) plus the selection UI (FR-11) are confirmed as the single most-wanted capability and are the highest priority of this backlog. Clarifications: the ZIP must contain originals (not the `web`/`thumb` derivatives); the selection bar must support **Select all**, **Select none**, and **select-all-then-deselect-wrong-ones** as first-class actions; download acts on the current selection.

*Acceptance:* as FR-11/FR-12, with the added assertion that ZIP entries are byte-for-byte the original Drive files (or the `orig` derivative when the original is unservable), and the three selection actions are present and keyboard-accessible.

**FR-15 reaffirmed — wrong-match feedback.** The "Not me / wrong match" control (FR-15) is in scope for this round so users can flag incorrect results; it pairs with FR-9b (a wrong match is often a different person's selfie bleeding in) to drive both removal and quality monitoring.

*Acceptance:* as FR-15.

---

## 5. System architecture

### 5.1 Component overview

```
                    ┌──────────────────────────────────────────────┐
                    │  Firebase Hosting  (photos.mmrunners.org)      │
                    │  React/Vite SPA  — gallery, Find Me, results   │
                    └───────────────┬──────────────────────────────┘
                                    │  /api/**  (same-origin rewrite)
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │  Cloud Run: api (Node/Express)                 │
                    │  • auth (Firebase ID token verify)             │
                    │  • events/galleries  • search orchestration    │
                    │  • feedback  • signed-URL minting  • zip stream │
                    └───┬───────────────┬───────────────┬───────────┘
                        │               │               │
                        ▼               ▼               ▼
              ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐
              │ Firestore    │  │ Cloud Storage  │  │ Cloud Run:       │
              │ events,      │  │ derivatives    │  │ matcher (Python) │
              │ photos,      │  │ (thumbs, hi-res│  │ • face embed      │
              │ embeddings   │  │  serving copy) │  │ • person/outfit   │
              │ meta,        │  │ + user uploads │  │   embed           │
              │ consent,     │  │   serving copy │  │ • detect/quality  │
              │ feedback     │  └────────────────┘  └─────────┬────────┘
              └──────────────┘                                 │
                        ▲                                       ▼
                        │                            ┌────────────────────┐
                        │                            │ Vertex AI Vector   │
                        │                            │ Search (per-event  │
                        │                            │ embedding index)   │
                        │                            └────────────────────┘
                        │
        ┌───────────────┴───────────────────────────────────────────┐
        │ Indexing pipeline (Cloud Run Jobs + Eventarc/Pub/Sub)      │
        │ Drive (SSOT) ──mirror──▶ Cloud Storage ──embed──▶ Vector   │
        │                                          index + Firestore  │
        └────────────────────────────────────────────────────────────┘

   Google Drive (100 TB Workspace pool)  = SSOT / cold archive
     • event photos (as today)
     • user-uploaded reference photos (D6)
```

### 5.2 Why these choices (delta from existing stack)

The web/api/Firestore/Storage/Auth layers are exactly the `cloud-webapp` stack — no change. Three things are new:

1. **Matcher microservice (Cloud Run, Python).** Same deployment pattern as `cloud-run/main.py`. Python is chosen because the mature open-source face/ReID models (InsightFace/ArcFace, OSNet/TransReID-style person-ReID) and ONNX Runtime are Python-first. Scales to zero; warm instances kept during event weekends.

2. **Vector index for embeddings.** Default: **Cloud SQL + pgvector** (chosen for cost — see §10.1), with one logical namespace/filter per event so a query only ever searches one event, bounding the privacy blast radius. **Vertex AI Vector Search** is the managed alternative if an event index ever grows into the millions of vectors or needs very high sustained QPS; it's pin-compatible with the design but its always-on node billing makes it the wrong default at this scale.

3. **Indexing pipeline (Cloud Run Jobs + Pub/Sub/Eventarc).** Detects new photos, mirrors Drive→Cloud Storage, runs detection + embedding, writes vectors to the index and metadata to Firestore.

### 5.3 GPU vs CPU for the matcher

Face + person embedding models run acceptably on CPU for *query time* (one reference photo) at the target latency. **Bulk indexing** of thousands of photos benefits from GPU. Plan: indexing Cloud Run Job uses a GPU-backed configuration (or batched CPU during off-peak) and the online matcher runs CPU-only and scales to zero. Revisit if indexing throughput is too slow (§10 risk).

---

## 6. Data model

### 6.1 Storage layout

**Google Drive (SSOT / cold archive):**
- `/<Event>/originals/…` — event photos as uploaded (unchanged from today).
- `/_find_me_uploads/<eventId>/<userId>/<uploadId>.<ext>` — **user reference photos** are written here (D6). This is the canonical store of what users submitted; Cloud Storage holds only a working copy.

**Cloud Storage (hot serving + processing):**
- `gs://…-derivatives/<eventId>/<photoId>/{thumb,web,orig}.jpg` — serving copies of gallery photos.
- `gs://…-uploads/<eventId>/<userId>/<uploadId>.jpg` — working copy of the reference photo for embedding + result display, with a lifecycle rule (§8.4).

### 6.2 Firestore collections (additions)

| Collection | Key fields | Notes |
|---|---|---|
| `photos` (extend) | `eventId`, `driveFileId`, `gcsPaths`, `width/height`, `indexState`, `personCount`, `faceCount` | One doc per gallery photo. `indexState` tracks the embedding pipeline. |
| `photo_embeddings_meta` | `photoId`, `eventId`, `faceVectorIds[]`, `personVectorIds[]`, `model`, `modelVersion`, `createdAt` | Vectors live in Vertex Vector Search; this maps photo→vector IDs and model version for re-index. |
| `find_me_uploads` | `uploadId`, `eventId`, `userId`, `driveFileId`, `gcsPath`, `hasFace`, `consentId`, `expiresAt` | One per reference photo. References the consent record. |
| `match_runs` | `runId`, `uploadId`, `userId`, `eventId`, `resultPhotoIds[]`, `scores`, `threshold`, `createdAt` | A search execution + its results (for history and audit). |
| `match_feedback` | `feedbackId`, `runId`, `photoId`, `uploadId`, `userId`, `label` (`wrong`/`confirmed`), `signal` (`face`/`outfit`/`fused`), `score`, `reason?` | Powers metrics + tuning + admin review. |
| `consents` | `consentId`, `userId`, `subjectIsMinor`, `guardianAttested`, `scope`, `policyVersion`, `eventId?`, `grantedAt`, `revokedAt?` | Immutable append; revocation triggers deletion job (§8). |
| `face_enrollments` (D7) | `enrollmentId`, `userId`, `vectorId`, `driveFileId`, `gcsPath`, `subjectIsMinor`, `guardianAttested`, `consentId`, `model`, `modelVersion`, `createdAt`, `lastUsedAt`, `expiresAt` | Persistent opt-in selfie for reuse across events. One active enrollment per user in v1. Deletable; deletion cascades to vector + stored copies. |

### 6.3 Embedding records (Vertex Vector Search)

Each vector carries restricts/filters: `eventId` (mandatory filter so queries never cross events), `type` (`face`|`person`), `photoId`, `modelVersion`. Two vector types coexist in one per-event index, filtered by `type` at query time so face queries hit face vectors and outfit queries hit person vectors.

---

## 7. Matching pipeline (detail)

### 7.1 Indexing (offline, per event)

1. **Trigger.** New/changed files in the event's Drive folder are detected (scheduled Drive change scan or admin "Index event" action — no Apps Script; uses Drive API from a Cloud Run Job with a service account).
2. **Mirror.** Download original from Drive → write serving derivatives (thumb/web/orig) to Cloud Storage. Reuse the conversion logic patterns from `cloud-run/main.py` (HEIC/RAW handling, EXIF orientation).
3. **Detect.** Run face detection + person detection on each photo. Record `faceCount`, `personCount`.
4. **Embed.** For each detected face → face embedding; for each detected person → person/outfit embedding. Quality filtering drops tiny/blurry crops below a configurable size.
5. **Write.** Upsert vectors to the event's Vertex index with metadata; write `photos` + `photo_embeddings_meta` in Firestore; set `indexState=indexed`.
6. **Idempotent & versioned.** Re-running re-embeds only changed photos or photos whose `modelVersion` is stale.

### 7.2 Query (online, per search)

1. Verify auth + consent. Write the reference photo to Drive (SSOT) and a working copy to Cloud Storage.
2. Detect face(s)/person in the reference. If multiple people, use the largest/most central, and tell the user.
3. Compute face embedding and person/outfit embedding.
4. Query the event index twice (face-vs-face, person-vs-person), each filtered by `eventId`.
5. **Fuse.** Combine the two ranked lists into one score per photo. Default fusion: weighted max/sum with face weighted higher when a confident face match exists, falling back to outfit when no face is present (D2). Weights are config, tuned against the feedback/eval set.
6. Apply the precision-favoring threshold; return photos above it, plus a lower-confidence expander.
7. Persist a `match_runs` doc; return signed thumbnail URLs for results.

### 7.3 Quality, tuning & evaluation

- A labeled eval set is bootstrapped from `match_feedback` (confirmed positives, flagged negatives) plus periodic manual spot-labeling per event.
- Thresholds and fusion weights are tunable without redeploy (Firestore/Remote Config), tracked against Precision@20 and Recall (§2).
- Model version is stamped on every vector and run so a model upgrade can be rolled out and A/B-compared per event.

---

## 8. Privacy, consent & child safety

This is the highest-risk area. Face matching produces **biometric identifiers**, which are special-category/sensitive data under GDPR and regulated by laws such as Illinois BIPA. The existing media release covers *being photographed*, not *biometric processing* (D4), and **photos may include minors** (D4) — so we treat consent and minimization as first-class requirements, not add-ons.

### 8.1 Principles

- **Purpose limitation.** Biometric processing is used only to help a person find photos of *themselves*. No identity database of named people is built; no cross-event surveillance; no sharing of biometric data with third parties (the engine is self-hosted, D1).
- **Data minimization.** One-shot reference-photo embeddings exist only as long as needed to serve the user's session/history, then are deleted (§8.4). **Enrolled selfies (D7) are the one deliberate exception**: a member opts in to persistent storage for cross-event convenience, with its own consent record, a `lastUsedAt`-based expiry, and one-tap deletion. Gallery embeddings are derived data that can be regenerated and are deletable per event.
- **Self-service only.** A user can search only with a photo they upload or their own enrolled selfie; they cannot search for other named individuals.

### 8.2 Consent gate (all users)

Before the first biometric operation in a session, the user must affirmatively accept a plain-language notice covering: what is processed (face/appearance), why, where data is stored (Google Cloud + Drive, within the org), how long it's kept, and how to revoke/delete. Acceptance writes a `consents` record with `policyVersion`. Declining blocks Find Me but not plain gallery browsing.

### 8.3 Minors (D4)

- The flow asks whether the person in the reference photo is under 18.
- If **yes**, it requires **guardian attestation**: the search must be performed by a parent/guardian who confirms authority to consent on the minor's behalf, recorded as `guardianAttested=true`. Without it, Find Me does not run for a minor subject.
- Stricter retention for minors: reference embeddings and uploads for minor subjects default to the **shortest** retention tier (§8.4).
- Child-safety review: any flagged/abuse report routes to a priority admin queue. Align with existing org safeguarding policy.
- This PRD does **not** constitute legal advice. Before launch, the org should have counsel confirm the consent language and minor-handling against applicable biometric-privacy law (BIPA, GDPR/UK-GDPR, state laws). Flagged here as a launch-gating action (§12).

### 8.4 Retention & deletion

| Data | Default retention | Mechanism |
|---|---|---|
| Reference upload (Drive SSOT copy) | 90 days (30 days if minor subject) | Scheduled deletion job; user-initiated delete is immediate |
| Reference working copy (Cloud Storage) | 7 days | Cloud Storage lifecycle rule |
| Reference embedding (vector) | Tied to upload retention | Deleted with the upload record |
| **Enrolled selfie + embedding (D7)** | Rolling: expires 12 months after `lastUsedAt` (adult); minors follow the 30-day minor tier unless re-used by the guardian | `lastUsedAt` refresh on each use; expiry job; immediate on user delete or consent revoke |
| `match_runs` / history | 90 days | TTL job |
| Gallery photo embeddings | Lifetime of the event index; deletable on event takedown | Per-event index delete |
| Consent records | Retained as proof of consent (separate from biometric data) | Append-only; not deleted with embeddings |

**User rights:** a signed-in user can view their uploads/searches, delete any of them (cascades to Drive copy, Cloud Storage copy, vector, and run records), and revoke consent (revocation triggers deletion of their biometric artifacts). An org-level "purge event" deletes all embeddings/derivatives for an event while leaving Drive originals untouched.

### 8.5 Access control

- Result access is authorized per request: the API checks the user may view that event before minting signed URLs.
- Vector queries are always `eventId`-filtered server-side; the client cannot widen scope.
- Drive `_find_me_uploads` folder is restricted to the service account + the uploading user; not publicly shared.

---

## 9. Security

- **Auth:** Firebase Auth; ID tokens verified server-side via `firebase-admin` (as in `cloud-webapp/ARCHITECTURE.md`). Matcher microservice is private (Cloud Run IAM, invoked only by the api service account), mirroring the auth model in `cloud-run/main.py`.
- **Secrets:** Google Secret Manager via `--set-secrets`; no keys in env dumps or GitHub.
- **CI/CD:** GitHub Actions + Workload Identity Federation; no long-lived SA keys.
- **Signed URLs:** all photo/zip delivery via short-TTL signed URLs; no Drive hotlinks (`STORAGE_AND_DATABASE_OPTIONS.md`).
- **Rate limiting & abuse:** per-user limits on searches/min and bulk downloads/day; reCAPTCHA Enterprise on the upload action to deter scraping/automated face probing; max upload size and MIME allowlist; decompression-bomb guard (`MAX_IMAGE_PIXELS`, as in `cloud-run/main.py`).
- **Egress guardrails:** budget alert at $50/mo and Cloud Run `max-instances` caps, per the cost-control guidance in `UX_AND_GCP_ASSESSMENT.md` §2.3.
- **Logging/audit:** Cloud Logging + Error Reporting; consent and deletion events audited.

---

## 10. Cost estimate

Sized for this org: bursty event-weekend traffic (~500 concurrent for ~1 hr, twice a month), ~50k photos/event in the index, low steady-state.

| Item | Driver | Est. before credit |
|---|---|---|
| Cloud Run (api) | scales to zero, bursts on event weekends | $0–2/mo |
| Cloud Run (matcher) | online queries CPU, scales to zero | $1–5/mo |
| Cloud Run Jobs (indexing) | GPU/batched, runs after events | $2–8/mo (event-driven) |
| Vertex AI Vector Search | **always-on node billing is the watch item** — a serving node bills 24/7 whether queried or not, ~$0.30/node-hr ≈ **$200–290/mo per node** | High credit burn (~25–35% of the monthly credit per node); **pgvector fallback ≈ $7–10/mo** |
| Firestore | reads/writes for results + feedback | <$1/mo |
| Cloud Storage + CDN | derivatives + egress | ~$10–15/mo (per `STORAGE_AND_DATABASE_OPTIONS.md`) |
| **Total (pgvector path)** | | **~$25–55/mo before credit → $0 after the $10k/yr nonprofit credit** |
| **Total (Vertex Vector Search path)** | | **~$225–340/mo before credit → still $0 after credit, but consumes ~30–40% of the monthly credit** |

### 10.1 Vector store cost for a nonprofit-credit user (answer to the team's question)

Both Vertex AI Vector Search and Cloud SQL + pgvector are Google Cloud services, so **both are covered by the $10k/yr ($833/mo) nonprofit credit — your out-of-pocket cash cost is $0 either way**, as long as total project spend stays under the credit. The real difference is **how much of the credit each one eats**, plus ops:

- **Vertex AI Vector Search:** serving nodes are billed **per hour, 24/7, whether or not anyone searches** (≈ $0.30/node-hr → roughly **$200–290/mo for a single always-on node**, more if you run a node per event or add replicas). At your bursty twice-a-month traffic, you'd be paying all month for capacity used a few hours. That single node can quietly consume **a quarter to a third of the monthly credit** before any other service. Upside: managed, scales to large vector counts, no DB to run.
- **Cloud SQL + pgvector:** a small instance is roughly **$7–10/mo** ([Cloud SQL pricing](https://cloud.google.com/sql/pricing)); the credit covers it with margin to spare, and it barely dents the $833/mo. For tens of thousands of vectors per event this is more than enough. Caveat: the cheapest shared-core tier isn't covered by the Cloud SQL SLA, so use at least a small dedicated instance for production. You also run a database (minor ops, but real).

**Recommendation:** at your scale (tens of thousands of vectors per event, bursty traffic), **pgvector is the better fit** — it leaves almost the entire $10k credit free for everything else, and the accuracy is identical (the vector store doesn't affect match quality, only how vectors are indexed/queried). Reserve Vertex Vector Search for if/when an event index grows into the millions of vectors or you need very high sustained QPS. Confirm with real numbers in the M0 spike (§12).

---

## 11. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| No turnkey Google face-ID; we own the model | Certain | Med | Use proven open-source models; budget a spike to validate accuracy before committing UX (M0). |
| Accuracy too low → user distrust | Med | High | Precision-favoring threshold + "show more" expander; feedback loop tunes weights; per-event eval gate before enabling. |
| Biometric-privacy legal exposure (esp. minors) | Med | High | Consent gate, guardian attestation, minimization, short retention, legal review as launch gate. |
| Vertex Vector Search idle cost | Med | Med | pgvector fallback; per-event index lifecycle (delete idle event indexes). |
| Bursty event-weekend load | High | Med | Pre-warm matcher before known events; cap max-instances; CDN for serving. |
| "Save to Photos" not silent on web | Certain | Low | Use native share sheet; set expectation in copy. |
| Indexing throughput too slow for big events | Med | Med | GPU indexing job + batching; index incrementally as photos arrive. |
| Drive upload quota (750 GB/user/day) on mirroring | Low | Med | Use a service account, batch, and respect quotas (`STORAGE_AND_DATABASE_OPTIONS.md` A1). |
| Misidentification of one attendee as another | Med | High | Never assert identity ("similar to your photo"), one-event scope, easy "not me", human review of flags. |

---

## 12. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Spike (1–2 wks)** | Validate face + person-ReID models on a sample event; confirm pgvector performance/cost (default) and only re-test Vertex Vector Search if scale demands it; measure accuracy + cost. | Precision@20 ≥ 0.8 on sample; vector store confirmed; go/no-go. |
| **M1 — Indexing pipeline** | Drive→Cloud Storage mirror, detection, embedding, vector index, Firestore meta; admin "Index event" action. | One real event fully indexed, idempotent re-index works. |
| **M2 — Search API + matcher** | Online matcher, fused query, threshold, `match_runs`; signed-URL results. | p95 ≤ 6 s; eval gate met on 2 events. |
| **M3 — Frontend Find Me flow** | Gallery button, consent gate, upload, multi-reference tabs, results grid. | FR-1…FR-10 pass on mobile EN/ZH. |
| **M4 — Batch download/save + feedback** | Multi-select, zip/share, "not me"/"confirmed" feedback + admin queue. | FR-11…FR-17 pass; feedback flows to metrics. |
| **M5 — Privacy, retention, legal, hardening** | Consent records, deletion jobs, minor handling, rate limits, reCAPTCHA, budget alerts; **legal review of consent language**. | §8/§9 complete; legal sign-off; budget alerts live. |
| **M6 — Pilot & launch** | One event behind a flag → measure §2 → general rollout. | Targets met; runbook in `cloud-run/DEPLOY_RUNBOOK.md` style. |

---

## 13. Resolved decisions (was: open questions)

1. **Identity reuse:** ✅ **Enabled** (D7). Members can enroll a selfie once and reuse it across future events, opt-in and deletable, with the consent/retention handling in §8.
2. **Vector store:** ✅ **Lean pgvector**, confirmed in M0 with real numbers. Both are credit-covered ($0 cash), but Vertex Vector Search's always-on node consumes ~30–40% of the monthly nonprofit credit vs ~$7–10/mo for pgvector (§10.1).
3. **Minor-subject default:** ✅ **Guardian must perform the search** (D8). No lighter-weight self-attestation in v1, pending legal review.
4. **Retention windows:** ✅ **Confirmed** — 90 days adult / 30 days minor (D9, §8.4), aligned with the safeguarding policy.
5. **Public vs link-only:** ✅ **Find Me is link-only or member-login** (D3) — never exposed on a fully public page.

### Remaining items for legal/ops (not blocking design)

- Counsel to confirm the biometric-consent and minor-guardian language before launch (§12 M5).
- Confirm the enrollment expiry default (12 months after last use, adult) suits the safeguarding policy.

---

## Sources & internal references

- `UX_AND_GCP_ASSESSMENT.md` — GCP migration, cost model, nonprofit credit, mobile fixes.
- `STORAGE_AND_DATABASE_OPTIONS.md` — Drive-as-archive vs Cloud Storage serving; DB options; egress guidance.
- `cloud-webapp/ARCHITECTURE.md` — Firebase Hosting + Cloud Run + Firestore + Auth stack, request flow, CI/CD.
- `cloud-run/main.py` + `UPLOAD_PREP_FEATURE_SPEC.md` — existing image-processing microservice pattern (HEIC/RAW, EXIF, auth model).
- `PUBLIC_SHARING.md` — public/link-based gallery sharing model.

*External: Google Cloud Vision provides face **detection** only, not identification; face matching requires self-hosted embedding models (e.g. InsightFace/ArcFace) + a vector index (Vertex AI Vector Search or pgvector). Biometric data is regulated as sensitive/special-category under GDPR and by laws such as Illinois BIPA; consent language must be confirmed by counsel before launch.*
