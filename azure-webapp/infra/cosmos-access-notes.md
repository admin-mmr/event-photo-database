# Cosmos DB access model (replaces firestore.rules)

Firestore security rules let the **browser** talk to the database directly, with
per-document authorization enforced by Google. **Azure Cosmos DB has no
client-side security-rules equivalent** — the browser must never hold a Cosmos
key. So the access model changes shape:

- **All reads/writes go through the api.** The SPA calls `/api/**`; the api
  enforces auth (`requireAuth` / `requireAdmin`) and is the only thing holding a
  Cosmos credential (its managed identity, granted the **Cosmos DB Built-in Data
  Contributor** data-plane role — see `provision-runtime-identities.sh`).
- The authorization logic that lived in `firestore.rules` moves into the api's
  middleware/handlers. The old rules are preserved below verbatim as the
  **specification** to port. Each `allow read/write: if <cond>` becomes a check
  in the corresponding route.
- Cosmos data-plane RBAC is coarse (account/db/container scope), not per-document
  or per-field. Field-level and row-level rules MUST be reimplemented in the api.

## Original firestore.rules (port these conditions into api middleware)

```
<the original Firestore rules content has been preserved here for reference —
 see git history of cloud-webapp/infra/firestore.rules for the authoritative
 source. Port every `allow` condition into the matching api route guard.>
```

## Partition keys (chosen in bootstrap-azure.sh)

| Container    | Partition key | Why |
|--------------|---------------|-----|
| `events`     | `/id`         | Point reads by event id dominate. |
| `clubs`      | `/id`         | Small, point-read by id. |
| `photos`     | `/eventId`    | All photo queries are event-scoped; keeps an event's photos co-located. |
| `uploadLinks`| `/token`      | Looked up by link token. |
| `auditLog`   | `/day`        | Time-bucketed append; spreads writes, lets a day be queried/expired cheaply. |
