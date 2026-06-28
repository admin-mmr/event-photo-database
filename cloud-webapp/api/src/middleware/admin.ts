/**
 * DEPRECATED — the static ADMIN_EMAILS gate that used to live here has been
 * removed. Admin authorization is now fully dynamic via RBAC: routes use
 * `requireAuth → attachRole → requireAnyAdmin` (middleware/rbac.ts), which
 * resolves super_admin / club_admin from the Users sheet, with ADMIN_EMAILS
 * kept only as a bootstrap super_admin allowlist inside attachRole.
 *
 * Do NOT reintroduce a static `requireAdmin` here — add admins to the Users
 * sheet instead (no redeploy needed). This file is intentionally left empty
 * (it can't be deleted from the current environment); it has no exports and no
 * importers.
 */

export {};
