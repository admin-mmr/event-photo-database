# Prompt — add test coverage for email notification feature

Paste this into a new Haiku session. It is self-contained; the model does not need any prior conversation context.

---

You are working in `/Users/cathylin/github/mmr/event-photo-database/gas-app`. This is a Google Apps Script TypeScript project built with `esbuild` and tested with Jest + `ts-jest`. A new email notification feature just landed and has **zero test coverage**. Your job is to write unit tests for the new code and finish with a coverage breakdown report.

## Ground rules

- Write tests only. Do not modify production source under `src/` unless you find a bug that blocks a test — in that case, fix the smallest thing possible and call it out in your final report.
- Follow the existing test conventions. Read `gas-app/tests/unit/auditLogService.test.ts` and `gas-app/tests/unit/userService.test.ts` first — they are the reference style (AAA layout, `describe` per function, `beforeEach(resetMockSheets)`, mock helpers from `tests/mocks/gasGlobals.ts`).
- Use Jest matchers, `jest.spyOn`, and the shared mocks. Do not reach for new mocking libraries.
- Every new test file goes under `gas-app/tests/unit/` and is named `<moduleName>.test.ts`.
- All file paths in this prompt are absolute. Read them with the Read tool before writing tests that reference their exports.

## What the feature added

The notification subsystem has these new / modified files:

**New**
- `src/services/emailService.ts` — central send + notifyUserCreated / notifyUserRoleChanged / notifyUserStatusChanged / notifySecurityEvent / sendDailyReport / sendWeeklyReport / installEmailReportTriggers / uninstallEmailReportTriggers
- `src/services/emailPreferenceService.ts` — getPreferencesFor / savePreferences / listRecipientsForType / listAllAdminEmails / isOptedIn / ensureSheetHeaders
- `src/ui/templates/admin/email_prefs.html` — admin UI (HTML only, no tests needed)

**Modified**
- `src/types/enums.ts` — added `EmailType` enum and four `AuditAction` values (`EMAIL_SENT`, `EMAIL_FAILED`, `EMAIL_PREFS_UPDATED`, `SECURITY_EVENT_DETECTED`)
- `src/types/models.ts` — added `EmailPreferenceRecord`
- `src/types/config.ts` — added `EMAIL_PREFERENCES` sheet + `EmailPreferencesSheetColumns`
- `src/config/constants.ts` — added column map + `EMAIL_PREFERENCES_HEADERS`
- `src/utils/sheetMapper.ts` — added `toOptInBoolean`, `toEmailPreferenceRecord`, `fromEmailPreferenceRecord`
- `src/routes/pageRoutes.ts` — added `adminEmailPrefsPage(user, sessionToken)`

`src/main.ts` was wired but is excluded from coverage by `jest.config.js` (`!src/main.ts`), so you do NOT write tests for the `serverGetMyEmailPrefs` / `serverUpdateMyEmailPrefs` / `dailyReportTrigger` / `weeklyReportTrigger` / trigger-install helpers. The service functions they delegate to are where the logic lives.

## Fixture / mock gaps you must fill first

Open `gas-app/tests/mocks/gasGlobals.ts` and add **only what's missing**:

1. `MailApp.getRemainingDailyQuota` — the existing mock only has `sendEmail`. Add `getRemainingDailyQuota: jest.fn().mockReturnValue(100)` so the quota branch in `emailService.send` has a default. Also export a `resetMockMailApp()` helper that `mockClear()`s both functions and resets the quota to 100.
2. `ScriptApp` — does not exist today. Add a mock with `newTrigger`, `getProjectTriggers`, `deleteTrigger`. `newTrigger(name)` should return a chainable builder stub (`.timeBased().everyDays(n).atHour(h).create()` / `.timeBased().onWeekDay(d).atHour(h).create()`) that records the handler name and schedule on a module-level array you expose as `mockInstalledTriggers`. `getProjectTriggers()` returns that array mapped to objects with `getHandlerFunction()` and `.getEventType()` jest.fn getters.
3. `getCanonicalScriptUrl` is imported from `src/utils/scriptUrl` — if tests end up exercising it and it touches `ScriptApp.getService().getUrl()`, mock it with `jest.mock('../../src/utils/scriptUrl', ...)` in the individual test file rather than globally.
4. Add a `DEFAULT_EMAIL_PREFERENCES_ROWS` constant shaped like the other defaults, and a helper `setupEmailPreferencesSheet(rows?)` that installs a mock sheet under the `Email_Preferences` name. Match the 8-column layout from `EMAIL_PREFERENCES_HEADERS` in `src/config/constants.ts`.

Register whatever you add in the `resetMockSheets()` / export list so test files can import them.

## Test files to write

### 1. `tests/unit/emailPreferenceService.test.ts`

Cover:
- `getPreferencesFor(email)` returns the default record when no sheet row exists (transactional ON, digests OFF, `updatedAt === ''`).
- Returns the sheet-backed record when one exists; is **case-insensitive** on email match.
- `savePreferences(input)` appends a new row when none exists, updates in place when a row exists, and **always stamps `updatedAt`** even if the caller passed one (use a frozen `Date.now`).
- Rejects empty email with `ResultStatus.ERROR`.
- Returns `ResultStatus.ERROR` when the sheet throws (simulate by making `findRowIndex` / `appendRow` throw).
- `listRecipientsForType(EmailType.WELCOME_USER)` returns `[]`.
- For every other `EmailType`, returns only admins whose pref is `true`. Admins with no row get the default policy (so `DAILY_REPORT` default excludes them, `USER_CREATED` default includes them).
- Inactive admins are never returned, even if their pref is `true`.
- `listAllAdminEmails()` returns every active admin, ignoring preferences entirely.
- `isOptedIn` returns the correct boolean for each of the 7 `EmailType` values, including `WELCOME_USER → false`.
- `ensureSheetHeaders()` returns SUCCESS on the happy path and ERROR when `ensureHeaders` throws.

### 2. `tests/unit/emailService.test.ts`

This is the biggest file. Group tests by public function.

**`send()` (test indirectly via the notifyXxx functions; don't export it).** Cover:
- No recipients at all → returns SUCCESS with `data.to = [] data.cc = []`; `MailApp.sendEmail` not called; no audit row.
- `cc` addresses that also appear in `to` are removed from cc.
- Lowercases and trims all addresses; dedupes; filters obviously-invalid strings (no `@`).
- Quota check: when `getRemainingDailyQuota()` returns `< to.length + cc.length`, no send, returns ERROR, writes an `EMAIL_FAILED` audit row with `reason: 'quota'`.
- Quota check: when `getRemainingDailyQuota()` throws, the send still proceeds (quota is soft).
- `MailApp.sendEmail` throwing results in ERROR + `EMAIL_FAILED` audit row with `reason: 'mailapp_error'`.
- Success path writes an `EMAIL_SENT` audit row with `type`, `to`, `cc`, `subject`.

**`notifyUserCreated(newUser, createdByAdminEmail)`:**
- Sends a WELCOME-style email with `to = newUser.email`.
- CC includes every active admin, not just opted-in ones (regression test for the explicit product requirement).
- CC is de-duped if `createdByAdminEmail` is also in the admin list.
- HTML body contains the user's email (escaped) and a link built from `getCanonicalScriptUrl()` — mock that to return `https://example.test/script`.
- Does not throw if `MailApp.sendEmail` throws; returns ERROR.

**`notifyUserRoleChanged(updatedUser, previousRole, actorEmail)`:**
- `to` is the opted-in admins only (`listRecipientsForType(EmailType.USER_ROLE_CHANGED)`).
- When no admin opted in, returns SUCCESS with empty recipients and no `MailApp.sendEmail` call.
- HTML references both the old and new role.

**`notifyUserStatusChanged(updatedUser, newStatus, actorEmail)`:**
- Sends to opted-in admins for `EmailType.USER_DEACTIVATED`.
- Subject and body reflect the new status (deactivated vs. reactivated).

**`notifySecurityEvent({ email, reason, ip? })`:**
- Writes a `SECURITY_EVENT_DETECTED` audit row **before** sending.
- Sends to opted-in admins for `EmailType.SECURITY_EVENT`.
- When no admins have opted in, the audit row is still written.
- When `MailApp` throws, the `SECURITY_EVENT_DETECTED` audit row is still present.

**`sendDailyReport()` / `sendWeeklyReport()`:**
- Uses `summaryService.generateSummary()` — mock that module.
- Date window for daily = yesterday, weekly = last 7 days (verify via the argument passed to `generateSummary`).
- Sends to opted-in admins for the respective `EmailType`.
- When `generateSummary` returns `{ status: ERROR }`, no email is sent, an `EMAIL_FAILED` audit row is written, and the service returns ERROR.

**`installEmailReportTriggers()`:**
- Calls `uninstallEmailReportTriggers()` first (use a spy on `ScriptApp.getProjectTriggers`).
- Creates exactly two triggers with handler names `dailyReportTrigger` and `weeklyReportTrigger`.
- Idempotent — calling twice leaves the project with two triggers (assert the `deleteTrigger` call count).

**`uninstallEmailReportTriggers()`:**
- Only deletes triggers whose handler name matches the two report handlers; leaves unrelated triggers alone.

### 3. `tests/unit/sheetMapper.emailPreferences.test.ts`

Add to the existing sheetMapper test file, OR create this sibling file — whichever keeps the suite under ~400 lines.

- `toOptInBoolean`: `TRUE` / `FALSE` / `true` / `false` / `yes` / `no` / `1` / `0` / `''` / `undefined` / number `1` / number `0` — assert each maps correctly; unknown strings → `false`.
- `toEmailPreferenceRecord(row)`: valid 8-column row → populated record; short row → `null`; long row → still parses first 8 columns; row with empty email → `null`.
- `fromEmailPreferenceRecord(record)`: round-trips through `toEmailPreferenceRecord` with identical shape. Booleans serialise as literal `TRUE` / `FALSE` strings (match the convention used by the other `fromXxx` helpers — check `fromUserRecord` for reference).

### 4. `tests/unit/pageRoutes.adminEmailPrefs.test.ts`

Focused test for `adminEmailPrefsPage(user, sessionToken)`:
- Calls `getPreferencesFor(user.email)` and injects the returned record as JSON via the template.
- Passes `sessionToken`, `userEmail`, `userRole`, `isAdmin` correctly to the template evaluator.
- Uses the `HtmlService` mock in `gasGlobals.ts` — assert `createTemplateFromFile` was called with `'ui/templates/admin/email_prefs'`.

## Verification

After writing all tests, run:

```
cd /Users/cathylin/github/mmr/event-photo-database/gas-app
npm run test -- --coverage --coverageReporters=text --coverageReporters=json-summary 2>&1 | tail -80
```

The `jest.config.js` coverage thresholds are 80% branches / 85% functions / 85% lines / 85% statements globally. The global gate should still pass after your work.

## Deliverable — final report

End your session with a single message that contains:

1. **Summary** (≤5 bullets): what test files you created, total tests added, any production bugs you found.
2. **Coverage table** (copy from the Jest `text` summary, trimmed to just the new/modified files):

   | File | Statements | Branches | Functions | Lines |
   | --- | --- | --- | --- | --- |
   | `services/emailService.ts` | … | … | … | … |
   | `services/emailPreferenceService.ts` | … | … | … | … |
   | `utils/sheetMapper.ts` (delta) | … | … | … | … |
   | `routes/pageRoutes.ts` (delta) | … | … | … | … |

3. **Uncovered lines** (if any): list them per file with a one-sentence reason each (e.g. "line 217 — defensive throw branch; only reachable if MailApp mock is removed, not worth asserting").

4. **Global thresholds**: PASS / FAIL with the final numbers.

Keep the final report under 400 words. Do not paste full test file contents — the user can read them from disk.
