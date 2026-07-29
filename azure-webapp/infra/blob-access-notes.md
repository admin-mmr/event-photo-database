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

## What the code now does (AZ2, landed 2026-07-29)

Both halves above are implemented in `cloud-webapp/api/src/lib/storage/`:
`types.ts` is the provider-neutral `ObjectStore`, `gcsStore.ts` the GCS impl and
`blobStore.ts` the Blob impl, selected by `CLOUD_PROVIDER` in `lib/storage.ts`.

- **Containers are the bucket names, verbatim.** `DERIVATIVES_BUCKET`,
  `UPLOADS_BUCKET` and `VOLUNTEER_STAGING_BUCKET` are used as container names
  with no rewriting (they are already valid: lowercase alphanumerics + single
  dashes). `bootstrap-azure.sh` must create containers under exactly those names.
- **Two roles, not one.** The api needs `Storage Blob Data Contributor` for the
  data plane **and** `Storage Blob Delegator` to mint user-delegation SAS. The
  delegation key is cached for 6 of its 7 allowed days and refreshed a minute
  early, because the gallery signs a URL per thumbnail.
- **CORS is account-level here.** On GCS the allowed origin is baked into each
  resumable session (`VOLUNTEER_UPLOAD_ORIGIN`); on Azure it is service
  configuration, so the provisioner owns it. A missing rule looks like every
  browser PUT failing with no `Access-Control-Allow-Origin` — the same symptom
  the GCS side had when the staging bucket and the CORS script disagreed.
  The rule must expose the headers the block-blob path reads, not just allow the
  methods.
- **The upload wire protocol differs, and the client is told which to speak.**
  `POST /api/volunteer/upload/session` returns `protocol` (`gcs-resumable` |
  `azure-block-blob`); `web/src/lib/blockBlobUpload.ts` implements the Azure one
  (named blocks + an explicit `comp=blocklist` commit, resumed by listing
  uncommitted blocks).
- **Metadata on staged blobs is client-supplied on Azure.** Put Block List
  overwrites the blob's properties and metadata, so the api cannot pin it; the
  browser sends `x-ms-meta-*` at commit time. Nothing server-side trusts those
  fields for authorization — the copy path takes event/club/tag from the
  api-validated link and the api-chosen object key. Keep it that way.
- **Azure stores no md5 for a browser-committed blob** (only a `Content-MD5` the
  writer supplied). The adapter reports `md5Hex: ''` = *unknown*, and the upload
  dedup falls back to its name+size key. Fail-safe, but weaker than on GCS —
  **verify against a real account in AZ4.**
