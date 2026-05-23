# How to Apply for Google Cloud Platform (GCP) Nonprofit Credits

A step-by-step guide for nonprofit organizations applying for Google Cloud credits through the Google for Nonprofits program.

Last updated: May 2026

---

## What You Get

Through Google for Nonprofits, eligible organizations can access:

- **Google Cloud Free Tier**: Always-free monthly usage of products like Compute Engine, Cloud Storage, and BigQuery (within set limits).
- **Google Cloud free credits**: A one-time Free Trial credit (currently $300, valid for 90 days) for any new Google Cloud billing account, plus additional nonprofit-specific credits when requested.
- **Google Workspace for Nonprofits**: Free Gmail, Drive, Docs, Meet on your custom domain.
- **Google Ad Grants**: Up to $10,000/month in Google Search text ads.
- **Google Maps Platform**: $250/month in Maps credit, with the ability to request more.
- **YouTube Nonprofit Program**: Link Anywhere Cards, fundraising tools, and creator resources.

> Note: Credit amounts and program structure are set by Google and change periodically. Always confirm current amounts on the official Google for Nonprofits site before budgeting.

---

## Before You Begin: Eligibility Checklist

You must meet ALL of these requirements:

1. **Hold valid nonprofit status** in your country.
   - In the U.S.: 501(c)(3) registered with the IRS.
   - In other countries: equivalent charitable registration.
2. **Be verified through TechSoup** (or its country-specific partner). This is the validation gate Google uses for most countries.
3. **Agree to Google's required certifications** regarding non-discrimination.
4. **NOT be on the ineligible list**, which includes: governmental entities/organizations, hospitals and healthcare organizations, schools/academic institutions/universities (Google for Education is separate), and churches/places of worship engaged in religious activities (though their philanthropic arms may qualify).
5. **Be located in a supported country** (65+ countries currently supported).

Confirm eligibility here: https://support.google.com/nonprofits/answer/3215869

---

## Step 1: Get a TechSoup Validation Token

If your organization is not already TechSoup-validated, this is the first step.

1. Go to https://www.techsoup.org and click **Register**.
2. Create an account using your organization's official email address (e.g., `it@youth4am.org`).
3. Complete the organization profile. You will be asked to provide:
   - Legal organization name (must match your IRS/charity-registry records).
   - EIN or tax/charity registration number.
   - Mailing address and primary contact.
4. Submit for validation. TechSoup will verify your nonprofit status. **This typically takes 2 to 14 business days.**
5. Once validated, locate your **TechSoup Validation Token** in your TechSoup account dashboard. You'll need it for Step 2.

Outside the U.S., TechSoup routes you to its local partner (e.g., TechSoup Canada, TechSoup Asia, Stifter-helfen in Germany). Follow the same process there.

---

## Step 2: Sign Up for Google for Nonprofits

1. Go to https://www.google.com/nonprofits and click **Get started**.
2. Sign in with your organization's primary Google account.
   - **Best practice**: use an admin account on your nonprofit's own domain (e.g., `it@youth4am.org`), not a personal Gmail address. If you do not yet have a domain-based Google account, sign up for Google Workspace for Nonprofits during this step.
3. Enter your organization's details: legal name, address, EIN/registration number, website, and mission summary.
4. Provide your **TechSoup Validation Token** from Step 1.
5. Agree to the Google for Nonprofits Additional Terms of Service and the non-discrimination certifications.
6. Submit the application.

**Review time**: Google typically responds within 2 to 14 business days. You'll receive an email at the address you registered with. Check spam if you don't see it.

---

## Step 3: Create a Google Cloud Billing Account

You need a Cloud billing account before any credits can be applied. Even though credits will offset charges, Google requires a valid billing account on file.

1. Go to https://console.cloud.google.com and sign in with the **same Google account** you used to apply for Google for Nonprofits.
2. In the left menu, navigate to **Billing**.
3. Click **Create Billing Account**.
4. Choose **Individual** or **Business** (select Business and enter your nonprofit's information).
5. Enter a payment method. A credit card or bank account is required even for free-trial usage. You will not be charged unless you exceed free-tier limits or credits run out.
6. Accept the Google Cloud Free Trial terms if offered. The Free Trial gives you **$300 in credit for 90 days** and converts to a paid account only if you actively upgrade.
7. Note your **Billing Account ID** (format: `XXXXXX-XXXXXX-XXXXXX`). You'll need it in Step 5.

---

## Step 4: Wait for Google for Nonprofits Approval

You cannot proceed until your Google for Nonprofits application is approved.

- Watch for the confirmation email from Google.
- Sign in at https://www.google.com/nonprofits/account/u/0/ to see your enrollment dashboard.
- Once approved, your dashboard will show the available products (Workspace, Ad Grants, YouTube Nonprofit, Maps Platform, and Cloud).

---

## Step 5: Activate Google Cloud Credits

After Google for Nonprofits approval:

1. Go to https://www.google.com/nonprofits/account/ and sign in.
2. In the products list, find **Google Cloud** and click **Get Started** (or **Activate**).
3. You may be prompted to confirm the Cloud Billing Account from Step 3. Select it.
4. Submit any additional information requested (organization details, intended use case, expected monthly usage).
5. Provide a brief justification:
   - What workloads you plan to run (e.g., website hosting, donor database, data analytics, AI/ML for program evaluation).
   - Estimated monthly Cloud spend.
   - How the work supports your nonprofit's mission.
6. Submit. Google typically responds in **3 business days** with the credits applied directly to your billing account.

You can verify credits arrived by going to:
**Cloud Console → Billing → [Your Account] → Credits**

---

## Step 6: Set Up Cost Controls (Strongly Recommended)

Credits are finite. To avoid an unexpected bill if usage exceeds the credit, set up budgets and alerts immediately.

1. In Cloud Console, go to **Billing → Budgets & alerts**.
2. Click **Create Budget**.
3. Set the budget amount equal to your credit balance (or lower).
4. Set alert thresholds at 50%, 90%, and 100%.
5. Add your email and any team emails that should be notified.
6. Save.

You may also want to:
- Set spending caps on App Engine or specific APIs.
- Disable billing entirely on test projects when not in use.
- Use **Quotas** (IAM & Admin → Quotas) to cap individual service usage.

Documentation: https://cloud.google.com/billing/docs/how-to/budgets

---

## Step 7: (Optional) Request Additional Credits

The standard nonprofit credit is one allocation per organization. If you need more, you can:

- **Apply for Google Cloud Research Credits** (if doing research): https://cloud.google.com/edu/researchers
- **Talk to a Google Cloud nonprofit specialist** through the Google for Nonprofits help center: https://support.google.com/nonprofits/gethelp
- **Engage a Google Cloud Partner** that works with nonprofits. Many partners can sponsor additional credits or discounted services.

For **Google Maps Platform credits beyond the $250/month default**:
1. Sign in to your Google for Nonprofits account.
2. Under **Google Maps Platform credits**, click **Get Started**.
3. Provide:
   - Organization address, phone, and domain.
   - Whether your Maps usage will be on a public site, a restricted-access site, or both.
   - Justification for additional credit beyond $250/month.
4. Google reviews in roughly 3 business days.

---

## Common Reasons Applications Are Rejected

- The EIN or charity number on the Google application doesn't match TechSoup records (typo, name mismatch).
- The applying email is a personal Gmail address rather than an organizational address.
- The organization falls into an ineligible category (school, hospital, governmental).
- The organization's mission information is too vague — write a clear, concrete summary.
- A duplicate Google for Nonprofits account already exists for the org. Search support and consolidate.

If rejected, the email will state the reason. You can correct and re-submit.

---

## Timeline Summary

| Step | Typical Time |
|------|--------------|
| TechSoup validation | 2 to 14 business days |
| Google for Nonprofits review | 2 to 14 business days |
| Cloud Billing setup | Same day |
| Cloud credit activation (post-approval) | About 3 business days |
| **Total end-to-end** | **2 to 4 weeks** in most cases |

---

## Key Links

- Google for Nonprofits home: https://www.google.com/nonprofits
- Sign up: https://www.google.com/nonprofits/account/u/0/signup
- Eligibility requirements: https://support.google.com/nonprofits/answer/3215869
- About Google Cloud Credits: https://support.google.com/nonprofits/answer/16245748
- TechSoup: https://www.techsoup.org
- Google Cloud Console: https://console.cloud.google.com
- Google Cloud Free Tier details: https://cloud.google.com/free
- Google for Nonprofits help: https://support.google.com/nonprofits
- Maps Platform public programs: https://developers.google.com/maps/billing-and-pricing/public-programs

---

## Quick Checklist

- [ ] Confirmed organization meets eligibility (nonprofit status, supported country, not in excluded categories)
- [ ] Registered with TechSoup and received Validation Token
- [ ] Created Google for Nonprofits account using organizational email
- [ ] Submitted Google for Nonprofits application with TechSoup token
- [ ] Created Google Cloud billing account
- [ ] Received Google for Nonprofits approval email
- [ ] Activated Google Cloud credits via the Nonprofits dashboard
- [ ] Verified credits appear under Billing → Credits in Cloud Console
- [ ] Set up budgets and alerts to avoid overage
- [ ] (Optional) Applied for additional Maps Platform or research credits if needed
