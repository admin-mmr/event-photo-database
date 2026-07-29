# Google Cloud Cost Report — 2026 to date
**Prepared for:** mmrunners.org board
**Prepared:** 2026-07-28
**Billing account:** 01D3C2-F2FE89-551428 (3 projects; `mmr-data-pipeline` is the only material one)
**Reporting period:** April 2026 (project start) – 28 July 2026

---

## 1. Read this first — status of the numbers

**Usage figures in this report are exact.** They are pulled from Google Cloud
Monitoring, which records actual metered consumption per service per day.

**Dollar figures are estimates, not invoiced amounts.** No BigQuery billing
export was configured when these months closed, so Google's own cost breakdown
for April–July exists only inside the Cloud Console. Estimates below are
computed by applying published list prices to the exact usage. They are labelled
with ranges wherever a real ambiguity exists.

**One material ambiguity drives the ranges.** Network egress is metered in total
but Monitoring does not split *free* traffic (data moving between our own
services inside `us-central1`) from *billed* traffic (data going out to the
public internet). Most of our egress is almost certainly the free kind — the
photo pipeline copies bytes between Cloud Storage, Cloud Run and Google Drive
inside one region — but it cannot be proven from metrics alone. The unresolved
portion is worth **$0–10/month**, which is why totals are given as ranges.

**Action required to close this gap:** see §7. A billing export was set up on
2026-07-28; from August onward these numbers become exact and auditable.

---

## 2. Executive summary

The service has run at a **very low absolute cost — an estimated $11–27 for the
entire life of the project to date**, against a $20/month budget cap. There is
no cost crisis.

Three things the board should take away:

1. **June, not July, was the expensive month.** Two configuration faults
   overlapped in a single week. Both were found and fixed, and the fixes are
   confirmed working in the July data.
2. **The fixes worked, and we can prove it.** The larger of the two faults
   caused a 22 GB traffic spike in one day; the same measurement in July reads
   **0.6 GB for the whole month** — a 97% reduction.
3. **The real risk is not the bill — it is the free-tier ceiling.** July
   consumed **90% of the monthly free compute allowance** (216,923 of 240,000
   vCPU-seconds), almost entirely because of recovery work after a separate
   data-loss incident. Costs are low because we sit *just* inside free tiers, so
   a single bad week can move the bill from ~$3 to ~$30. This is a monitoring
   problem, and §6 sets out the watch that addresses it.

---

## 3. Monthly breakdown

### 3.1 Metered usage (exact)

| Metric | Apr 2026 | May 2026 | Jun 2026 | Jul 2026¹ | Free tier |
|---|---:|---:|---:|---:|---|
| Cloud Run compute — vCPU-seconds | 0 | 0 | 123,220 | **216,923** | 240,000 / mo |
| Cloud Run memory — GiB-seconds | 0 | 0 | **2,235,052** | 185,956 | 450,000 / mo |
| Cloud Run requests | 0 | 0 | 43,288 | 146,799 | 2,000,000 / mo |
| Firebase Hosting egress (GiB) | 0 | 0 | **25.1** | 0.6 | 10 GB / mo |
| Cloud Storage stored (GiB, avg) | 0 | 0 | 13.9 | 42.9 | 5 GB |
| Cloud Storage egress (GiB) | 0 | 0 | 68.8 | 132.7 | n/a |
| Cloud Storage ingress (GiB) | 0 | 0 | 102.4 | 125.3 | free |
| Cloud Storage operations | 0 | 0 | 540,205 | 460,245 | 5,000 / mo |
| Artifact Registry stored (GiB) | 0 | 0 | ~6 | **12.4** | 0.5 GB |
| Cloud Logging ingested (GiB) | 0 | 0 | 1.0 | 1.3 | 50 GiB / mo |
| Firestore reads | 0 | 0 | 617,133 | 666,900 | 50,000 / **day** |
| Firestore writes | 0 | 0 | 49,236 | 67,045 | 20,000 / **day** |
| Indexer job executions | 0 | 0 | 236 | 212 | n/a |

¹ July is partial — through 28 July. **Bold** = the figure that drove cost that month.

April and May are legitimately zero: development began 9 April 2026, but nothing
was deployed to Google Cloud until **9 June 2026** (first container image).

### 3.2 Estimated cost

| Cost line | Jun 2026 | Jul 2026¹ | Notes |
|---|---:|---:|---|
| Cloud Run — memory over free tier | **$4.46** | $0 | The matcher incident (§4.1) |
| Cloud Run — CPU | $0 | $0 | Inside free tier both months |
| Firebase Hosting egress | **$2.54** | $0 | The originals incident (§4.2) |
| Artifact Registry storage | ~$0.20 | **$1.28** | Uncontrolled image growth (§4.4) |
| Cloud Storage storage | $0.19 | $0.82 | Legitimate — photo derivatives |
| Cloud Storage operations | ~$0.40 | ~$0.40 | Legitimate |
| Firestore, Logging, Tasks, Scheduler | $0 | $0 | Comfortably inside free tiers |
| **Subtotal (confident)** | **~$7.79** | **~$2.50** | |
| Network egress — unresolved share | $0–8 | $0–10 | See §1 |
| **Estimated month total** | **$8–15** | **$3–12** | |

¹ Through 28 July.

**Estimated project-to-date total: $11–27.**

---

## 4. Incidents: what happened, what we changed, what followed

### 4.1 June 17–20 — a search server left running around the clock

**What happened.** The face-matching service (`matcher`) was configured to keep
one instance permanently warm to avoid a slow first search. That instance held
2 vCPU and 8 GiB of memory 24 hours a day whether or not anyone was searching.

**The evidence is unambiguous.** Memory consumption on 18 and 19 June was
691,232 and 691,239 GiB-seconds. A warm 8 GiB instance running a full day is
8 × 86,400 = 691,200 GiB-seconds exactly. Instance count sat at precisely 1.00
on both days. The window ran 17 June to 20 June — about 3.5 days.

**Cost impact.** Those 3.5 days consumed 2.07 million GiB-seconds against a
450,000/month free allowance, producing the single largest line on the June
bill: **~$4.46**. Left in place it would have cost roughly **$1.70/day, ~$50/year**,
for a service that is idle almost all the time.

**What we changed.** The warm instance was removed; the service now scales to
zero when idle. A written zero-idle-cost policy was adopted: no Google Cloud
process may bill money while nothing is happening.

**After-effect (confirmed).** July memory consumption across *all* services was
185,956 GiB-seconds — **8% of June's**, and 41% of the free allowance. The
accepted trade-off is a slower first search after an idle period, while the
service reloads face data into memory.

### 4.2 June 22 — full-size photos served through the wrong path

**What happened.** When an attendee used "Save to Photos" or opened the
full-resolution viewer, the original photo was streamed *through* our API. Because
the web app reaches the API via a Firebase Hosting route, **every byte was billed
twice** — once leaving Cloud Run, and again as Hosting data transfer.

**Cost impact.** A single live event day, 22 June, moved **22.37 GiB** through
that path in one day; June totalled 25.1 GiB against a 10 GB free allowance, or
about **$2.54**. This was easy to miss: viewed on an annual billing chart, one
expensive day averages away to nearly nothing. The cost scales with how many
originals attendees download, so a busy event season would have multiplied it.

**What we changed.** Originals are now delivered by short-lived signed links
straight from Cloud Storage to the attendee's browser, bypassing both our API and
the Hosting route. Bulk downloads changed from a server-built ZIP to a list of
signed links, with the browser assembling the ZIP itself.

**After-effect (confirmed).** Hosting egress for all of July: **0.6 GiB** versus
June's 25.1 GiB — a **97% reduction**, comfortably inside free tier. Photo
delivery to attendees was unaffected.

### 4.3 July 27–28 — volunteer photo loss (a reliability incident with a cost tail)

This was primarily a **data** incident, not a cost incident, but it is what
consumed July's compute allowance and the board should understand it.

**What happened.** Our deployment script specified a 1800-second request timeout,
but the automated deployment pipeline overrode it with **60 seconds**. The
pipeline is what actually deploys, so production silently ran at 60 seconds. On
27 July that killed roughly half of all photo-transfer requests at exactly
60.000 seconds, stranding **1,188 volunteer photos (~5.1 GB)** in temporary
storage: never copied to Drive, therefore never indexed, therefore invisible in
the gallery. One batch alone accounted for 857 photos.

**Why it did not heal itself.** Each file takes a "claim" before its transfer
begins, released on failure. A request killed by timeout runs no cleanup, so
claims were left dangling — and a dangling claim silently rejected every
re-upload of the same photos.

**What was actually lost.** 1,188 photos were recovered. **Nine photos were
permanently destroyed**, in two ways: temporary copies were deleted on an
*unproven* duplicate match (a dangling claim was mistaken for proof the photo was
already safe), and a recovery run dispatched too many transfers at once and
exhausted the server's memory.

**What we changed.**
- Restored the 1800-second timeout, and the deployment pipeline now **fails the
  deploy** if the live configuration disagrees.
- Dangling claims become reclaimable after 35 minutes.
- Temporary copies are **never** deleted unless the duplicate is confirmed
  present in Drive. Keeping an orphan costs nothing; deleting one can destroy a photo.
- API memory raised 512 MiB → 1 GiB; recovery transfers are now spread out over
  time and sized by **bytes**, not file count (a count-based estimate called
  8.8 GB of video "about 1 minute" when it actually took 21.6).
- Separately, 2,683 duplicate files (~11.95 GiB) were found across 5 of 9 events
  and cleared.

**Cost after-effect.** Recovery and re-indexing drove July compute to **90% of
the monthly free allowance** (216,923 of 240,000 vCPU-seconds), with 27–28 July
alone consuming ~70,000. Every other metric spiked on those days too. The
incident cost little in dollars but consumed most of the year's largest free
headroom, and a second such event in the same month would have produced a real bill.

### 4.4 Ongoing — container images accumulating without limit

**What happened.** Every deployment publishes a container image and nothing ever
removed the old ones. The registry reached **12.4 GiB across 111 image versions**
— 79 versions of the API service alone, dating back to 9 June — against a 0.5 GB
free allowance. At ~1.6 deployments per day this grows indefinitely.

**Cost impact.** ~**$1.28/month and rising** — July's single largest identified
recurring charge, and pure waste.

**What we changed.** A retention policy now keeps the 10 most recent images per
service plus everything from the last 30 days, and deletes the rest. Verified
impact: removes 65 of 111 versions, reclaiming ~7.1 GiB (~$0.71/month). It is
**staged in dry-run mode** pending Google's own confirmation report — see §7.

---

## 5. Lessons learned

1. **The cheapest configuration mistake is the one that bills while nothing
   happens.** June's largest line came from a service nobody was using. Idle cost
   is invisible in feature testing and shows up only on the invoice. Our
   zero-idle-cost policy exists because of this.

2. **A daily spike is invisible on an annual chart.** The 22 June traffic spike
   looked like nothing at 13-month zoom. Cost review has to happen at daily
   granularity or expensive single days go unnoticed.

3. **Free tiers make costs non-linear, and that cuts both ways.** We are cheap
   because we sit just inside several free allowances. That also means the
   marginal cost of a bad week is not proportional — it is a step change. Watch
   *headroom*, not dollars.

4. **Configuration asserted in documentation is not configuration.** The
   1800-second timeout was written in the deployment script and stated as fact in
   our engineering notes, while production ran at 60 seconds. Both were wrong and
   both were believed. Critical settings must be **verified against the live
   system**, and the deployment pipeline now does exactly that.

5. **Never delete data on unproven evidence.** Nine photos were destroyed because
   an ambiguous signal ("something claims to have this file") was treated as
   proof ("this file is safe elsewhere"). Retaining a redundant copy costs
   fractions of a cent; deleting a unique one is unrecoverable. The asymmetry
   should always decide.

6. **Rate estimates must be sized in bytes, not items.** Both the recovery
   memory exhaustion and an earlier mis-estimate came from counting files instead
   of measuring volume.

7. **We were flying without instruments.** The most uncomfortable finding of this
   review is that answering "what did we spend in June?" required reconstructing
   it from usage metrics, because no cost export existed. That is now fixed.

---

## 6. Expected ongoing watch

### 6.1 Daily (automated alert preferred; ~2 minutes if checked by hand)

| # | Check | Threshold / expected | Why — which incident this catches |
|---|---|---|---|
| D1 | Every Cloud Run service has **min-instances = 0** | must be 0 or blank | §4.1. Highest-value single check. |
| D2 | Month-to-date vCPU-seconds | **< 8,000/day**; alert at 180,000/month (75%) | §4.3. July hit 90%. |
| D3 | Month-to-date memory GiB-seconds | alert at 340,000/month (75%) | §4.1 — a warm instance shows here first |
| D4 | Firebase Hosting egress | **< 0.3 GiB/day**; alert at 7 GB/month (70%) | §4.2. Would have caught 22 June same-day. |
| D5 | Temporary upload storage depth | should trend to zero after each event | §4.3. Non-zero = photos at risk *and* cost. |
| D6 | API request timeout on the live service | **must equal 1800** | §4.3. Pipeline asserts it; verify independently. |
| D7 | Any request failing at exactly 60.000s | zero | §4.3 signature failure mode |

### 6.2 Weekly (~10 minutes)

| # | Check | Expected |
|---|---|---|
| W1 | Actual spend vs $20 budget, **grouped by SKU, daily granularity** | < $5/week; investigate any single day > $1 |
| W2 | Artifact Registry repository size | flat or falling; alert above 6 GiB |
| W3 | Cloud Storage growth by bucket | tracks event volume; derivatives grow, temp storage does not |
| W4 | Firestore reads/writes per **day** vs 50,000 / 20,000 | < 50% of daily allowance |
| W5 | Duplicate-file census | zero after each event's indexing settles |
| W6 | Indexer job executions and failures | executions match events processed |

### 6.3 Per-event (live event days are when cost is actually created)

- Before: confirm no warm instances, and confirm the 1800s timeout.
- During: watch Hosting egress and temporary storage depth.
- After: confirm temporary storage drained to zero, no photos stranded, no
  duplicates left, and re-index completed.

### 6.4 Standing budget guardrails

- Budget cap **$20/month**, alerting at 50% / 85% / 100%, currently scoped to the
  whole billing account.
- **Two documentation defects found during this review, both still open** — see §7.

### 6.5 Verification commands

Idle-cost check (D1) — every service must show MIN as 0 or blank:

```bash
gcloud run services list --project=mmr-data-pipeline --region=us-central1 --format='table(metadata.name, spec.template.metadata.annotations["autoscaling.knative.dev/minScale"]:label=MIN, spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"]:label=CPU_THROTTLE)'
```

Live timeout check (D6) — must print 1800:

```bash
gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format='value(spec.template.spec.timeoutSeconds)'
```

Temporary storage depth (D5) — should trend to zero between events:

```bash
gcloud storage du gs://mmr-data-pipeline-uploads-staging --readable-sizes --summarize
```

Artifact Registry size (W2) — should stay flat once retention is enforcing:

```bash
gcloud artifacts repositories describe cloud-webapp --location=us-central1 --project=mmr-data-pipeline --format='value(sizeBytes)'
```

---

## 7. Open items

| # | Item | Owner | Why it matters |
|---|---|---|---|
| O1 | **Finish the billing export.** The dataset (`mmr-data-pipeline:billing_export`) and required API are in place, but the final enable step is Console-only: Billing → Billing export → BigQuery export → Edit settings → select the dataset. Enable **both** "Standard usage cost" and "Pricing". | Billing admin | Until this is on, every future cost question needs reconstruction again. Not retroactive — each day it is off is a day of lost detail. |
| O2 | **Export the April–July invoices** from Billing → Reports (group by SKU, daily granularity, CSV) and attach to this report. | Billing admin | Replaces every estimate in §3.2 with an audited figure, and resolves the egress ambiguity in §1. |
| O3 | **Turn off dry-run on the image retention policy** after reviewing Google's confirmation report (~24h). One command:<br>`gcloud artifacts repositories set-cleanup-policies cloud-webapp --location=us-central1 --project=mmr-data-pipeline --policy=cloud-webapp/infra/artifact-registry-cleanup-policies.json --no-dry-run` | Engineering | Until this is off, no images are deleted and the ~$0.71/month is not yet saved. |
| O4 | **Correct the engineering notes on free-tier limits.** They state that Cloud Run jobs have a free allowance separate from services. They do not — it is **one shared pool** of 240,000 vCPU-seconds / 450,000 GiB-seconds per billing account. The notes therefore overstate available headroom by roughly double, and conclude "20–25 indexer runs/month stay free" on that false basis. | Engineering | This is the same class of defect as Lesson 4 — a believed-but-wrong number driving capacity decisions. |
| O5 | **Reconcile the budget script with reality.** The provisioning script creates a **$10** budget scoped to one project; production has a hand-edited **$20** budget covering the whole billing account. Re-running the script would not reproduce production. | Engineering | Same class of defect again. |
| O6 | **Pin container images by digest in the two batch jobs.** Both reference images by moving tag. Retention protects them today, but a tag-pinned job can be broken by image cleanup. | Engineering | Prevents a self-inflicted outage of photo indexing. |

---

## 8. Bottom line for the board

Total cloud spend to date is an estimated **$11–27** across four months, against a
$20/month cap. Both June cost faults were diagnosed to the exact day, fixed, and
the fixes are confirmed effective in July's data — the larger one by a 97%
reduction.

The genuine concern is not the amount but the **instrumentation**: we could not
answer a basic question about our own spending without reconstructing it, and two
separate incidents traced back to configuration that was documented correctly and
deployed incorrectly. Both gaps now have concrete fixes in flight (§7). The
per-event and daily watch in §6 is what keeps a low bill low as event volume grows.
