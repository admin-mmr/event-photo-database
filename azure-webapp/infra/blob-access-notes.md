# Blob Storage access model (replaces storage.rules)

Cloud Storage rules (`storage.rules`) governed browser access to GCS objects.
Azure Blob Storage has **no client-side rules engine**. Access is granted two
ways, both server-mediated:

1. **Reads (serving photos/derivatives):** the api returns short-lived
   **user-delegation SAS URLs** (signed with the api's managed identity, no
   account key). This is the Azure analog of GCS signed URLs. The browser
   fetches the blob directly; optionally front it with **Azure CDN / Front Door**
   for the Cloud CDN role.
2. **Writes (volunteer resumable uploads):** the api mints a write-scoped SAS to
   the `staging` container; the browser PUTs directly. A 7-day lifecycle rule
   purges staged blobs (`provision-volunteer-uploads.sh`).

Containers are created **private** (`--allow-blob-public-access false`). Nothing
is publicly readable; every fetch is SAS-gated. Runtime identities get
`Storage Blob Data Contributor` (api, indexer) or `Storage Blob Data Reader`
(matcher) at the account scope — see `provision-runtime-identities.sh`.

Port any per-path conditions from the original `storage.rules` (see git history
of `cloud-webapp/infra/storage.rules`) into the api's SAS-minting logic — e.g.
"only admins may write to `events/{id}/...`" becomes an `requireAdmin` check
before the api issues a write SAS for that prefix.
