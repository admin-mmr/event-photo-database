# Audit Log Page Guide

## Overview

The **Audit Log** page (`?action=admin_audit`) provides a searchable, filterable view of all administrative actions performed in the system. Every user creation, event modification, file deletion, security event, and other important action is logged with the actor, timestamp, and relevant details.

## Why is the page empty?

The page defaults to showing **the last 7 days** of activity. If nothing has happened in the past week, you'll see an empty table. Use the quick-range chips or date filters to see older data.

## How to see everything

### Option 1: Quick-Range Chip (Fastest)
1. Click the **"All time"** chip at the top of the filters
   - This removes all date bounds and shows all audit log entries ever
   - The page will load 50 entries per page; use pagination to browse

### Option 2: Manual Date Range
1. Click the **"From date"** field and clear it (or set to earliest date you care about)
2. Click the **"To date"** field and clear it (or set to today)
3. Entries will update automatically after a short delay

### Option 3: Reset Everything
1. Click the **"Reset"** button to return to the default (last 7 days, all categories)

---

## Filter Guide

### Quick-Range Chips
Located at the top of the filter panel:

- **Today** — Shows only today's actions
- **Last 7 days** — Default range; shows the past week
- **Last 30 days** — Shows the past month
- **All time** — Shows every audit log entry ever recorded

Choose one at a time. The chosen chip is highlighted in blue.

### Category Toggles
Nine category pills below the quick-range chips. Each action is tagged with one:

| Category | What it logs |
|----------|-------------|
| **User** | User creation, updates, activation/deactivation |
| **Event** | Event creation, updates, failures |
| **Club** | Club creation, updates, activation/deactivation |
| **Link** | Upload link generation, revocation, key rotation |
| **File** | File and folder deletions, restorations |
| **Upload** | Upload completions, client-side errors |
| **Email** | Emails sent, delivery failures, preference changes |
| **Security** | Failed admin auth, security alerts, masquerade sessions |
| **Other** | New actions not yet categorized; future-proof bucket |

**To filter:** Click a pill to toggle it on/off. Toggled-on pills appear green and contribute results. Multiple selections are **OR** (show records matching any selected category).

**Buttons:**
- **All** — Turn on all category pills (no filtering by category)
- **None** — Turn off all category pills (empty result set)

### Date Range Filters

- **From date** — Inclusive lower bound (e.g., `2026-04-01` includes that entire day)
- **To date** — Inclusive upper bound (e.g., `2026-04-30` includes that entire day)

Leave both blank to search all time. Editing either field clears the quick-range chip highlight.

### Actor Email Filter

- **Actor email contains** — Case-insensitive substring search
  - Examples: `alice` matches `alice@example.com`
  - `mmrunners` matches `bob@mmrunners.org`
  - Useful for finding all actions by a specific person

### Reset Button

Clears all filters and returns to the default state:
- Quick-range: **Last 7 days**
- All categories: **enabled**
- Actor: **blank**
- Dates: **default 7-day window**

---

## Reading the Audit Log Table

### Columns

| Column | Content |
|--------|---------|
| **Timestamp** | ISO 8601 date and time of the action |
| **Actor** | Email of the admin who performed the action |
| **Action** | The action type (e.g., `USER_CREATED`, `FILE_DELETED`) |
| **Resource** | What was affected (e.g., user email, club name, file ID) |
| **Details** | JSON payload; click to expand/collapse truncated details |

### Details Cell

Click the **Details** cell in any row to expand/collapse the full JSON payload. Useful for understanding exactly what changed, who was affected, or why an action failed.

---

## Pagination

At the bottom of the table:

- **Total badge** — Shows the total number of matching records
- **Page indicator** — "Page X of Y"
- **Previous/Next** — Navigate between pages (50 records per page)

Pagination only appears if there are more than 50 results.

---

## Common Use Cases

### "Who deleted file X?"
1. Go to **Audit Log**
2. Leave dates as default (last 7 days) or extend if needed
3. Turn **off** all categories **except** "File"
4. If you know who might've done it, filter by **Actor email**
5. Search the **Resource** column for the file name/ID
6. Click **Details** to see what was deleted and why (if a reason was recorded)

### "What changed on my account last month?"
1. Set **From date** to first day of last month
2. Set **To date** to last day of last month
3. Filter **Actor email** to your email
4. Leave categories **all on** to see everything
5. Scan the results or search for specific action types

### "What security events happened in the last 3 days?"
1. Click **Last 7 days** (or manually set dates)
2. Turn **off** all categories **except** "Security"
3. Review the list for failed logins, masquerade sessions, etc.
4. Click **Details** to see IP addresses or other metadata

### "How many users were created this week?"
1. Click **Last 7 days**
2. Turn **off** all categories **except** "User"
3. Look for `USER_CREATED` actions
4. Total badge shows the count

---

## Filter State Sharing

The URL updates as you filter. You can:

- **Bookmark** the current filtered view (e.g., a recurring search)
- **Share** the URL with another admin to show them the same filtered results
- **Refresh** the page and keep your filters intact

Example URLs:
```
?action=admin_audit&from=2026-04-01&to=2026-04-30
?action=admin_audit&actor=alice&cats=user,event
?action=admin_audit  (default: last 7 days, all categories)
```

---

## Technical Notes

### Filters Are Applied Client-Side
When you change a filter, the page calls `serverGetAuditLog(...)` to fetch the matching records. The server-side function:
- Loads the `Audit_Log` sheet
- Filters by actor email (substring, case-insensitive)
- Filters by date range (inclusive on both ends)
- Filters by categories (expands category names → action enum values)
- Paginates the results
- Returns `{ items, total, page, pageSize }`

### Filter Composition
Filters compose as **AND**:
- Actor **AND** date range **AND** categories
- If you select categories `user` + `event`, that's **OR** between those two (but **AND** with actor/date)

### Categories Map to Actions
The `AuditCategory` type in `auditLogService.ts` maps category names to `AuditAction` enum values:

```typescript
user: [USER_CREATED, USER_UPDATED, USER_DEACTIVATED, USER_REACTIVATED, ...]
event: [EVENT_CREATED, EVENT_UPDATED, ...]
...
other: [any action not in the above]  // computed dynamically
```

Adding a new `AuditAction` automatically falls into the `other` category until explicitly categorized.

### Performance
- Audit log is append-only; deletes/updates never happen
- All rows are loaded into memory and filtered in-place
- Pagination is done client-side on the filtered set
- Large deployments (10,000+ rows) may experience slight lag when filtering

---

## Troubleshooting

### Page shows "No audit entries found"
- Check your **date range**; the default is last 7 days
- Verify **categories** are enabled (not all set to off)
- Try **"All time"** quick-range chip

### Details cell shows `[object Object]`
- This is a display bug; the data is valid JSON
- The server is returning `details` as a pre-stringified JSON string
- Click to expand; the expansion handler should display it correctly

### Filter spinner spins forever
- Check the browser console for errors
- Verify you're authenticated (try refreshing)
- Large date ranges with many records may take a few seconds

### URL params are lost after refresh
- The `syncUrl()` function calls `window.history.replaceState(...)`
- Some GAS instances don't preserve URL hash/query params perfectly
- As a workaround, the page stores filter state in memory; reload clears it

---

## Architecture

### Files
- **Frontend:** `src/ui/templates/admin/audit.html` — HTML, filters, table, pagination
- **Backend:** `src/services/auditLogService.ts` — `getAuditLogs()`, `appendAuditLog()`
- **API:** `src/routes/reportHandlers.ts` — `serverGetAuditLog()` (server function)
- **Tests:** `tests/unit/auditLogService.test.ts` — Service layer tests
- **Tests:** `tests/unit/auditLogPage.test.ts` — UI logic tests (NEW)

### Data Flow
1. User adjusts filter on the page
2. `applyFilter(page)` collects filter state from DOM
3. `callServer('serverGetAuditLog', payload)` sends to GAS
4. Server function calls `getAuditLogs(query)` from service
5. Service loads sheet, filters in-memory, returns paginated result
6. Page receives result and calls `renderRows(items)` to populate table
7. `syncUrl(payload)` updates address bar

---

## Future Improvements

- [ ] Server-side filtering (handle large datasets without loading all rows)
- [ ] Export to CSV (use the summary service)
- [ ] Real-time updates (push new entries to page via websocket/polling)
- [ ] Saved filter presets (e.g., "Failed login attempts this month")
- [ ] Inline action detail view (modal or side panel)
