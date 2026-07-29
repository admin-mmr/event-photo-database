# Cosmos DB access model (replaces firestore.rules)

Firestore security rules let the **browser** talk to the database directly, with
per-document authorization enforced by Google. **Azure Cosmos DB has no
client-side security-rules equivalent** — the browser must never hold a Cosmos
key. So the access model changes shape:

- **All reads/writes go through the api.** The SPA calls `/api/**`; the api
  enforces auth (`requireAuth` / `rbac.ts`) and is the only thing holding a
  Cosmos credential (its managed identity, granted the **Cosmos DB Built-in Data
  Contributor** data-plane role — see `provision-runtime-identities.sh`).
- Cosmos data-plane RBAC is coarse (account/db/container scope), not per-document
  or per-field. Field-level and row-level rules MUST be reimplemented in the api.

## Original firestore.rules — verbatim (AZ2, checked 2026-07-29)

```
rules_version = '2';

// Firestore is reached ONLY by the Cloud Run api running under a service
// account that has roles/datastore.user. Client browsers do not talk to
// Firestore directly, so we deny all client traffic here. If we ever decide
// to do client-direct Firestore, replace this with per-collection rules.

service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**There are no per-path conditions to port. The spec is one condition: `if
false`.** Earlier drafts of this file said "each `allow read/write: if <cond>`
becomes a check in the corresponding route" and deferred the conditions to git
history; that was wrong in a way worth stating plainly, because it implied a
translation job that does not exist and hid the one that does.

Two consequences:

1. **The rules were never the authorization model — the api middleware always
   was.** Nothing is lost by Cosmos having no rules engine, because no rule was
   ever doing work. See the guard inventory below for what actually enforces
   access.
2. **On GCP a middleware mistake is still backstopped by `if false`; on Azure it
   is not.** That backstop is what disappears in the migration, so the guards are
   now pinned by `api/test/routeGuards.test.ts`, which walks the live Express
   route table and fails if any route lacks an authenticator, if any
   `/api/admin/**` route lacks a role check, or if the web bundle ever imports a
   client-side database SDK. Keep that test green — on Azure it is the only thing
   between a mis-guarded route and the data.

## The real access model: api guard inventory (80 routes, 2026-07-29)

Generated from the route table, not by hand. `routeGuards.test.ts` asserts the
invariants; this table is the human-readable form.

| Guard | Routes | What it proves about the caller |
|---|---|---|
| `requireAuth` (member only) | 18 | A verified Firebase ID token. Read access to events/photos/search + their own Find Me data. |
| `requireAuth` + `attachRole` + `requireAnyAdmin` | 34 | super_admin **or** club_admin, resolved from the Users sheet. |
| `requireAuth` + `attachRole` + `requireSuperAdmin` | 10 | super_admin only — org-wide or cross-club actions. |
| `allowCronOrAdmin` | 10 | `X-Sync-Token` (Cloud Scheduler / a shell script) **or** an admin session. |
| `allowCronOrSuperAdmin` | 1 | Same, but the human half must be super_admin (`POST /admin/events/:id/delete` — an event holds every club's photos). |
| `requirePartner` | 2 | A partner API key (never in the Sheet — env/Key Vault only). |
| gated inside the handler | 4 | An upload-link token or `X-Sync-Token` — see below. |
| unauthenticated | 1 | `GET /health`, and nothing else. |

(18 + 34 + 10 + 10 + 1 + 2 + 4 + 1 = 80.)

`requireClubScope` additionally narrows a club_admin to their own club where a
route targets one; a super_admin passes for any club. **A club_admin's scan or
mutation must be filtered to their own subtree BEFORE grouping/acting**, and a
machine caller (no Firebase user) must run unscoped rather than falling through
to `effectiveClubScope`'s `__none__` sentinel, which silently matches nothing.

Five routes additionally carry reCAPTCHA Enterprise (`requireRecaptcha`), and the
abuse-prone ones carry per-user or per-token rate limits. Both fail **open** by
design — a Firestore/Cosmos hiccup in the limiter must never block a real user —
so neither is an authorization control and neither substitutes for a guard.

### The five routes with no authenticating middleware

A reader grepping for guards will misread these as unprotected. Four of them
authenticate against a credential the middleware layer does not know about; the
fifth is public by design.

| Route | Credential checked in the handler |
|---|---|
| `GET /api/health` | none — public by design; returns no org data. |
| `POST /api/volunteer/upload/session` | upload-link token in the body → `validateUploadLink()`; plus a per-token rate limit and reCAPTCHA. |
| `POST /api/volunteer/upload/complete` | upload-link token in the body → `validateUploadLink()`. |
| `GET /api/volunteer/upload/status/:batchId` | upload-link token in the query → `validateUploadLink()`, **and** the batch must belong to that link's event. |
| `POST /api/internal/process-batch` | `X-Sync-Token` → `validCronToken()`. The Cloud Tasks worker; never called by a browser. |

The volunteer flow is unauthenticated by product design — a volunteer has no
account — so **the link token IS the credential**. That makes link revocation an
authorization control, which is why deleting an event revokes its links FIRST
(`eventDeletionService`), and why the token is rotatable
(`POST /admin/links/:linkId/rotate`).

## Partition keys (chosen in bootstrap-azure.sh)

| Container    | Partition key | Why |
|--------------|---------------|-----|
| `events`     | `/id`         | Point reads by event id dominate. |
| `clubs`      | `/id`         | Small, point-read by id. |
| `photos`     | `/eventId`    | All photo queries are event-scoped; keeps an event's photos co-located. |
| `uploadLinks`| `/token`      | Looked up by link token. |
| `auditLog`   | `/day`        | Time-bucketed append; spreads writes, lets a day be queried/expired cheaply. |
