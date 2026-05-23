# Photo Storage and Database Options — Detailed Comparison

**Project:** 湘舍动公益文件系统 (Event Photo Database)
**Prepared for:** IT Department, Youth4AM / mmrunners
**Date:** May 19, 2026
**Scope:** (a) Can we use the 100 TB Workspace-for-Nonprofits Drive pool as the backend photo store and render photos directly from Drive? (b) What database options do we have for the photo-metadata layer, and how do they compare?

This document complements `UX_AND_GCP_ASSESSMENT.md` — that report covered UX fixes and the general case for moving off Apps Script; this one zooms in on the storage and data layers.

---

## TL;DR

| Question | Short answer |
|---|---|
| Can we use the 100 TB Drive pool as the photo *backend*? | **Yes for archival, no for serving.** Drive is not a CDN; the `drive.google.com/uc?export=view&id=...` hotlinking pattern has been actively blocked since Jan 2024 and is unreliable in 2026; thumbnail URLs are signed and expire ~60 min; large originals hit a virus-scan interstitial that `<img>` can't click through; viral links get throttled. The Drive 100 TB is great as the cold archive of originals. Serve from a real object store. |
| Realistic alternative | **Cloud Storage + Cloud CDN.** ~$2/mo storage for 100 GB + ~$7/mo egress for two bursty event weekends = under $15/mo, fully covered by the $10k/yr GCP nonprofit credit, with proper CDN cache hit ratios and signed-URL access control. |
| Database recommendation | **Primary: Supabase Pro at $25/mo.** Real Postgres + auth + storage in one bundle, no servers to babysit, painless `pg_dump` exit if we ever leave. **If budget is literally zero:** Firestore (covered by nonprofit credit, free tier holds for years). **If we hire/keep a dev next year and want the safest hand-off:** Cloud SQL Postgres at ~$15/mo. |
| What we should *not* pick | Airtable (50k-records-per-base cap kills it, and $20/user/mo × 50 admins = $1k/mo). AlloyDB Omni (wrong tool — analytics engine, ~$80/vCPU/mo in prod). Self-hosted Postgres on a $5 VPS (no on-call = data-loss risk for a volunteer org). Pure Sheets past ~200k rows (already failing). |

---

## Part A — Drive-as-Backend Storage

### A1. What the 100 TB Workspace-for-Nonprofits pool actually is

- **Pooled across the entire org**, not per-user. The 100 TB sits in a shared pool that any user or Shared Drive in the org can draw from. Workspace for Nonprofits caps at 2,000 seats (new orgs start at 300).
- Hard limits that still apply on top of the pool:
  - **5 TB max per individual file.**
  - **750 GB upload per user per day.** Exceed it and that account is frozen for 24 hours — not just from uploading, but from many automated operations.
- Workspace for Nonprofits **does not include the $10k/yr GCP credit** — that's a separate program. They stack cleanly: keep the free Workspace for email/Drive/Docs/Sheets, apply for the GCP credit separately.

**TOS landmine.** The Google for Nonprofits Additional Terms and the Ad-Grants-adjacent Website Policy prohibit using the program primarily as commercial hosting infrastructure and require content to be tied to the nonprofit mission. Google explicitly tells users Drive is **not a CDN**. Using it as the storage backend of an internal volunteer app with "anyone-with-link" sharing sits in a grey zone but is not commercial hosting; embedding event photos on a public marketing page edges closer to the line. The risk isn't a takedown notice — it's an abuse-detection auto-suspension that could lock the whole org out of Drive for hours-to-days while appeal goes through.

### A2. Serving photos to a webpage in 2026 — what works and what doesn't

| Pattern | 2026 status |
|---|---|
| `drive.google.com/uc?export=view&id=FILE_ID` (the classic hotlinking URL) | **Deprecated / unreliable.** Google began aggressively blocking cross-origin hotlinking in January 2024 (issuetracker.google.com/319531488). Some files/sessions still work, others return 403 or an HTML interstitial. Treat as broken for production. |
| `lh3.googleusercontent.com` URLs from the Drive API's `thumbnailLink` field | **Short-lived (~60 min) signed URLs.** Google explicitly told developers not to cache them (issuetracker 163065199). You must re-fetch via the API every session, which puts every page load on the Drive API quota meter. |
| `<img src="drive.google.com/thumbnail?id=FILE_ID&sz=w1600">` direct embed | **Semi-reliable**, resolution-capped, and rate-limited under load. Works for thumbnails up to ~1600px. |
| API call → `files.get?alt=media` → backend streams → blob URL to browser | **Works**, but makes the app server the hot path. Eats Drive API quota *and* Cloud Run egress. Roughly halves throughput vs. a real object store. |
| "Anyone with the link" file sharing | Works, but Drive's abuse system *does* flag virally-shared files. The Drive Acceptable Use Policy gives Google the right to disable individual files or suspend the account immediately on AUP signal. |

**Bottom line:** there is no clean, supported, stable way to serve a 200-photo event album to 500 concurrent viewers directly from Drive in 2026. Every working pattern has either a quota meter, an expiry timer, an interstitial, or an anti-abuse trip-wire.

### A3. Performance reality at this nonprofit's traffic shape

Assumed traffic: ~50 active volunteer-admins routinely, plus the bursty Sunday-after-event pattern of ~500 concurrent users hitting a fresh album for an hour, twice a month.

- **Latency.** Drive is *not* fronted by Cloud CDN / Media CDN — those are separate GCP products that point at Cloud Storage origins. Drive serves from regional frontends with opportunistic edge caching but no guaranteed CDN hit. Typical first-byte for a 2 MB JPEG via `uc` is **300–900 ms**; full image on mobile LTE is **1.5–3 seconds**.
- **Drive API quota** (default per Cloud project): **20,000 requests / 100 seconds**, shared read+write. Direct share-link fetches (`uc`, `thumbnail`) aren't billed against the project API quota but they *are* throttled by anti-abuse independently.
- **Bursty math:** 500 users × ~20 thumbnails on first paint = 10,000 image requests in under 30 seconds. Routing through the Drive API trips the 100-second quota. Hotlinking gets a meaningful fraction of 403s and interstitials. Neither path is safe under the realistic event-weekend traffic pattern.
- **Mobile reality.** A 200-photo album on mobile is workable for the first viewer — Google warms its cache opportunistically — and painful for the 50th if everyone clicks at once after a newsletter blast.

### A4. Failure modes you'd inherit

1. **Virus-scan interstitial.** Downloads over **100 MB** get an HTML interstitial users have to click through. Browsers cannot render this in an `<img>`, so the photo silently fails to load. Full-resolution photo originals from a modern camera routinely cross 100 MB for RAW + JPEG bundles.
2. **Anti-abuse rate limiting.** Drive throttles "viral" links with no published threshold. reCAPTCHA can be injected on what looks like high-volume traffic from a single origin.
3. **Auto-flag and auto-disable.** Drive AUP scanners disable individual files automatically on signal and, on repeated hits, suspend the entire account. Appeal is by web form and has SLA of "days."
4. **Loss of nonprofit status.** If Workspace for Nonprofits eligibility is revoked (org disposition change, Goodstack re-verification fails, etc.), the domain reverts to paid Workspace or trial expiry — storage above the new cap becomes read-only and external share links can break.
5. **SLA gap.** Workspace and Drive carry a 99.9% monthly SLA — same headline number as Cloud Storage standard — *but* Drive's SLA explicitly excludes "customer abuse," which is how Google would classify the kind of high-volume image hotlinking event-photo viewing requires.

### A5. The right architecture: Drive as archive, Cloud Storage as origin

| Role | Service | Why |
|---|---|---|
| **Cold archive of originals** | Drive / Shared Drive in the 100 TB pool | Photographers and event admins already know Drive's UI. Free with Workspace for Nonprofits. Acceptable for files that get touched maybe once a year. |
| **Hot serving for the web app** | Cloud Storage Standard + Cloud CDN, with signed URLs | Engineered for exactly this pattern. No interstitials. No abuse throttling. Real edge caching. Signed URLs for access control. |
| **Permanent record / proof-of-existence** | A weekly job that mirrors the GCS bucket back to a Shared Drive folder | Ensures the org always has a copy on the Workspace side, so if the GCP project ever evaporates the photos don't. |

**Realistic monthly cost** of the Cloud Storage path at this org's scale (100 GB total, ~60 GB egress over two event weekends a month):

- Storage: 100 GB × $0.020/GB = **$2.00**
- Egress: 60 GB × $0.12/GB = **$7.20** (most of this CDN-cached after the first hit per asset, so real number is lower)
- Cloud CDN cache fill / fill-from-origin: negligible at this scale
- Cloud CDN cache lookups: $0.0075 / 10k = pennies
- **Total: under $15/month, before the nonprofit credit. With the $10k/yr credit it is effectively zero.**

For comparison, building this on Drive would cost $0 in dollars but routinely cost availability during event-weekend traffic peaks, and would require an engineer to spend time fighting the hotlinking-and-interstitial fire every few months.

---

## Part B — Database for Photo Metadata

The "database" today is a single Google Sheet with multiple tabs (events, clubs, users, photos, upload links, audit log, etc.), accessed through `sheetService.ts`. That file calls `SpreadsheetApp.openById()` on every request. Across the `src/services/` directory there are now **35 service files** built on top of this pattern, which is the strongest signal that the data layer is doing real work and is the right thing to scrutinize.

### B1. What's actually failing about Sheets right now

- **Cross-tab joins are slow.** Looking up "all photos for event X uploaded by club Y in week Z" requires reading three tabs with `getValues()` and joining in TypeScript. Each tab read is a synchronous round-trip; a typical join scan takes 800ms–2s in production today.
- **Concurrent writes fail.** Apps Script is single-threaded per script, and Sheets returns "Service unavailable" under modest concurrent write load. The team has already added retry logic, but the underlying limitation is structural.
- **Cell-count ceiling.** Sheets caps at 20 million cells per spreadsheet as of the April 2026 update (doubled from 10M). At ~10 columns per row, that's 2M rows total across *all* tabs combined. The photos tab alone is on track to hit that within 18 months at current growth.
- **Apps Script quotas compound.** The 6-minute execution cap, the 20,000 URLFetch calls/day limit, and the 300 reads/min Sheets API ceiling all become the bottleneck before the spreadsheet itself does.

### B2. The eight candidates compared

Scale assumption used across the table: ~50 active volunteer-admin users, ~100k metadata rows today, ~1M rows in 3 years, single-digit-GB total, low concurrent-write rate (photographers uploading + admins curating), heavier read traffic (gallery / search / album lookups).

| Option | 2026 cost at this scale | Free tier covers it? | Schema fit | Ops burden | Lock-in | Best fit if… |
|---|---|---|---|---|---|---|
| **Google Sheets (status quo)** | $0 | Yes, until ~200k rows | Tabs as tables, joins in code, no FKs | Near-zero | Low (CSV export) | Dataset stays under ~200k rows and writes stay sequential |
| **Firestore** | <$1/mo storage + tiny reads | Yes — 50k reads/day + 20k writes/day free, covers expected traffic ~10× over | Document model, denormalized; native full-text and geospatial in 2026 | Zero servers, automatic backups via PITR, IAM via GCP | Moderate (proprietary API, but Firestore→GCS→BigQuery export is one command) | You stay on GCP and want literally zero ops |
| **Cloud SQL Postgres** | ~$12–15/mo (`db-f1-micro` ~$10 + SSD + backups) | $300 GCP credit on signup, no ongoing free tier | Full relational — joins, FKs, indexes, migrations | Low: managed backups, auto minor-version upgrades. Schema migrations are still yours. | Low — stock Postgres, `pg_dump` and go | You want the safest managed-Postgres option and can spend ~$15/mo |
| **AlloyDB Omni** | ~$70–81 per vCPU/mo in prod (Dev Edition is free for non-prod only) | Dev/eval only | Postgres-compatible + columnar engine | You self-host (binary/container). Backups and patching are yours. | Low (Postgres wire-compatible) but the perf features that justify it are AlloyDB-specific | You specifically need the columnar analytics engine — **not the case for this app** |
| **Supabase Pro** | $25/mo (Free tier projects pause after 7 days inactivity → disqualifying for prod) | Pro only | Full Postgres + auto-generated REST + bundled auth + storage | Managed, daily backups on Pro, PITR is paid add-on | Low for the DB (Postgres dump), higher if you adopt Supabase Auth + RLS + Storage as a bundle | You want Postgres + auth + storage from one vendor and the $25/mo is fine |
| **Airtable Team** | $20/user/mo annual ($24 monthly) × 50 admins = **$1,000/mo** | 1,000 records/base — useless at this scale | Excellent low-code UI for relations, **50,000 records per base on Team plan** (125k Business, 500k Enterprise — none reach 1M) | Zero, revision history backups | High — proprietary API, per-base CSV export only | The team values low-code UI over cost and scale. **Disqualified by record cap and price at 50 editors.** |
| **Self-hosted Postgres on a $5/mo VPS** | $5/mo (Hetzner CPX11, DigitalOcean basic) | None | Full Postgres | **You own everything**: OS patches, Postgres upgrades, backup cron, monitoring, security. A volunteer org without a sysadmin is one outage away from data loss. | None | A committed technical volunteer will own it for years |
| **SQLite + Litestream** | ~$0–1/mo (Cloud Run instance + ~$0.50/mo GCS for WAL replication) | Yes | Full SQL, single-writer (fine for ~50 admins) | Low, but you must understand the WAL/restore model. Restore from GCS is under 30s for a few-GB DB. | None — it's a file | You want the cheapest, simplest, most portable answer and are willing to pin one Cloud Run instance (`min = max = 1`) |

### B3. Recommendation for this nonprofit specifically

**Primary pick: Supabase Pro at $25/month.**

The reasoning: Supabase gives you a real Postgres, daily backups, bundled auth, bundled file storage, and a web UI for schema edits all in one $25/mo subscription. It replaces in a single move (a) the multi-tab join performance ceiling, (b) the concurrent-write failures, (c) the 20M-cell limit, and (d) the auth-via-`Session.getActiveUser()` improvisation. It works from both Apps Script (via `UrlFetch`) and from a future Cloud Run app (via the JS SDK or REST). And the exit story is painless: `pg_dump` and walk away. The $25/mo is well inside the nonprofit's typical software budget, and the team gets a real database for the price of a couple of takeout dinners a month.

**If budget is literally zero: Firestore.**

It stays inside the GCP free tier roughly 10× over at this scale, and once we apply for the $10k/yr nonprofit credit, even the over-tier scenario costs nothing. The trade-off is the document model — you have to denormalize, you don't get full SQL joins out of the box. Cloud Run integration is best-in-class via Application Default Credentials. From Apps Script the friction is higher (REST API, no SDK). Best primary pick if and only if we've committed to moving the whole app to Cloud Run.

**If we hire or keep a dev next year and want the safest hand-off: Cloud SQL Postgres at ~$15/month.**

Stock Postgres on a non-shared instance gets the full Cloud SQL SLA, fits the eventual Cloud Run rewrite cleanly, uses skills every Postgres developer in the world already has, and is the easiest possible hand-off. The migration path is: Supabase first to get off Sheets quickly → Cloud SQL later when we're already on Cloud Run, via a single `pg_dump`.

**What we should not pick:**

- *Airtable.* The 50k-records-per-base cap on the Team plan would force splitting the photos table within months, and the per-editor pricing means a 50-volunteer org pays $1k/mo for a database that still doesn't scale.
- *AlloyDB Omni in production.* Wrong tool (it's an analytics-optimized Postgres) and too expensive (~$80/vCPU/mo in prod). Dev Edition is fine for experiments but not what you build on.
- *Self-hosted Postgres on a $5 VPS.* The dollars are appealing but the ops burden is real. One missed backup cron and we lose three years of photographer credits. Volunteer orgs lose volunteers; the database can't be the thing only the volunteer-who-left knew how to restore.
- *Pure Sheets past ~200k rows.* It will keep working for small admin tabs (events, clubs, users), but the photos and audit-log tabs need to move now, not in 18 months when the cell ceiling forces a rushed migration.

### B4. Hybrid: keep Sheets where it's still useful

Sheets isn't worthless in 2026 — it's just being asked to do work it shouldn't. A defensible hybrid is:

- **Move to Supabase (or Firestore):** photos, upload-links, audit-log, sync-queue, sync-jobs. These are the high-row-count, high-concurrent-write tables.
- **Leave on Sheets (for now):** events, clubs, users, email-preferences. Low row count, sequential admin edits, well-served by the Sheets UI which non-engineering admins already use.

This keeps the volunteer-friendly Sheets workflow for the admin tables and removes the hot tables from the failure path. The migration can ship one table at a time over a few weeks, with the cutover tested in production via dual-write before flipping reads.

---

## Part C — Putting it together

The recommended end-state for this nonprofit is:

1. **Photos**: Cloud Storage Standard with Cloud CDN as the serving origin, signed URLs for access control, and a weekly mirror job back to a Shared Drive folder in the 100 TB pool as cold backup. Cost: under $15/mo before the nonprofit credit.
2. **Metadata**: Supabase Pro Postgres as the system of record for high-traffic tables (photos, upload-links, audit-log, sync). Cost: $25/mo. Admin tables can stay on Sheets during the transition.
3. **Auth**: Firebase Auth (free at 50 MAU) once we move off Apps Script, or stay with the existing `Session.getActiveUser()` approach until then.
4. **Compute**: Cloud Run for everything that hits an execution-time wall or a concurrency wall on Apps Script today. Cost: $0–2/mo at this traffic.

Total recurring monthly cost at steady state: **~$40/mo before credits**, **$0 after the $10k/yr GCP nonprofit credit absorbs the Cloud Storage / CDN / Run / Firebase portion**. The Supabase $25/mo is outside the credit but is the smallest practical line item.

That's the picture worth working toward. The first move that delivers the most pain relief for the least effort is migrating the photos table off Sheets — everything else can follow on the team's own timeline.

---

## Sources

**Drive-as-backend research:**
- [Google for Nonprofits — Workspace offer](https://www.google.com/nonprofits/workspace/compare/)
- [Workspace storage limits](https://support.google.com/a/answer/172541)
- [Google for Nonprofits Website Policy](https://support.google.com/nonprofits/answer/1657899)
- [Google for Nonprofits Additional Terms](https://support.google.com/nonprofits/answer/9004493)
- [Drive Community: "Can I use Drive as a CDN?"](https://support.google.com/drive/thread/177709832)
- [Google Issue Tracker 319531488 — hotlinking block Jan 2024](https://issuetracker.google.com/issues/319531488)
- [Issue Tracker 163065199 — thumbnail URL expiry](https://issuetracker.google.com/issues/163065199)
- [Drive API limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Cloud CDN docs](https://cloud.google.com/cdn)
- [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
- [Workspace SLA](https://workspace.google.com/terms/sla/)
- [Cloud Storage SLA](https://cloud.google.com/storage/sla)
- [Drive security and abuse policies](https://support.google.com/drive/answer/141702)

**Database options research:**
- [Sheets cell limit doubled, April 2026](https://workspaceupdates.googleblog.com/2026/04/faster-performance-and-doubled-cell-limits-in-Google-Sheets.html)
- [Sheets API quotas](https://developers.google.com/workspace/sheets/api/limits)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Firebase Cloud Next 2026 announcements](https://firebase.blog/posts/2026/04/cloud-next-2026-announcements)
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing)
- [AlloyDB Omni pricing](https://cloud.google.com/alloydb/omni/pricing)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase free-tier 2026 breakdown](https://aiagencyplus.com/supabase-free-tier-limits/)
- [Airtable pricing](https://airtable.com/pricing)
- [Airtable record limits](https://www.airtablepricing.com/)
- [Litestream](https://litestream.io/)
- [SQLite in production 2026](https://murtazaweb.com/blog/2026-03-23-sqlite-production-readiness-2026/)
- [Bytebase Postgres hosting comparison](https://www.bytebase.com/blog/postgres-hosting-options-pricing-comparison/)
- [Apps Script quotas 2026](https://folderpal.io/articles/google-apps-script-quotas-and-workarounds-2026-breaking-limits-on-drive-automation)
- [Connecting Cloud Run to serverless databases](https://codelabs.developers.google.com/connecting-to-serverless-databases-from-cloud-run)
