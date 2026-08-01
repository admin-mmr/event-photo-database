# Member review links — collecting judgments from many people, not one

Status: **proposed, nothing built.** Date: 2026-07-29.
Prompted by Phase 0's single-judge limitation
([VIDEO_FRAME_EXTRACTION_PHASE0.md](VIDEO_FRAME_EXTRACTION_PHASE0.md) §6).

The local `review.html` contact sheet works, but it only scales to whoever is
sitting at the laptop, and one judge deciding "would a volunteer publish this?" is
the weakest part of the Phase 0 evidence. This is the design for a page members
can open from a link and vote on.

**The short answer: yes, and it is mostly assembly.** This repo already contains
both halves of the pattern.

---

## 1. What already exists (do not rebuild these)

| Piece | Where | What it gives us |
|---|---|---|
| **Public, token-gated page** | `/upload/:token` → [VolunteerUpload.tsx](cloud-webapp/web/src/pages/VolunteerUpload.tsx), [volunteerUpload.ts](cloud-webapp/api/src/routes/volunteerUpload.ts) | A page that works with **no account**, mounted outside the auth wrapper in `App.tsx`, gated by a link token. `/review/:token` is the same shape. |
| **Link lifecycle** | `Upload_Links` sheet + upload-link service, admin UI at `/admin/events/:eventId/links` | Issue / revoke / expire, already RBAC-guarded and audited. |
| **A working vote → label → metric loop** | `match_feedback` → [export_feedback_labels.py](cloud-webapp/matcher/eval/export_feedback_labels.py) → `run_eval.py --judged-only`, documented in [EVAL_FEEDBACK_LOOP.md](EVAL_FEEDBACK_LOOP.md) | Real users already label for us, with an **evidence bar** (≥20 judged pairs from ≥5 distinct users) and judged-precision semantics that exclude unjudged items rather than counting them as negatives. |
| **Admin judging UI** | `/admin/verdicts` → [AdminVerdicts.tsx](cloud-webapp/web/src/pages/AdminVerdicts.tsx), [verdictBatchService.ts](cloud-webapp/api/src/services/verdictBatchService.ts) | The "review a batch of decisions with the images next to them" UI, already built — but admin-only and about match verdicts. |
| **Signed-URL image delivery** | `signThumbUrls` / `signOrigUrl` in `gcsService.ts` | The **only** permitted way to show photo bytes (see §4). |

So the new work is: a candidate-staging step, one public page, one votes
collection, and an exporter that writes the CSV the Phase 0 scorer already reads.

---

## 2. The one design change this forces on the video plan

`VIDEO_FRAME_EXTRACTION_DEV_PLAN.md` §2.2 decides that extracted frames are
written straight into `Photos_NNN` as ordinary JPEGs, so the existing indexer
picks them up unmodified. That decision is right, but **it cannot come first if
members are to vote before publication** — asking 20 people whether a photo should
be published is meaningless once it is already in the gallery.

So insert a staging step and keep everything else:

```
video → extractor → CANDIDATES in the derivatives bucket
                    gs://<project>-derivatives/videoFrames/<eventId>/<videoId>/f01.jpg
                        │
                        ├─ /review/:token   members vote (keep / reject / near-dup)
                        ▼
                    quorum reached → approved candidates copied into Photos_NNN
                        │
                        ▼
                    existing indexer → embeddings → gallery → Find Me   (UNCHANGED)
```

The plan's core insight survives intact — an approved frame still becomes an
ordinary Drive photo and nothing downstream changes. Rejected candidates are just
deleted from the bucket, which is far cheaper than the plan's Phase 3 flow of
publishing to Drive and then trashing bad frames through the soft-delete
lifecycle. Storage for candidates is small and regenerable, and a bucket lifecycle
rule reclaims un-judged ones.

---

## 3. Data model

```
reviewBatches/{batchId}
  eventId, clubName, kind: 'video_frames' | 'photo_quality' | 'match_label'
  sourceVideoId?, extractorVersion?, status, createdAt, counts{}
  quorum: 3, candidateIds: [...]

reviewCandidates/{candidateId}
  batchId, eventId, objectPath (bucket, NOT a Drive id yet)
  meta { tsMs, faces[], score, sourceVideoId }
  tally { keep, reject, nearDup, voters }
  decision: 'pending' | 'keep' | 'reject' | 'disputed'
  publishedPhotoId?              ← set when it reaches Drive

reviewLinks/{linkId}
  token (hashed), eventId, batchId, expiresAt, revoked, maxVotes, createdBy

reviewVotes/{candidateId}_{voterKey}     ← composite id = idempotent
  candidateId, batchId, voterKey, verdict, nearDup, createdAt, linkId
```

Deliberate choices, and why:

- **The vote doc id is `{candidateId}_{voterKey}`**, so a member changing their
  mind overwrites instead of double-counting. Every tally bug in a voting system
  starts with append-only votes.
- **`voterKey`** is the Firebase uid when signed in, otherwise a random id minted
  per link and kept in `localStorage`. Anonymous keys are weak identity — good
  enough for "did 5 different people agree", not proof of distinct humans. The
  evidence bar should therefore count **signed-in voters** separately, the way
  `export_feedback_labels.py` already counts distinct users.
- **Tally lives on the candidate**, incremented in the same transaction as the
  vote. Do not recompute by scanning votes on every read.
- **`decision: 'disputed'`** when the quorum is reached without a clear majority.
  Disputes are the most valuable output of the whole exercise — they are where the
  *question* is ambiguous, not the answer. Route them to `/admin/verdicts`-style
  review rather than forcing a call.
- **Firestore-only, no Sheet row.** The Sheet is SSOT for control-plane entities
  (events, clubs, links, users); a review batch is derived, regenerable eval data
  with a short life. Worth a conscious sign-off since `reviewLinks` is *link-like*
  and links do live in the Sheet — if these are meant to be human-auditable
  alongside upload links, they belong in a tab too.

---

## 4. Non-negotiables (each one is an existing hard-won rule)

- **Candidate images are served ONLY as signed GCS URLs.** Never stream bytes
  through the api: everything the api returns is billed twice (Cloud Run egress +
  Firebase Hosting transfer), and that is what spiked Hosting to ~$3 in a day. The
  review page needs thumbnail-sized derivatives for the grid and a signed
  full-res URL only for the lightbox.
- **`fetch(signedUrl).blob()` needs bucket CORS.** `<img src>` does not, so a grid
  works and a "download this frame" button silently fails — run
  `provision-derivatives-cors.sh` if the page ever reads bytes in JS.
- **Zero idle cost.** Static page on Hosting, endpoints on the existing
  `event-photo-api` service, no new service and no min-instances. Publishing
  approved frames to Drive is Drive-paced work, so it must be an **enqueue +
  drain** job (the `folderRebuildBatches` / `duplicateRemovalBatches` pattern),
  not inline in the request — a batch of 30 approvals is minutes of paced Drive
  calls against a 60 s Hosting ceiling. A drain with nothing queued is a
  single-query no-op.
- **Any new drain query needs its composite index** in
  `infra/firestore.indexes.json`, or every tick 500s with `FAILED_PRECONDITION`.
  That has already bitten twice here.
- **Rate-limit the public endpoints** and cap votes per link, per the existing
  middleware. An unauthenticated write endpoint with no cap is an invitation.
- **The link is unauthenticated and shows photos of real attendees.** Short expiry
  (days, not months), revocable, scoped to one event and one batch, `noindex`,
  and no PII collected from the voter. This is the same exposure as an upload
  link, which is the precedent — but it is worth an explicit decision rather than
  an assumption, because an upload link lets someone *add* photos while a review
  link lets someone *see* them.

---

## 5. Keep the offline and online loops producing the same numbers

This is the part that makes the whole thing worth building rather than a parallel
universe of metrics:

`eval/export_frame_votes.py` (new, ~100 lines, modelled directly on
`export_feedback_labels.py`) reads `reviewVotes` and writes **exactly the
`judgments.csv` schema `score_video_frames.py` already consumes**
(`kind,selector,stem,file,verdict,near_dup`). Then:

- the same scorer computes precision / near-dup rate / coverage against the same
  Phase 0 bar, whether the judging happened in `review.html` or in a browser on
  20 phones;
- majority-of-N replaces one person's opinion, and **inter-judge agreement
  becomes measurable** — if members disagree on 30% of frames, the honest
  conclusion is that "would you publish this?" is underspecified, which no amount
  of threshold tuning fixes;
- the existing evidence-bar convention carries over: report a number only above
  ≥20 judged items from ≥5 distinct voters, and exclude unjudged candidates
  rather than treating them as rejects (the judged-precision semantics of
  `EVAL_FEEDBACK_LOOP.md` §3).

---

## 6. Phasing

**Phase A — the minimum that collects real votes.** Extractor writes candidates to
the derivatives bucket; `reviewBatches`/`reviewCandidates`/`reviewVotes`;
`POST /api/review/:token/vote` + `GET /api/review/:token` (public, rate-limited,
signed thumb URLs); `/review/:token` page (grid, keep/reject, near-dup, progress,
resumable); admin issues links from the event page; `export_frame_votes.py`.
No publishing yet — the output is a CSV and a scorecard.

**Phase B — decisions act.** Quorum → `decision`; an approve-drain copies kept
candidates into `Photos_NNN` (enqueue+drain, idempotent, provenance
`fromVideo{driveFileId, tsMs, extractorVersion}`) and triggers the index scan;
rejected candidates deleted from the bucket; disputes surface in an admin queue.
This is the plan's Phase 2/3 with the vote in front of it.

**Phase C — reuse the surface.** The same page, parameterized by `kind`, covers
photo-quality curation and "is this the same person" match labels — the latter
directly grows the eval set beyond self-votes, which is the standing weakness in
`EVAL_FEEDBACK_LOOP.md` (a searcher can only judge their *own* photos). Do not
build C's variants until A has produced one real scorecard.

**Sequencing note:** Phase 0's own gate does not depend on this. The 81 stills
already extracted can be judged locally today; member review is what makes the
*next* judgment (and every future one) trustworthy. If the goal is to settle the
40-vs-25 px question quickly, judge locally and run the in-cloud replay (§5.1 of
the Phase 0 doc) — that is a measurement, not an opinion poll, and no amount of
member voting substitutes for it.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Unauthenticated link leaks attendee photos | Short expiry, revocable, per-event/per-batch scope, `noindex`, no download button |
| Ballot stuffing / bored voter | Vote id is `{candidate}_{voter}`; per-link vote cap + rate limit; count signed-in voters separately in the evidence bar |
| Members disagree, no decision | `disputed` state is a first-class outcome, routed to admin; report agreement rate as a finding about the question |
| Judging fatigue → thin coverage | Small batches (≤40 frames), progress saved per vote, resumable; sample the same frames across voters rather than giving everyone all of them |
| Metrics drift from the offline harness | One CSV schema, one scorer — `export_frame_votes.py` must emit exactly what `score_video_frames.py` reads |
| Cost creep from a new surface | No new service; static page + existing api + drain-on-demand; candidates in the derivatives bucket with a lifecycle rule |
