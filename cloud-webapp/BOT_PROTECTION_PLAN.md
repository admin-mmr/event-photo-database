# Bot protection plan — "only real people download, search and upload"

Written 2026-11-02, during the NYC Marathon event (`4207f053…`). Nothing here
may block a real attendee by surprise: every gate starts observe-only, and every
production step below needs the owner's approval, one at a time.

## 1. Where things stand

| Action | Route | Gates today |
|---|---|---|
| Find-Me search | `POST /api/findme/search`, `/search-by-upload` | Firebase auth (**anonymous guest allowed**) · per-uid limit 20/min · reCAPTCHA `findme_search` |
| Download / save originals | `POST /api/events/:id/download`, `/originals/sign` | Firebase auth (anonymous allowed) · per-uid 50 ZIPs/day, 500 originals/day · reCAPTCHA `download` |
| Volunteer upload | `POST /api/volunteer/upload/session` (per file) | secret link token · per-link rate limit · **no reCAPTCHA, on purpose** |

Two gaps:

1. **reCAPTCHA has been off since 2026-10-04.** Secret `RECAPTCHA_KEY` v3 is not
   an API key, so every assessment returned HTTP 400 "API key not valid" and
   `services/recaptcha.ts` failed open. The only trace was a WARN line. About
   1,000 failed on 11-02 alone.
2. **The per-uid limits don't limit a bot.** Guest sign-in is anonymous Firebase
   auth, so a script can get a fresh uid, and a fresh quota, whenever it likes.
   Firebase rate-limits new accounts per IP, but loosely.

What a bot can do: **(a)** probe Find-Me with faces it doesn't own. This is the
privacy risk, and the reason reCAPTCHA was added. **(b)** Bulk-sign originals.
That is the cost risk: originals bill as GCS internet egress, which was $20 of
the $30 August bill (see `CLAUDE.md`). Uploads are guarded by the link token.

## 2. What this PR changes (code only, nothing deployed)

- **`RECAPTCHA_MODE=shadow|enforce`, default `shadow`.** Shadow verifies and logs
  every verdict but never blocks. Enforce 403s, as before. Turning enforcement
  on is a deliberate env change. `deploy-api.sh` now sends `RECAPTCHA_MODE` and
  `RECAPTCHA_MIN_SCORE` only when they are exported, so a routine redeploy can't
  undo the owner's choice. CI never sets either.
- **One `recaptcha verdict` log line per gated request**, with fields
  `recaptcha.{action, mode, outcome, reason, score}` and `uid`. `outcome` is one
  of `pass`, `would_block`, `blocked` or `fail_open`.
  `infra/scripts/recaptcha-score-report.sh` turns these lines into a score
  histogram and shows what each threshold would block.
- **A failure can no longer be silent.** HTTP 400/401/403/404 from the assessment
  API means our configuration is wrong. These now log at **ERROR** with
  `alert: "recaptcha_broken"`, which the live "event-photo-api unhandled errors"
  policy already emails (at most once per 5 min). 429, 5xx and network errors
  stay at WARN. It still fails **open**: a broken key must never lock attendees
  out.
- **Startup self-check.** Each new instance sends one assessment with a bogus
  token. A working key returns 200 (`MALFORMED`) and a bad key returns 400; both
  were checked against the live API on 2026-11-02. So a deploy with a broken key
  is flagged when it boots. Cost: one assessment per cold start.
- **Only guests are checked.** A user signed in with Google skips the
  assessment: it costs nothing and can never 403 them. The verdict line is still
  logged, with outcome `skipped_signed_in`. Guests are the hole, because a fresh
  anonymous uid means a fresh per-uid quota. A Google account can't be
  mass-created, and its fixed uid makes the per-uid limits hold. The skip is an
  **allowlist** (`google.com` only, read from the token's `sign_in_provider`).
  Any sign-in method added later, such as email/password, which *is* cheap to
  mass-create, stays checked unless someone deliberately adds it. Admin and
  machine calls (`X-Sync-Token`) never reach these routes, so they use no
  assessments.
- **The API key moved from the `?key=` URL to the `X-Goog-Api-Key` header**, so it
  can't end up in a logged URL.
- `infra/monitoring/recaptcha-broken-alert-policy.json`: a dedicated alert with
  fix-it instructions (at most one email per hour). This is optional, because the
  generic ERROR alert already catches it.
- Uploads still have no reCAPTCHA. The per-file cost and false-positive reasons
  in `routes/volunteerUpload.ts` are unchanged.

## 3. Production steps for the owner (approve each one separately)

> **Order matters.** Cloud Run reads a `:latest` secret **each time an instance
> starts**, not at deploy time. The code running now **enforces** a 0.5
> threshold and 403s requests with no token. If the key is fixed before the
> shadow build is live, instances started after that would begin blocking real
> attendees, ad-blocker users included. **Step 1 must come before step 3.**

**Step 1 — Deploy this PR (shadow mode).** Merge, then let CI deploy. Do not set
`RECAPTCHA_MODE`. Expect `recaptcha_broken` ERROR emails right away, because the
key is still bad. That proves the alert works, and step 3 stops them. Verify:

```bash
gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format=json | grep -E 'RECAPTCHA_(MODE|MIN_SCORE)'
```

There should be no `RECAPTCHA_MODE` entry, which means shadow mode.

**Step 2 (optional) — Apply the dedicated alert policy.**

```bash
gcloud alpha monitoring policies create --policy-from-file=infra/monitoring/recaptcha-broken-alert-policy.json --project=mmr-data-pipeline
```

**Step 3 — Fix the key, without ever printing it.** Copy the key string of
`recaptcha-enterprise-assessments` (uid `28de1a85-834f-43d1-9006-3d2a7e551363`,
restricted to recaptchaenterprise.googleapis.com) straight into a new secret
version. Then start a new revision so instances read it:

```bash
gcloud services api-keys get-key-string 28de1a85-834f-43d1-9006-3d2a7e551363 --project=mmr-data-pipeline --format='value(keyString)' | tr -d '\n' | gcloud secrets versions add RECAPTCHA_KEY --data-file=- --project=mmr-data-pipeline
```

```bash
gcloud run services update event-photo-api --region=us-central1 --project=mmr-data-pipeline --update-secrets=RECAPTCHA_API_KEY=RECAPTCHA_KEY:latest
```

Verify: the logs show `recaptcha self-check passed`, the ERROR emails stop, and
verdict lines carry real scores. Then disable the bad version so nothing can roll
back to it:

```bash
gcloud secrets versions disable 3 --secret=RECAPTCHA_KEY --project=mmr-data-pipeline
```

**Step 4 — Watch the scores.** Run the report after the rest of the event, and
again after the next one. Aim for at least ~500 verdicts per action before
choosing a threshold.

```bash
./infra/scripts/recaptcha-score-report.sh mmr-data-pipeline 7d
```

Read it for:

- the share of `missing_token` (see §5);
- the share of scored requests below each candidate threshold.

**Step 5 — Choose `RECAPTCHA_MIN_SCORE` and enforce.** Use the highest threshold
that would block about 1% or less of scored requests. Google's score levels are
0.1, 0.3, 0.5, 0.7 and 0.9; expect 0.3, not 0.5. Enforce `findme_search` first,
because that is the privacy risk. A per-action mode switch would be a small
follow-up; today the mode is global. Example:

```bash
gcloud run services update event-photo-api --region=us-central1 --project=mmr-data-pipeline --update-env-vars=RECAPTCHA_MODE=enforce,RECAPTCHA_MIN_SCORE=0.3
```

Rollback takes one command and no deploy:

```bash
gcloud run services update event-photo-api --region=us-central1 --project=mmr-data-pipeline --update-env-vars=RECAPTCHA_MODE=shadow
```

## 4. Free options for "real people only", ranked for this app

Cost below is per month at this app's volume. "Effort" is engineering time. Prices
change; check the official page before relying on a figure.

| # | Option | Cost | Friction for attendees | Effort | Verdict |
|---|---|---|---|---|---|
| 1 | **reCAPTCHA Enterprise per action** (fix + shadow → enforce, this PR) | 10k assessments/month free; billing is already on, so past that the old tiers were about $8 flat up to 100k, then about $1 per 1k. Our gated volume is about 1k/day on peak event days, about 0 otherwise. | None (invisible); a few blocked if the score is wrong | Done | **Do now.** Already wired in; it needed only the key and a safe rollout. |
| 2 | **Per-IP rate limits as well as per-uid**, on sign and search (`rateLimit.ts` `keyFn` already supports it) | Free (one Firestore write per request, as now) | Shared IPs: race-day venue Wi-Fi and carrier NAT can put many people behind one IP, so set the limit about 10× the per-uid one, and log it in shadow mode first | Small | **Do next.** It closes the "new anonymous uid = new quota" hole, which reCAPTCHA scores alone don't. |
| 3 | **Abuse signals from logs**: signed originals per uid/IP per hour, plus a budget alert on GCS egress from the derivatives bucket | Free (log-based metrics this small fit the free allotment) | None | Small | **Do next.** Egress is the real cost. Watch the meter that bills, not Hosting (`CLAUDE.md`). |
| 4 | **Firebase App Check (reCAPTCHA Enterprise provider)** on every `/api/**` call, checked with `firebase-admin` `getAppCheck().verifyToken()` | Each token refresh is one assessment, from the same free 10k (default TTL 1h, refreshed at about half the TTL), so about 2 per hour per active tab. Server-side checking is a local JWT check and free. | None | Medium (web init, api middleware, shadow mode first) | **Later.** It covers *every* route, including gallery listing, but a token can be replayed for its whole TTL. It adds to the per-action check on search/download rather than replacing it. Free-tier figures are for billing-enabled projects; without billing, only 4 score levels are available. |
| 5 | **Cloudflare Turnstile** in place of reCAPTCHA | Free, no per-assessment quota | None (managed/invisible); fewer ad-blocker failures than Google's script, and more privacy-friendly | Medium (web widget + server `siteverify` + CSP) | **Keep as the fallback.** Switch only if assessment volume outgrows the free tier or `missing_token` turns out to be high. The model is the same, so the shadow/enforce rollout carries over. |
| 6 | **Real sign-in (email link / Google) for heavy actions**: bulk ZIP, or Find-Me beyond N searches | Free (Firebase Auth, without SMS) | High on race day: a phone, a finish line, and now an inbox | Medium | **Not during an event.** Consider sign-in for *bulk ZIP only*, outside events. Find-Me already collects a name and consent. |
| 7 | **Honeypot field + submit timing** on the Find-Me form | Free | None | Small | **Low value.** Bots call the JSON API directly and never render the form. |
| 8 | **Proof-of-work** (self-hosted, e.g. ALTCHA-style) | Free | Costs battery and time on phones | Medium | **Low value.** It makes bulk scripts cost more but does nothing against targeted face-probing. |
| 9 | **Signed short-lived page tokens** | Free | None | Small | **Skip.** A bot fetches the token the way the page does. The Firebase ID token already plays this role. |
| 10 | **Cloud Armor** | Not free: needs an external Application Load Balancer + serverless NEG (≈ $18/month forwarding rule, always on) + $5/policy + $1/rule + $0.75/M requests. It can't sit behind the Firebase Hosting rewrite. | None | Large | **Reject.** It breaks the zero-idle-cost policy and the Hosting routing. |

**Recommendation:** finish #1 (this PR + §3). Then add #2 and #3 as one small PR,
also observe-only first. Revisit #4/#5 after the threshold has been enforced for
one event.

## 5. Risks to decide before enforcing

- **`missing_token` gets blocked in enforce mode, whatever the threshold.**
  Ad blockers and privacy browsers block `google.com/recaptcha`; the web client
  then sends no token (`web/src/lib/recaptcha.ts` swallows the error). If shadow
  mode shows more than ~1–2% `missing_token`, either show a clear "disable your
  blocker" message on the 403 before enforcing, or move to Turnstile. Allowing
  token-less requests would let any bot skip the check.
- The **self-check costs one assessment per instance start**. That is negligible
  at scale-to-zero, but it is a real billed call (`max-instances=20`).
- The **verdict line logs `uid`** (already in request logs) and no IP. It is
  operational data, not biometrics.
- The second key, `recaptcha-assessment` (uid `b35c4c40-…`), is unused once step
  3 is done. Delete it, so nobody points the secret at the wrong key again.

Sources: reCAPTCHA tiers and billing
(<https://cloud.google.com/recaptcha/docs/compare-tiers>,
<https://cloud.google.com/recaptcha/docs/billing-information>); App Check
reCAPTCHA Enterprise provider, TTL and billing
(<https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider>);
Cloud Armor pricing (<https://cloud.google.com/armor/pricing>); Cloud Run secrets
resolved at instance startup (<https://cloud.google.com/run/docs/configuring/secrets>).
