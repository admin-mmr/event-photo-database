# Applying for the Google Cloud Nonprofit Credit — MMR Runbook

**Who this is for:** whoever holds `admin@mmrunners.org` and is the billing admin on
Google Cloud billing account `01D3C2-F2FE89-551428`.

**Last updated:** 2026-09-21. Supersedes the generic May-2026 version of this file,
which was templated from another organization and is now wrong in two ways: it named
**TechSoup** as the validation partner (Google routes nonprofit verification through
**Goodstack** as of 2026), and it never stated the actual Cloud credit amount.

---

## Why we are doing this

The `mmr-data-pipeline` project (race-photo gallery, FindMe search, indexer) runs at a
few dollars a month when nothing goes wrong, and **every dollar is paid at list price**:
the billing export (checked 2026-09-22) shows no promotional or trial credit on the
account — only the standard Cloud Run free-tier discount. (`AZURE_MIGRATION_DEV_PLAN.md`
describes the stack as riding temporary credits; if it ever did, they are gone.) The
Google for Nonprofits program grants **up to $10,000/year** in Cloud credits, which is
roughly $833/month against a workload that costs ~$3 in a quiet month and ~$12–28 in a
busy event month. If MMR qualifies, this takes the Cloud bill to zero without changing a
line of code.

Two things to understand before you start:

- **Google Workspace for Nonprofits is a separate, free benefit.** Our `@mmrunners.org`
  mailboxes do not consume any of the $10,000. Getting the Cloud credit does not change
  anything about email.
- **The credit is a ceiling, not a blank cheque.** It is an annual allocation that does
  not roll over, and it stops applying the moment it runs out. Keep the budget alerts in
  Step 5 regardless — a misconfiguration can burn credit just as easily as cash.

---

## ⚠️ Step 0 — Settle the eligibility question first

**Do not skip this.** Everything below is wasted effort if the answer is no, and for a
running club the answer is genuinely uncertain.

Google for Nonprofits requires **501(c)(3)** status in the US. Many running and
athletic clubs are incorporated as **501(c)(7) social clubs** instead, or as a plain
state non-profit corporation with no federal exemption at all. **501(c)(7) does not
qualify.** A 501(c)(3) with a sports/youth-athletics or charitable mission does.

**What to do:** find MMR's IRS determination letter, or look the club up in the IRS
Tax Exempt Organization Search at <https://apps.irs.gov/app/eos/> by name or EIN. The
subsection code is printed there.

| What you find | What it means |
|---|---|
| **501(c)(3)** | Proceed to Step 1. |
| **501(c)(7)** or other subsection | Not eligible. Stop here and read "If MMR does not qualify" at the bottom — the Azure path is probably the answer. |
| No federal exemption / can't find it | Not eligible today. Talk to the board before spending more time. |

Also confirm MMR is not in an excluded category (government body, hospital, school,
or a place of worship). A running club is not, so this is normally a formality.

---

## Step 1 — Find out how much of this is already done

This is the step that saves you weeks. MMR already has `@mmrunners.org` Google
accounts, which means the club may **already be enrolled in Google for Nonprofits**
for Workspace. If so, you skip verification entirely and go straight to Step 4, which
takes about three business days instead of three weeks.

1. Sign in at <https://www.google.com/nonprofits/account/> as `admin@mmrunners.org`.
2. Look at what you see:

| What the page shows | Where to go next |
|---|---|
| An enrollment dashboard listing products (Workspace, Ad Grants, YouTube, Maps, Cloud) | **Already enrolled.** Skip to **Step 4**. |
| A "Get started" prompt / no account | Not enrolled. Continue to **Step 2**. |
| "Pending review" | Verification is already in flight. Wait for the email, then Step 4. |

While you are signed in, also note whether **Google Cloud** already appears as an
activated product. If it does, the credit may already be granted and simply not
applied to the right billing account — go to Step 5 and check.

---

## Step 2 — Get verified by Goodstack

Only if Step 1 said "not enrolled".

1. Go to <https://www.google.com/nonprofits> and click **Get started** (top right).
2. Sign in as `admin@mmrunners.org`. **Do not use a personal Gmail address** — a
   personal address is one of the most common rejection reasons.
3. Complete the account request form. Have ready:
   - MMR's **legal** organization name, exactly as it appears on the IRS
     determination letter. A mismatch here is the single most common failure.
   - **EIN**.
   - Registered mailing address and a phone number.
   - Website (`mmrunners.org`) and a short, concrete mission statement. Write
     something specific about what the club actually does — vague mission text gets
     applications bounced.
4. Submit. Google passes your details to Goodstack automatically; you do not file
   separately with them.
5. **Watch for mail from `verifications@mail.goodstack.org`, and check spam.**
   Goodstack routinely asks for a supporting document (usually the IRS determination
   letter). The clock stops until you reply, so watch for this.

**Timeline:** most requests are reviewed in **3–5 business days**.

---

## Step 3 — Wait for the Google for Nonprofits approval email

Nothing to do but respond quickly to any Goodstack request. When approved, the
dashboard at <https://www.google.com/nonprofits/account/> lists the available products.

---

## Step 4 — Request the Cloud credit and attach it to our billing account

Enrollment alone does **not** grant Cloud credits. This is a separate request, and it
is the step people miss.

1. From <https://www.google.com/nonprofits/account/>, find **Google Cloud** in the
   products list and click **Get started** / **Activate**.
2. You will be asked which Cloud billing account to attach the credit to. Choose
   **`01D3C2-F2FE89-551428`** — the account that already pays for `mmr-data-pipeline`.
   Attaching the credit to a new, empty billing account is a real and easy mistake; the
   credit then sits somewhere harmless while the bill keeps arriving.
3. Provide the justification. Keep it concrete and true — something close to:

   > MMR Runners operates a free race-photo service for club members and event
   > participants. Google Cloud runs the photo pipeline: Cloud Storage for images,
   > Cloud Run for indexing and face-matching search, and Firestore for the catalogue.
   > Spend is about $3 per month in quiet months and $12–30 in event months,
   > growing with event volume (August 2026: $30).

4. Submit. Credits are typically applied in about **3 business days**.

Reference: <https://support.google.com/nonprofits/answer/16245748>

---

## Step 5 — Verify the credit actually landed

Do not trust the approval email alone — confirm against the billing account.

In the Console: **Billing → `01D3C2-F2FE89-551428` → Credits**. You want to see a
nonprofit credit with a balance and an expiry date.

Or from the terminal, once `gcloud auth login` is current:

```bash
gcloud billing accounts describe 01D3C2-F2FE89-551428
```

Then confirm the credit is actually offsetting charges by opening
**Billing → Reports**, grouping by **Credit type**, and checking that the current
month shows the credit applied against the `mmr-data-pipeline` line — not just sitting
on the account.

---

## Step 6 — Fix the budget guardrails while you are in there

The credit removes the bill, not the risk: a runaway job burns credit silently and the
first symptom is the credit running out in month seven. Our July cost report found two
real defects here that are still open — fix them now.

- **Production has a hand-edited $20/month budget scoped to the whole billing account,
  but `infra/scripts/provision-budget-guardrails.sh` creates a $10 budget scoped to one
  project.** Re-running the script would not reproduce production. Reconcile the two so
  the script is the source of truth (open item **O5** in
  `billing-analysis/GCP_COST_REPORT_2026.md`).
- Set alert thresholds at **50% / 85% / 100%**, emailing `admin@mmrunners.org`.
- Once the credit is on, **raise the budget to something meaningful against the credit**
  (say $100/month) — a $20 alarm that fires every month becomes noise you learn to
  ignore, which is worse than no alarm.

Also still open from the same report, and worth clearing in the same sitting:

- ~~**O3**~~ — ✅ done 2026-09-22: the Artifact Registry cleanup policy was taken out of
  dry-run after confirming every live job and service runs the newest version of its image.

---

## What the credit does and does not cover

- **Covers:** essentially all standard Google Cloud SKUs — Cloud Run, Cloud Storage,
  Firestore, Firebase Hosting, Artifact Registry, Cloud Build. That is our entire stack.
- **Does not cover:** Google Workspace (already free for us under Workspace for
  Nonprofits), Google Maps Platform beyond its own separate $250/month nonprofit credit,
  and third-party Marketplace purchases.
- **Does not roll over.** It is an annual allocation. Unused credit is not banked.

---

## Common reasons applications get rejected

- Legal name or EIN on the Google form does not match the IRS record — a typo or an
  informal club name instead of the registered one.
- Applied from a personal Gmail address instead of `admin@mmrunners.org`.
- Organization is 501(c)(7) or otherwise not 501(c)(3) — see Step 0.
- Mission description too vague to assess.
- A duplicate Google for Nonprofits account already exists for MMR under someone's
  older address. If you suspect this, search
  <https://support.google.com/nonprofits/gethelp> and ask them to consolidate rather
  than filing a second application.

A rejection email states the reason. Most are correctable and you can re-submit.

---

## If MMR does not qualify

This is a realistic outcome for a running club, and there is already a planned answer:
the **Microsoft nonprofit grant ($2,000/year, recurring)** described in
`AZURE_MIGRATION_DEV_PLAN.md`, which that document says covers the projected workload
about 80× over, against existing Azure spend of ~$65/month. Note that Microsoft's grant
has its own eligibility rules, so confirm them before committing to the migration on
cost grounds alone.

In the meantime, the technical savings stand on their own and do not depend on any
credit — see the cost work tracked in `billing-analysis/GCP_COST_REPORT_2026.md`.

---

## Checklist

- [ ] **Step 0** — Confirmed MMR is a **501(c)(3)** via the IRS Tax Exempt Organization Search
- [ ] Located the IRS determination letter (Goodstack will likely ask for it)
- [ ] **Step 1** — Checked whether MMR is already enrolled in Google for Nonprofits
- [ ] **Step 2** — Submitted the account request as `admin@mmrunners.org` with the exact legal name + EIN
- [ ] Replied to any request from `verifications@mail.goodstack.org` (check spam)
- [ ] **Step 3** — Received the Google for Nonprofits approval email
- [ ] **Step 4** — Requested the Cloud credit and attached it to billing account `01D3C2-F2FE89-551428`
- [ ] **Step 5** — Confirmed the credit appears under Billing → Credits **and** is offsetting charges in Billing → Reports
- [ ] **Step 6** — Reconciled the $10 vs $20 budget defect (O5) and set 50/85/100% alerts
- [x] **Step 6** — Took the Artifact Registry cleanup policy out of dry-run (O3) — done 2026-09-22

---

## Key links

- Google for Nonprofits: <https://www.google.com/nonprofits>
- Your enrollment dashboard: <https://www.google.com/nonprofits/account/>
- About Google Cloud credits: <https://support.google.com/nonprofits/answer/16245748>
- Getting verified by Goodstack: <https://support.google.com/nonprofits/answer/12016036>
- Eligibility requirements: <https://support.google.com/nonprofits/answer/3215869>
- IRS Tax Exempt Organization Search: <https://apps.irs.gov/app/eos/>
- Nonprofits help / consolidate a duplicate account: <https://support.google.com/nonprofits/gethelp>
- Budgets and alerts: <https://cloud.google.com/billing/docs/how-to/budgets>
