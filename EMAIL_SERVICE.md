# Email Notification Service

**最后更新：2026年4月23日** *(v3.0 — 已更新以反映链接授权上传模型；移除旧用户注册相关邮件类型)*

This document describes the email notification subsystem added to the 湘舍动公益文件系统 Google Apps Script app: what it does, where it lives, how admins control it, and how it is rolled out.

## Goals

The system sends two classes of email to admins:

1. **New-event alerts** — sent to all admins (跑团Admin and 系统管理员) whenever any admin creates a new event. Opt-in, defaults **ON** so everyone stays in the loop.
2. **Daily upload summaries** — sent to each 跑团Admin for their own club's uploads (non-realtime, once per day). Opt-in, defaults **OFF** so nobody receives mail they didn't ask for.

> **Note (v3.0):** The old `WELCOME_USER`, `USER_CREATED`, `USER_ROLE_CHANGED`, and `USER_DEACTIVATED` email types have been **removed**. In the new model, photographers upload via a link with no registration step, and admins are whitelisted directly in the Admins sheet — there is no user-creation flow that generates emails.

Every admin controls which emails they receive through the Email Preferences page. Email failures are never silently dropped: the system shows a visible in-app alert and retries with exponential back-off; repeated failures escalate to a visible warning banner.

## Architecture

```
                 ┌─────────────────────────┐
  doPost / goog  │ server* entry functions │
  .script.run ──▶│  (main.ts, top-level)   │
                 └────────────┬────────────┘
                              │ calls service methods
                              ▼
  ┌────────────────────────────────────────────────────┐
  │ services/userService, eventService, oauthService…  │
  │ — after a successful state change, each calls:     │
  └────────────────────────┬───────────────────────────┘
                           │ notifyUserCreated / RoleChanged / etc.
                           ▼
           ┌──────────────────────────────────┐
           │ services/emailService.ts          │
           │   resolve recipients ─────────┐  │
           │   render HTML + plain-text    │  │
           │   check MailApp quota         │  │
           │   MailApp.sendEmail           │  │
           │   appendAuditLog              │  │
           └───────────┬──────────────────────┘
                       │ listRecipientsForType
                       ▼
           ┌──────────────────────────────────┐
           │ services/emailPreferenceService  │
           │   defaults  +  sheet-backed rows │
           └──────────────────────────────────┘
```

`emailService` is the single choke point. No other service calls `MailApp` directly. This centralises branding, opt-in filtering, quota handling, and audit logging — if we ever move to a mail relay (SendGrid, AWS SES) only `emailService.send()` needs to change.

Email failures never roll back the caller. Every `notifyXxx()` call from `main.ts` is wrapped in `try/catch { Logger.log(...) }` so a mail outage can't block user creation or login.

## Files touched

| File | Purpose |
| --- | --- |
| `src/services/emailService.ts` *(new)* | Central send + notifyXxx + sendDaily/WeeklyReport + installEmailReportTriggers |
| `src/services/emailPreferenceService.ts` *(new)* | Defaults, sheet CRUD, listRecipientsForType |
| `src/types/enums.ts` | Added `EmailType`, four `AuditAction` values, `RouteAction.ADMIN_EMAIL_PREFS` |
| `src/types/models.ts` | Added `EmailPreferenceRecord` |
| `src/types/config.ts` | Added `EMAIL_PREFERENCES` sheet name + `EmailPreferencesSheetColumns` |
| `src/config/constants.ts` | Added column map + `EMAIL_PREFERENCES_HEADERS` + sheet name constant |
| `src/utils/sheetMapper.ts` | `toOptInBoolean`, `toEmailPreferenceRecord`, `fromEmailPreferenceRecord` |
| `src/main.ts` | Wired notify calls into user/oauth flows; added `serverGetMyEmailPrefs`, `serverUpdateMyEmailPrefs`, `dailyReportTrigger`, `weeklyReportTrigger`, `installEmailTriggers`, `removeEmailTriggers` |
| `src/routes/router.ts` | Registered `ADMIN_EMAIL_PREFS` route; `notifySecurityEvent` on OAuth failure |
| `src/routes/pageRoutes.ts` | `adminEmailPrefsPage(user, sessionToken)` |
| `src/ui/templates/admin/email_prefs.html` *(new)* | Admin UI with MDL toggles per email type |

## EmailType catalogue

Defined in `src/types/enums.ts`:

| Enum value | When it fires | Default | Recipients |
| --- | --- | --- | --- |
| `NEW_EVENT_ALERT` | After any admin creates a new event | ON | All opted-in admins (both 跑团Admin and 系统管理员) |
| `DAILY_UPLOAD_SUMMARY` | `dailyReportTrigger` scheduled trigger (08:00 daily) | OFF | Each 跑团Admin receives a summary scoped to their club only |
| `SECURITY_EVENT` | Google OAuth verified but email not in Admins whitelist; OAuth callback cannot resolve user | ON | All opted-in admins |

> **Removed in v3.0:** `WELCOME_USER`, `USER_CREATED`, `USER_ROLE_CHANGED`, `USER_DEACTIVATED`, `WEEKLY_REPORT`. These were tied to the old Users-sheet registration model which no longer exists.

### Club-scoped daily summaries

`DAILY_UPLOAD_SUMMARY` is always scoped per-club. `listRecipientsForType(EmailType.DAILY_UPLOAD_SUMMARY, clubId)` returns only the admins for that specific club. The trigger iterates over all active clubs and sends one email per club, so admins never see other clubs' data.

## Sheet schema — `Email_Preferences`

| Column (0-indexed) | Header | Type | Notes |
| --- | --- | --- | --- |
| 0 | `email` | string | Lowercased, trimmed. Primary key. |
| 1 | `new_event_alert` | boolean | TRUE / FALSE (accepts 1/0/yes/no too). Default ON. |
| 2 | `daily_upload_summary` | boolean | Default OFF. Club-scoped; only relevant for 跑团Admin. |
| 3 | `security_event` | boolean | Default ON. |
| 4 | `updated_at` | ISO 8601 string | Stamped by `savePreferences()`; blank means "never saved, using defaults". |

Missing rows are intentional: `getPreferencesFor(email)` returns a synthetic default record rather than requiring every admin to have a row. Admins who never touch the Email Preferences page get the default policy forever — no background migration needed when we add new admins.

Headers are created lazily by `ensureSheetHeaders()` on the first `savePreferences()` call, so no manual sheet setup is required before rollout.

## Admin UI

Route: `?action=admin_email_prefs` (admin-only, enforced in `router.getGetRoutes`).

`pageRoutes.adminEmailPrefsPage(user, sessionToken)` pre-loads the caller's saved prefs (or defaults) and injects them as `window.INITIAL_PREFS` into `src/ui/templates/admin/email_prefs.html`. The template groups toggles under "User-management alerts" and "Recurring digests" so the different default policies and frequencies are visually separated.

Save goes through `google.script.run.serverUpdateMyEmailPrefs(payload)` via the shared `callServer` helper, which auto-injects the session token. On success, the server returns the upserted record and the page updates its baseline so the Cancel button reverts to the newly-saved state (not the state at page load).

## Scheduled triggers

GAS time-based triggers can only fire top-level globals, so `main.ts` exports a thin wrapper `dailyReportTrigger()` that delegates to `emailService.sendDailyUploadSummary()`.

Two helper editor functions are provided for install / uninstall:

- `installEmailTriggers()` — idempotent; clears any existing `dailyReportTrigger` trigger and reinstalls a daily (08:00 every day) trigger via `ScriptApp.newTrigger`.
- `removeEmailTriggers()` — removes only the email trigger, leaves other scheduled triggers (e.g. Photos sync) alone.

> **Removed in v3.0:** `weeklyReportTrigger` and the Monday 08:00 weekly trigger have been removed along with the `WEEKLY_REPORT` email type.

Run both from the Apps Script editor's "Run" menu after a `npm run push`.

## Quota awareness

`emailService.send()` checks `MailApp.getRemainingDailyQuota()` before every send. If the remaining quota is smaller than `to.length + cc.length` it:

1. Skips the send.
2. Writes an `EMAIL_FAILED` audit entry with `reason: 'quota_exceeded'` and the intended recipient set.
3. Returns `{ status: WARNING }` so the caller knows the send was dropped without throwing.

Consumer-account quotas are ~100/day. If the team grows beyond that we should switch to a Workspace account (1,500/day) or move to an external transactional-mail provider (see "Future work" below).

## Audit trail

Every sent, skipped, or failed email writes an `AuditAction.EMAIL_SENT` / `EMAIL_FAILED` row with:

- `actor_email` — the admin whose action produced the mail, or `system` for scheduled digests
- `resource_type` — `email`
- `resource_id` — the `EmailType` enum value
- `details` — `{ to, cc, reason? }`

Security events additionally write `AuditAction.SECURITY_EVENT_DETECTED` before the email pipeline runs, so even a quota-exceeded security alert is recorded.

## Rollout steps

Do these once per environment (dev / prod Script project):

1. Merge this branch and `npm run push`. The build inlines the new templates under `dist/ui/` and rewrites `Code.js` with the new server functions.
2. From the Apps Script editor, run `installEmailTriggers()` under the authoritative admin account. This creates the two time-based triggers and grants `UrlFetchApp` / `MailApp` scopes if the OAuth consent screen hasn't already granted them.
3. From any admin browser session, visit `?action=admin_email_prefs` and save preferences. This both validates the round-trip and creates the `Email_Preferences` sheet (or adds headers) on first save.
4. Verify by creating a test event from the admin UI. Confirm opted-in admins receive the new-event alert, and opted-out admins do not.

## Testing checklist

- [ ] Create a new event → all opted-in admins receive a new-event alert; opted-out admins don't.
- [ ] Upload photos as a photographer → club admin receives the daily summary next morning (run `dailyReportTrigger()` manually to verify immediately).
- [ ] Log in with a Google account not in the Admins whitelist → opted-in admins receive a security-event mail.
- [ ] Manually run `dailyReportTrigger()` from the editor → each 跑团Admin receives a daily digest scoped to their club only, with correct upload counts.
- [ ] Toggle off every preference for one admin → that admin receives nothing.
- [ ] Simulate quota exhaustion by sending 100+ mails in one day → subsequent sends are skipped, logged as `EMAIL_FAILED / quota_exceeded`, and an in-app warning banner appears for admins.
- [ ] Simulate a mail failure → confirm in-app alert is shown and system performs exponential back-off retry; confirm failure does not block the operation that triggered the email.

## Future work

- **Move to an external provider.** SendGrid or AWS SES would lift the 100/day ceiling, give us delivery receipts, and let us A/B templates without editing GAS code. The `send()` function is the only place that knows about `MailApp`.
- **Unsubscribe link.** The current opt-in flow lives in the admin UI. Adding a signed unsubscribe link in the email footer would let admins opt out from their inbox without logging in.
- **Queue sends.** Under high churn, hitting quota mid-operation loses notifications silently. A simple "mail queue" sheet with a 5-minute retry trigger would make the pipeline crash-safe.
- **Photographer upload receipt email.** Currently photographers only see an in-app receipt. Optionally emailing them a copy (with upload summary + album link) would be a nice touch once the Google Photos album URL is reliable.
