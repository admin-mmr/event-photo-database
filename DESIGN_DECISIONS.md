# Event Photo Database — Design Decisions

*Captured from brainstorm session on 2026-04-22. Represents a major requirements change away from the prior registered-user model toward a link-based, self-serve upload system.*

---

## 1. Purpose & Goals

Self-serve system for club volunteers to upload event photos with minimal registration friction. Club and super admins manage content; the public views photo albums via Google Photos.

**Primary design principles:**
- **Simplicity** over completeness.
- **Self-serve** over controlled onboarding.
- **Additive uploads** with a strong audit trail (users cannot delete; all mutations logged).
- **Public viewing, private filesystem.** Photos are public via Google Photos; the underlying Drive hierarchy is admin-only.

---

## 2. Architecture

Three-tier pipeline, one source of truth:

- **Google Apps Script (GAS)** — **control plane.** Upload orchestration, auth, audit logging, admin UI, link generation and revocation, notification scheduling, sync coordination.
- **Google Drive** — **storage / source of truth.** All photos organized as an event → club → photos folder hierarchy. Not publicly accessible.
- **Google Photos** — **public viewer.** Receives synced copies from Drive. Albums are public read-only; only the sync job mutates them. Leverages Photos' built-in gallery UX (thumbnails, lazy loading, HEIC transcoding for browser display, etc.).

**Double storage (Drive + Photos) is accepted.** Google Photos and Google Drive no longer share underlying file storage (they share quota only, since their 2019 decoupling). Extra copies can be pruned later if quota becomes tight.

**Division of labor rationale:** GAS is poor at serving high-volume image galleries. Letting Google Photos handle the viewer avoids building a custom gallery and dodges GAS performance concerns around displaying 10K+ photos per album.

---

## 3. Identity & Access

### Authentication

- **Google OAuth** for all users. No separate registration.
- On first login the app captures first name, last name, and email from the Google profile.
- No per-user password, invitation flow, or email verification managed by the app.

### Roles

**Super admin** (member of the "admin club" — a role container, *not* a content destination)
- Full permissions across all clubs and events.
- Can create and delete clubs.
- Creates the initial club admins by whitelisting email addresses.
- Can delete any content system-wide (soft delete; recoverable).
- Can masquerade as a club admin for support; masquerade actions are themselves logged.
- When a super admin uploads, they must select a real event **and** a real club. Uploads are attributed to the super admin's identity with the role flag recorded. The admin club is never a content destination.
- Bootstrap: the first super admin is already seeded. Document this procedure for future deployments.

**Club admin**
- Full permissions within their own club's subtree.
- Can create events (any admin can).
- Can add other admins to their own club; can remove peer admins from their own club.
- Can delete, rename, and reorganize files in their own club's subtree.
- Can view the audit trail for their club (uploads and deletes).
- Can view the file hierarchy of other clubs (read-only); cannot modify other clubs' content.
- Can revoke and rotate upload links for their own (event, club) pairs.
- **A person cannot be a club admin for more than one club.** If multi-club duties are needed, promote the person to super admin.

**Volunteer / uploader**
- No registration. Access is acquired by opening a per-(event, club) upload link.
- Google OAuth required to identify them. First name, last name, email captured.
- Can upload files only to the specific event + club scope encoded in the link. Cannot access or modify anything else.
- Cannot delete files. Uploads are additive only.

### The admin club

- A role container, not a content destination. Existence of this entity signals super admin membership.
- Super admin uploads must target a real club, not the admin club. *(This is a change from current behavior and needs fixing in the implementation.)*

---

## 4. Per-(Event, Club) Upload Links

- **One unique link per (event, club) pair.** Permanent — **no expiration**.
- **Generated on demand** by the club admin (or the super admin on behalf of a club).
- On generation the link is both (a) shown on-screen for copy/paste and (b) emailed to the admin. Admin can freely forward the link.
- **Bearer-token semantics.** Anyone who holds the link plus any Google account can upload within the scope that link encodes.
- **Revocable and rotatable.** Club admin can rotate the secret portion of the URL for their own (event, club) pair; super admin can rotate any. The (event, club) pair stays stable; the token changes. Old link returns a "link revoked; contact your club admin" page.
- **Audit trail records the link version used for each upload** — so forensic investigation remains possible after a rotation.

### Upload page UX

- Clicking the link first shows a confirmation screen ("You're uploading photos for [Event Name] — [Club Name]") *before* Google login, to catch cross-link confusion.
- Google OAuth flow → upload interface.
- **Consent line** displayed on the upload page: short statement that the uploader has permission to share these photos and they're appropriate for the event audience.
- After upload: on-screen receipt, noting that photos may take a short time to appear in the public album while sync runs.

---

## 5. Events & Clubs

### Events

- **System-wide shared entities.** Any admin can create an event.
- **All admins receive notifications** when a new event is created (subject to each recipient's preferences).
- **Any club can join any event.** No up-front participation declaration — a club joins implicitly by generating an upload link for that event.
- **"Everything is an event."** Training runs, holiday parties, board meetings — all modeled as events. There is no separate general-content bucket per club.

### Clubs

- Managed via a Clubs configuration screen. **Super admin only** creates clubs.
- **Club removal keeps content intact.** Removed clubs are archived rather than deleted. Super admin handles any post-removal content questions case-by-case.

---

## 6. File System & Albums

### File system (Drive)

- Hierarchy: event → club → photos (folder structure).
- Not publicly accessible.
- **Admins can view the full hierarchy across all clubs** (read access is global within the admin role).
- **Modification is scoped:** club admin modifies only their own club's subtree; super admin modifies anything.

### Albums (Google Photos)

- **Public read-only** views, synced from Drive.
- **Only the sync job modifies albums.** Manual edits from the Photos UI won't round-trip back to Drive and aren't supported.
- **Two albums per event per club:**
  - Per-club album: `[Event Name] — [Club Name]`
  - All-in event album: `[Event Name] — All Clubs` (aggregates every club's photos for that event)

### Public album discovery

- A dynamically generated public index page lists all albums.
- **Gated by Google login** (any Google account admitted) to deter drive-by bots.
- If per-album visibility ever becomes necessary, add a `listed / unlisted / restricted` flag. Not built initially.

---

## 7. File Handling

- **Keep HEIC format and original size** in Drive. Google Photos transcodes HEIC to JPEG/WebP for browser viewing automatically via the sync.
- **Strip EXIF data on upload** (default on) for privacy — GPS coordinates from phone cameras can dox locations, especially critical if minors are in the photos. Original metadata may be preserved in the audit record if photographer attribution or timestamps matter.
- **No upload caps.**
- **Allowed file types:** to finalize — probably images (JPG, PNG, HEIC) plus video. Decide during implementation.

---

## 8. Deletion & Retention

- **Soft delete with a 30-day window** before purge. Deleted files move to a trash state.
- **Who can restore:** club admin for their own subtree; super admin globally.
- **Audit logs every delete.** Actor, timestamp, file, club, optional free-text reason.
- **Sync mirrors deletes** to Google Photos so public viewers cannot see content admins think they've removed. Restorations also mirror.
- **Subject-of-photo takedown requests** (someone pictured wants removal, not the uploader) are handled case-by-case by the club admin via soft delete. Policy documented in admin docs and terms of use.
- **Account deletion / GDPR-style requests:** keep the photos, anonymize displayed attribution to "removed user," retain the underlying audit record for forensic integrity.

---

## 9. Audit Trail

- **Every mutation is logged.** Uploads, deletes, restores, link rotations, admin role changes, masquerade actions.
- **Fields captured per event:**
  - Actor (Google email + display name)
  - Timestamp
  - Action type
  - Target file or entity
  - Event ID, club ID
  - Link ID used (for uploads — critical so post-rotation forensics still work)
  - IP address
  - Optional free-text reason (especially for deletes)
- **Retention:** super admin archives the audit log manually each year.

---

## 10. Notifications

- **Per-account preference settings.** Each admin chooses via a profile/settings page.
- **New-event notifications** sent to all admins (super + club), subject to each recipient's preferences.
- **Daily upload digest.** Club admins receive a once-per-day summary of new uploads to their club (not real-time).
- **Email delivery failure handling:** do **not** fail silently. Surface a suggested remediation to the admin — e.g., "Email delivery failed; reschedule delivery to tomorrow and retry." Retry with backoff; escalate visibly on repeated failures.

---

## 11. Sync (Drive → Photos)

- **Triggered at end of upload batch**, not on a fixed time schedule. When the volunteer finishes uploading, the handler enqueues a sync job for that batch.
- **Queue-based pattern:**
  - Upload completes → sync job written to queue (Sheet or PropertiesService).
  - A short-interval GAS trigger drains the queue, executes sync tasks, records results.
  - The user's upload response is decoupled from sync status.
- **Sync handles creates, deletes, and restores** — not just adds.
- **Retry on failure.** Photos API quotas and transient errors are expected. The queue tracks attempts; after N failures, surface a "this batch failed to sync" state to the admin. No silent drops.
- **Library API constraint:** GAS can only manage photos and albums it created itself. Manual edits from the Photos UI won't be visible to the app. Document this for admins.

---

## 12. Upload Path Architecture (GAS-specific)

- **GAS has a 6-minute execution limit** and is not good at handling large multi-file uploads through `google.script.run`.
- **Client-side uploads go directly to Drive.** The front-end JavaScript uses a short-lived token provided by GAS to upload bytes directly to the Drive API. **The bytes never pass through GAS.**
- **GAS only records metadata** in the audit log after the client-side upload completes.
- This design is essential from day one; retrofitting later is painful.

---

## 13. Implementation Phasing

Build in vertical slices, testable end-to-end before advancing to the next.

1. **Data model + auth** — events, clubs, users, link tokens, audit table. Lock schema before writing UI.
2. **Upload flow** — link page → Google login → direct-to-Drive upload (client-side) → audit entry. Smallest slice that proves the architecture end to end.
3. **Admin UI** — user and club management, link generation and revocation, audit viewer, notification preferences page.
4. **Drive → Photos sync** — queue, create/delete/restore propagation, retry logic.
5. **Public album index** — Google-login-gated landing page listing events and albums.
6. **Notifications** — event creation alerts, daily upload digest, email-failure reschedule logic.
7. **Polish** — consent screen, EXIF stripping, soft-delete purge job, super admin upload UI fix (require real club selection), migration from any existing data.

### Migration note

The current system has the admin club functioning as a content destination and uses a registered-user model. Phase 1 must include a one-time migration script to:
- Reattribute any historical admin-club uploads to a real club.
- Convert existing registered users into the new role model (super admin, club admin, or neither — volunteers don't persist as pre-registered users).

---

## 14. Open Implementation Questions

Still to resolve during implementation:

- **Event metadata fields.** Required vs optional: name, date, location, description.
- **Allowed file types.** Images only, or also video/PDF? Storage and preview implications.
- **Consent statement wording.** Exact copy shown on the upload page.
- **Drive storage quota.** Know the Workspace plan's allocation; monitor usage (Drive + Photos both count).
- **Admin UI for soft-deleted content.** Trash list view, restore button, auto-purge countdown display.
- **Mobile upload UX.** Test direct-to-Drive flow with large batches from iOS and Android.
- **Drive permissions model.** How GAS reads Drive content across clubs (service account vs. script-project owner).
- **Super admin masquerade UI.** How the role-switch is triggered and visually indicated.
- **Admin file-system view for HEIC files.** Browsers won't preview them inline; admins may need a "download to view" affordance.

---

## 15. Model Selection for Implementation Sessions

- **Sonnet 4.6** for the bulk of implementation. Strong on GAS, Apps Script idioms, JavaScript, refactoring, and typical debugging. Much better cost/performance than Opus.
- **Opus 4.6** selectively:
  - Thorny design decisions where extra reasoning depth matters.
  - Refactors with broad blast radius where consistency is critical.
  - Debugging sessions where Sonnet has already missed the same bug twice.
- **Rule of thumb:** start every session in Sonnet; escalate to Opus mid-session only when needed. Expect a 10–20% / 80–90% Opus/Sonnet split for a project this size with output quality close to all-Opus.

---

## 16. Quick Decisions Log

| Topic | Decision |
|---|---|
| Registration | Removed — Google OAuth only, link-based access |
| Link expiration | None — permanent per (event, club) |
| Link revocation | Yes — club admin for own, super admin for any |
| Admin tiers | Two — super admin, club admin |
| Multi-club admin | Not allowed; promote to super admin |
| File delete by volunteers | Not allowed — additive uploads only |
| Delete model | Soft delete, 30-day trash window |
| EXIF stripping | On by default |
| HEIC | Keep original; Photos handles display |
| Upload caps | None |
| Albums | Public RO in Google Photos; per-club + all-in-event |
| Public discovery | Google-login-gated index page |
| File system access | All admins view all; modify own only |
| Event creation | Any admin; all admins notified |
| Event participation | Any club can join any event implicitly |
| "Everything is an event" | Yes — no separate general-content bucket |
| Club removal | Archive, preserve content |
| Sync cadence | End-of-batch, queue-based |
| Sync deletes | Yes — mirror to Photos |
| Upload notifications | Daily digest to club admins |
| Email failures | Surface remediation (reschedule/retry) |
| Audit retention | Manual yearly archive by super admin |
| GDPR / account deletion | Keep photos; anonymize display attribution; retain audit |
| Upload bytes path | Client → Drive directly; never through GAS |
