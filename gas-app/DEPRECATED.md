# ⚠️ gas-app is being retired

The control plane this Apps Script app provides — users, clubs, events, upload
links, email, audit, duplicates/trash, reporting, and the partner API — has been
reimplemented in **`../cloud-webapp/`** (dev plan milestones G1–G5,
`../GAS_MIGRATION_DEV_PLAN.md`).

**Source of truth is unchanged:** the same Google Sheet and Google Drive. Only
the *writer* moves from this app to cloud-webapp. There is no data migration.

## Status

- **Do not add features here.** New control-plane work goes in `cloud-webapp/`.
- This tree is kept as read-only reference until cutover completes.
- Cutover is operational, not code: follow **`../CUTOVER_RUNBOOK.md`**.

## Where each function now lives

| gas-app | cloud-webapp |
|---|---|
| Users / Clubs admin | `api/src/routes/adminUsers.ts`, `adminClubs.ts` · `web/src/pages/AdminUsers.tsx`, `AdminClubs.tsx` |
| Masquerade | `api/src/routes/adminMasquerade.ts` |
| Events + Drive folders | `api/src/routes/adminEvents.ts` · `web/src/pages/AdminEvents.tsx` |
| Upload links | `api/src/routes/adminLinks.ts` (`services/linkStore.ts`) · `web/src/pages/AdminLinks.tsx` |
| Email + preferences | `api/src/services/emailService.ts`, `emailPrefsStore.ts` · `routes/emailPrefs.ts`, `emailDigest.ts` · `web/src/pages/EmailPrefs.tsx` |
| Audit log | `api/src/services/auditStore.ts` · `routes/audit.ts` · `web/src/pages/AdminAudit.tsx` |
| Duplicates / soft-delete | `api/src/services/deletedFilesStore.ts` · `routes/adminDeletedFiles.ts` · `web/src/pages/DeletedFiles.tsx` |
| Reporting | `api/src/services/summaryService.ts` · `routes/summary.ts` · `web/src/pages/AdminSummary.tsx` |
| Partner REST API | `api/src/middleware/partnerAuth.ts` · `routes/partner.ts` |

## Retired, not ported (dev plan §7)

Public-index Google Sheet, `Photos_NNN`/Videos/Album Drive consolidation +
shortcuts, the upload-prep sidebar, and the Photos-Library-API sharing
workaround are **obsolete** (replaced by the Cloud Storage gallery + indexer) and
are not reimplemented.
