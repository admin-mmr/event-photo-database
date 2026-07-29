/**
 * blobStore.ts — the Azure Blob Storage implementation of `ObjectStore` (AZ2).
 *
 * Same shape as `lib/db/cosmosDb.ts`: the store is written against a narrow
 * `BlobOps` port so the whole adapter is testable in memory (see
 * `api/test/helpers/fakeBlobService.ts`), and `sdkOps()` is the thin, untested
 * strip that talks to `@azure/storage-blob`. The SDK is behind a dynamic
 * `import()` so the GCP image never loads it.
 *
 * Auth is the api's **managed identity** (Storage Blob Data Contributor for the
 * data plane, Storage Blob Delegator to mint user-delegation SAS), matching the
 * keyless posture on GCP. `AZURE_STORAGE_CONNECTION_STRING` exists only for
 * Azurite, which has no Entra identity.
 *
 * Buckets → containers 1:1 by name. The three bucket names
 * (`mmr-data-pipeline-derivatives` / `-uploads` / `-uploads-staging`) are
 * already valid container names (lowercase alphanumerics + single dashes,
 * 3–63 chars), so nothing is rewritten; AZ3's provisioner just has to create
 * containers under exactly those names.
 *
 * ── Three places Azure genuinely differs from GCS ─────────────────────────
 *
 * 1. **md5 can be missing.** GCS computes `md5Hash` for every object it stores.
 *    Azure stores only the `Content-MD5` the *writer* supplied, and a browser
 *    committing a block blob does not supply one — so `md5Hex` is `''` for
 *    volunteer uploads. The interface says `''` means *unknown*, and both
 *    readers already handle it: `enqueueStagedBatch` falls back to the
 *    name+size dedup key (the same fallback it uses for a file Drive did not
 *    hash) and `strandedObjects` treats an unhashed object as still owed a
 *    copy. That is fail-safe in the direction that matters — an extra Drive
 *    copy is recoverable by the duplicate tool, a skipped one loses a photo —
 *    but it does mean Azure leans on the weaker dedup key. **Verify in AZ4.**
 * 2. **Put Block List overwrites metadata.** "When you call Put Block List to
 *    update an existing blob, the blob's existing properties and metadata are
 *    overwritten." So the api cannot pre-stamp metadata onto the blob and have
 *    it survive the browser's commit; the client sends `x-ms-meta-*` itself and
 *    `UploadSession.clientStampsMetadata` is `true` here. See that field's doc
 *    for why nothing trusts the result for authorization.
 * 3. **Deleting a missing blob is an error** (404 `BlobNotFound`), where GCS
 *    takes `ignoreNotFound`. `deleteIfExists` restores the no-op.
 */

import { attachmentDisposition } from './disposition.js';
import type {
  CreateUploadSessionOptions,
  ObjectMetadata,
  ObjectStore,
  SignReadUrlOptions,
  StoredObject,
  UploadSession,
} from './types.js';

/** Blob properties as the SDK reports them, before normalization. */
export interface RawBlobProps {
  contentLength?: number | undefined;
  contentType?: string | undefined;
  /** Azure hands md5 back as raw bytes, not base64 or hex. */
  contentMD5?: Uint8Array | undefined;
  metadata?: Record<string, string> | undefined;
}

/**
 * The narrow port onto Azure Blob Storage. Every method is expressed in
 * Azure's own vocabulary — normalization happens in `BlobStore`, so the fake
 * and the SDK strip stay honest about what the service actually returns.
 */
export interface BlobOps {
  getProperties(container: string, key: string): Promise<RawBlobProps | null>;
  download(container: string, key: string, range?: { offset: number; count: number }): Promise<Buffer>;
  upload(container: string, key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  deleteIfExists(container: string, key: string): Promise<void>;
  /** Blobs under `prefix`, ordered by name (the service guarantees this). */
  list(container: string, prefix: string, limit?: number): Promise<Array<{ key: string; props: RawBlobProps }>>;
  /**
   * A user-delegation SAS URL for one blob.
   *
   * `permissions` is an Azure permission string: `r` to read, `cw` to create +
   * write (Put Block / Put Block List), `rcw` for an upload session that also
   * needs to *list its own uncommitted blocks* to resume.
   */
  sasUrl(
    container: string,
    key: string,
    opts: { permissions: string; ttlMs: number; contentDisposition?: string | undefined },
  ): Promise<string>;
}

/**
 * Azure md5 bytes → the lowercase hex the photo index and Drive use. Anything
 * that isn't exactly 16 bytes is reported as `''` (unknown), matching the GCS
 * adapter — a short "hash" that matches nothing is worse than an absent one.
 */
function md5ToHex(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.length !== 16) return '';
  return Buffer.from(bytes).toString('hex').toLowerCase();
}

function normalize(props: RawBlobProps): ObjectMetadata {
  return {
    size: Number(props.contentLength ?? 0) || 0,
    contentType: props.contentType || 'application/octet-stream',
    md5Hex: md5ToHex(props.contentMD5),
    custom: { ...(props.metadata ?? {}) },
  };
}

export class BlobStore implements ObjectStore {
  constructor(private readonly ops: BlobOps) {}

  async signReadUrl(bucket: string, key: string, opts: SignReadUrlOptions): Promise<string> {
    const contentDisposition = attachmentDisposition(opts.filename);
    return this.ops.sasUrl(bucket, key, {
      permissions: 'r',
      ttlMs: opts.ttlMs,
      ...(contentDisposition ? { contentDisposition } : {}),
    });
  }

  async write(bucket: string, key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    await this.ops.upload(bucket, key, body, opts);
  }

  async read(bucket: string, key: string, range?: { start: number; end: number }): Promise<Buffer> {
    // `{ start, end }` is inclusive on both ends (HTTP Range semantics, which is
    // what the GCS client takes); Azure wants an offset + a length.
    if (!range) return this.ops.download(bucket, key);
    return this.ops.download(bucket, key, {
      offset: range.start,
      count: range.end - range.start + 1,
    });
  }

  async head(bucket: string, key: string): Promise<ObjectMetadata | null> {
    const props = await this.ops.getProperties(bucket, key);
    return props === null ? null : normalize(props);
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.ops.deleteIfExists(bucket, key);
  }

  async list(bucket: string, opts: { prefix: string; limit?: number }): Promise<StoredObject[]> {
    const blobs = await this.ops.list(bucket, opts.prefix, opts.limit);
    return blobs.map((b) => ({ key: b.key, metadata: normalize(b.props) }));
  }

  async createUploadSession(
    bucket: string,
    key: string,
    opts: CreateUploadSessionOptions,
  ): Promise<UploadSession> {
    // `r` as well as `cw`: resuming an interrupted upload means asking the
    // service which blocks are already staged (`?comp=blocklist&
    // blocklisttype=uncommitted`), which is a read. Without it a dropped
    // connection would restart the whole file — the exact failure the resumable
    // path exists to avoid on a volunteer's phone.
    const url = await this.ops.sasUrl(bucket, key, { permissions: 'rcw', ttlMs: opts.ttlMs });
    // `origin` is deliberately unused: Azure CORS is account-level config
    // (AZ3's provisioner), not a per-session property as it is on GCS.
    return { protocol: 'azure-block-blob', url, clientStampsMetadata: true };
  }
}

// ── the real SDK implementation of the port ──────────────────────────────────

/** Minimal shape of the `@azure/storage-blob` clients this adapter uses — keeps
 *  the module importable (and testable) without the SDK loaded. */
interface BlobServiceLike {
  accountName?: string | undefined;
  getUserDelegationKey(startsOn: Date, expiresOn: Date): Promise<unknown>;
  getContainerClient(container: string): {
    getBlockBlobClient(key: string): {
      url: string;
      getProperties(): Promise<RawBlobProps>;
      downloadToBuffer(offset?: number, count?: number): Promise<Buffer>;
      upload(body: Buffer, length: number, opts: unknown): Promise<unknown>;
      deleteIfExists(): Promise<unknown>;
    };
    listBlobsFlat(opts: unknown): AsyncIterable<{ name: string; properties: RawBlobProps; metadata?: Record<string, string> }>;
  };
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Signing bits pulled from the SDK, injected so `sdkOps` stays unit-testable. */
export interface SasSigner {
  /** `generateBlobSASQueryParameters(...).toString()` — the query string only. */
  sign(args: {
    containerName: string;
    blobName: string;
    permissions: string;
    startsOn: Date;
    expiresOn: Date;
    contentDisposition?: string | undefined;
  }): Promise<string>;
}

export function sdkOps(service: BlobServiceLike, signer: SasSigner): BlobOps {
  const blob = (container: string, key: string) =>
    service.getContainerClient(container).getBlockBlobClient(key);

  return {
    async getProperties(container, key) {
      try {
        return await blob(container, key).getProperties();
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },

    async download(container, key, range) {
      return range
        ? blob(container, key).downloadToBuffer(range.offset, range.count)
        : blob(container, key).downloadToBuffer();
    },

    async upload(container, key, body, opts) {
      await blob(container, key).upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: opts.contentType },
      });
    },

    async deleteIfExists(container, key) {
      await blob(container, key).deleteIfExists();
    },

    async list(container, prefix, limit) {
      const out: Array<{ key: string; props: RawBlobProps }> = [];
      const iter = service.getContainerClient(container).listBlobsFlat({ prefix, includeMetadata: true });
      for await (const item of iter) {
        // `metadata` sits beside `properties` on a list item, unlike
        // getProperties() which nests everything together.
        out.push({ key: item.name, props: { ...item.properties, metadata: item.metadata } });
        if (limit !== undefined && out.length >= limit) break;
      }
      return out;
    },

    async sasUrl(container, key, opts) {
      const startsOn = new Date(Date.now() - 60_000); // 1 min of clock skew
      const expiresOn = new Date(Date.now() + opts.ttlMs);
      const query = await signer.sign({
        containerName: container,
        blobName: key,
        permissions: opts.permissions,
        startsOn,
        expiresOn,
        contentDisposition: opts.contentDisposition,
      });
      return `${blob(container, key).url}?${query}`;
    },
  };
}

/**
 * Build the Blob-backed store.
 *
 * A user-delegation key is an Entra-signed credential valid for up to 7 days;
 * we hold one and refresh it a minute before it lapses, because minting one is a
 * service round trip and the gallery signs a URL per thumbnail. Refreshing
 * early rather than on failure keeps a page load from ever paying for it.
 */
export async function createBlobStore(opts: {
  accountUrl: string;
  /** Azurite / local dev only. Deployed environments use managed identity. */
  connectionString?: string | undefined;
  /** How long a delegation key is requested for. */
  delegationKeyTtlMs?: number;
}): Promise<ObjectStore> {
  const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } =
    await import('@azure/storage-blob');

  let service: BlobServiceLike;
  let sharedKey: InstanceType<typeof StorageSharedKeyCredential> | null = null;
  if (opts.connectionString) {
    const client = BlobServiceClient.fromConnectionString(opts.connectionString);
    service = client as unknown as BlobServiceLike;
    // Azurite has no Entra identity, so there is no user-delegation key to get;
    // fall back to signing with the well-known emulator account key.
    const account = /AccountName=([^;]+)/.exec(opts.connectionString)?.[1] ?? '';
    const key = /AccountKey=([^;]+)/.exec(opts.connectionString)?.[1] ?? '';
    if (account && key) sharedKey = new StorageSharedKeyCredential(account, key);
  } else {
    const { DefaultAzureCredential } = await import('@azure/identity');
    service = new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential()) as unknown as BlobServiceLike;
  }

  const keyTtlMs = opts.delegationKeyTtlMs ?? 6 * 24 * 60 * 60 * 1000; // 6 of the 7 allowed days
  let cached: { key: unknown; expiresAtMs: number } | null = null;
  const delegationKey = async (): Promise<unknown> => {
    const now = Date.now();
    if (cached && cached.expiresAtMs - 60_000 > now) return cached.key;
    const expiresOn = new Date(now + keyTtlMs);
    const key = await service.getUserDelegationKey(new Date(now - 60_000), expiresOn);
    cached = { key, expiresAtMs: expiresOn.getTime() };
    return key;
  };

  const accountName = service.accountName || new URL(opts.accountUrl).hostname.split('.')[0] || '';

  const signer: SasSigner = {
    async sign(args) {
      const options = {
        containerName: args.containerName,
        blobName: args.blobName,
        permissions: BlobSASPermissions.parse(args.permissions),
        startsOn: args.startsOn,
        expiresOn: args.expiresOn,
        ...(args.contentDisposition ? { contentDisposition: args.contentDisposition } : {}),
      };
      if (sharedKey) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return generateBlobSASQueryParameters(options as any, sharedKey).toString();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return generateBlobSASQueryParameters(options as any, (await delegationKey()) as any, accountName).toString();
    },
  };

  return new BlobStore(sdkOps(service, signer));
}
