# Email Notification Service

This document describes the email notification subsystem added to the 湘舍动公益文件系统 Google Apps Script app: what it does, where it lives, how admins control it, and how it is rolled out.

## Goals

The system sends three classes of email:

1. **Welcome mail** to a newly-added user, with a link to the main page, CC'd to every admin so the team knows a new member was added.
2. **Transactional alerts** to admins when another admin changes a user record (role change, deactivation, reactivation) or when suspicious auth activity is observed.
3. **Recurring digests** — opt-in daily and weekly system summaries — pulled from the existing `summaryService` so admins can watch for reconciliation drift without opening the app.

Every admin controls which of those emails they personally receive through an Email Preferences page. Transactional alerts default to ON so new admins aren't silently out of the loop; digests default to OFF so nobody gets mail they didn't ask for.

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
| `WELCOME_USER` | After `serverCreateUser` succeeds | n/a (transactional, addressed to the new user) | new user; admins CC'd |
| `USER_CREATED` | After `serverCreateUser` succeeds | ON | opted-in admins (+ every admin on the first call, since the new user's welcome CC list is the full admin set) |
| `USER_ROLE_CHANGED` | `serverUpdateUser` detects a role diff vs. snapshot | ON | opted-in admins |
| `USER_DEACTIVATED` | `serverDeactivateUser` / `serverReactivateUser` | ON | opted-in admins |
| `SECURITY_EVENT` | Google ID-token verified but email not in Users sheet; OAuth callback cannot resolve user | ON | opted-in admins |
| `DAILY_REPORT` | `dailyReportTrigger` scheduled trigger | OFF | opted-in admins |
| `WEEKLY_REPORT` | `weeklyReportTrigger` scheduled trigger | OFF | opted-in admins |

### Why welcome-mail CC's every admin

The product requirement was "CC all the admins in the user list" on new user creation, regardless of opt-in state. Other events only send to opted-in admins via `listRecipientsForType(EmailType.X)`. For `notifyUserCreated` we use `listAllAdminEmails()` for the CC list and dedupe against the `to:` recipient to avoid double-billing a quota slot.

## Sheet schema — `Email_Preferences`

| Column (0-indexed) | Header | Type | Notes |
| --- | --- | --- | --- |
| 0 | `email` | string | Lowercased, trimmed. Primary key. |
| 1 | `user_created` | boolean | TRUE / FALSE (accepts 1/0/yes/no too). |
| 2 | `user_role_changed` | boolean | |
| 3 | `user_deactivated` | boolean | |
| 4 | `security_event` | boolean | |
| 5 | `daily_report` | boolean | |
| 6 | `weekly_report` | boolean | |
| 7 | `updated_at` | ISO 8601 string | Stamped by `savePreferences()`; blank means "never saved, using defaults". |

Missing rows are intentional: `getPreferencesFor(email)` returns a synthetic default record rather than requiring every admin to have a row. Admins who never touch the Email Preferences page get the default policy forever — no background migration needed when we add new admins.

Headers are created lazily by `ensureSheetHeaders()` on the first `savePreferences()` call, so no manual sheet setup is required before rollout.

## Admin UI

Route: `?action=admin_email_prefs` (admin-only, enforced in `router.getGetRoutes`).

`pageRoutes.adminEmailPrefsPage(user, sessionToken)` pre-loads the caller's saved prefs (or defaults) and injects them as `window.INITIAL_PREFS` into `src/ui/templates/admin/email_prefs.html`. The template groups toggles under "User-management alerts" and "Recurring digests" so the different default policies and frequencies are visually separated.

Save goes through `google.script.run.serverUpdateMyEmailPrefs(payload)` via the shared `callServer` helper, which auto-injects the session token. On success, the server returns the upserted record and the page updates its baseline so the Cancel button reverts to the newly-saved state (not the state at page load).

## Scheduled triggers

GAS time-based triggers can only fire top-level globals, so `main.ts` exports thin wrappers `dailyReportTrigger()` and `weeklyReportTrigger()` that delegate to `emailService.sendDailyReport()` and `sendWeeklyReport()`.

Two helper editor functions are provided for install / uninstall:

- `installEmailTriggers()` — idempotent; clears any existing `dailyReportTrigger` / `weeklyReportTrigger` triggers and reinstalls a daily (08:00 every day) and weekly (Monday 08:00) pair via `ScriptApp.newTrigger`.
- `removeEmailTriggers()` — removes only the two email triggers, leaves other scheduled triggers (e.g. Photos sync) alone.

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
4. Verify by creating a throwaway test user from `?action=admin_users`. Confirm the new user receives a welcome mail and every admin receives the `USER_CREATED` alert.

## Testing checklist

- [ ] Create user → welcome mail sent to new user, CC'd to admin list.
- [ ] Change user role via admin Users page → opted-in admins receive role-change mail; opted-out admins don't.
- [ ] Deactivate + reactivate user → both opted-in admins receive a single mail per action.
- [ ] Log in with a Google account not in the Users sheet → opted-in admins receive a security-event mail.
- [ ] Manually run `dailyReportTrigger()` from the editor → opted-in admins receive the daily digest with correct per-day counts pulled from `summaryService.generateSummary()`.
- [ ] Toggle off every preference for one admin and repeat the flows above → that admin receives nothing (except welcome-mail CC, which is policy).
- [ ] Simulate quota exhaustion by sending 100+ mails in one day → subsequent sends are skipped and logged as `EMAIL_FAILED / quota_exceeded`.

## Future work

- **Move to an external provider.** SendGrid or AWS SES would lift the 100/day ceiling, give us delivery receipts, and let us A/B templates without editing GAS code. The `send()` function is the only place that knows about `MailApp`.
- **Per-club scoped notifications.** Today every alert goes to every admin. A future iteration could honour `runningClub` on the actor and only CC admins for that club.
- **Unsubscribe link.** The current opt-in flow lives in the admin UI. Adding a signed unsubscribe link in the email footer would let admins opt out from their inbox without logging in.
- **Queue sends.** Under high churn (bulk user import), hitting quota mid-operation loses notifications silently. A simple "mail queue" sheet with a 5-minute retry trigger would make the pipeline crash-safe.
