/**
 * gcsStore.ts — the Cloud Storage implementation of `ObjectStore` (AZ2).
 *
 * Pure delegation, so the live GCP deployment behaves exactly as it did before
 * the seam existed. This is the ONLY file in the api allowed to import
 * `@google-cloud/storage`; check with
 *
 *   grep -rn '@google-cloud/storage' api/src
 *
 * (`lib/gaxiosNativeFetch.ts` mentions it in prose only — it patches gaxios,
 * which the storage client happens to sit on top of.)
 *
 * IAM prerequisite for signing (one-time, in the demo checklist): V4 signing
 * with ADC on Cloud Run goes through the IAM signBlob API, so api-runtime@
 * needs roles/iam.serviceAccountTokenCreator **on itself**:
 *
 *   gcloud iam service-accounts add-iam-policy-binding \
 *     api-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
 *     --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
 *     --role="roles/iam.serviceAccountTokenCreator"
 */

import { Storage, type CreateResumableUploadOptions } from '@google-cloud/storage';
import { attachmentDisposition } from './disposition.js';
import type {
  CreateUploadSessionOptions,
  ObjectMetadata,
  ObjectStore,
  SignReadUrlOptions,
  StoredObject,
  UploadSession,
} from './types.js';

/**
 * GCS reports md5 base64; the photo index and Drive use lowercase hex.
 *
 * A value that does not decode to exactly 16 bytes comes back as `''` — the
 * interface's "unknown". Base64 decoding is lenient enough to turn a truncated
 * or non-md5 string into short hex, and a 24-character "hash" silently failing
 * to match anything is far harder to diagnose than an absent one.
 */
function md5ToHex(md5Base64: string | null | undefined): string {
  if (!md5Base64) return '';
  try {
    const hex = Buffer.from(md5Base64, 'base64').toString('hex').toLowerCase();
    return /^[0-9a-f]{32}$/.test(hex) ? hex : '';
  } catch {
    return '';
  }
}

/** The subset of the GCS `File`/`Bucket` metadata blob this adapter reads. */
interface RawMetadata {
  size?: string | number | undefined;
  contentType?: string | undefined;
  md5Hash?: string | null | undefined;
  metadata?: Record<string, string | number | boolean | undefined> | undefined;
}

function normalize(raw: RawMetadata | undefined): ObjectMetadata {
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw?.metadata ?? {})) {
    if (v !== undefined) custom[k] = String(v);
  }
  return {
    size: Number(raw?.size ?? 0) || 0,
    contentType: raw?.contentType || 'application/octet-stream',
    md5Hex: md5ToHex(raw?.md5Hash),
    custom,
  };
}

/** A 404 from the storage client, which this adapter treats as "absent". */
function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 404;
}

export class GcsStore implements ObjectStore {
  constructor(private readonly storage: Storage) {}

  private file(bucket: string, key: string) {
    return this.storage.bucket(bucket).file(key);
  }

  async signReadUrl(bucket: string, key: string, opts: SignReadUrlOptions): Promise<string> {
    const disposition = attachmentDisposition(opts.filename);
    const [url] = await this.file(bucket, key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + opts.ttlMs,
      ...(disposition ? { responseDisposition: disposition } : {}),
    });
    return url;
  }

  async write(bucket: string, key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    await this.file(bucket, key).save(body, { contentType: opts.contentType, resumable: false });
  }

  async read(bucket: string, key: string, range?: { start: number; end: number }): Promise<Buffer> {
    const [buf] = await this.file(bucket, key).download(range ? { start: range.start, end: range.end } : {});
    return buf;
  }

  async head(bucket: string, key: string): Promise<ObjectMetadata | null> {
    try {
      const [raw] = await this.file(bucket, key).getMetadata();
      return normalize(raw as RawMetadata);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.file(bucket, key).delete({ ignoreNotFound: true });
  }

  async list(bucket: string, opts: { prefix: string; limit?: number }): Promise<StoredObject[]> {
    const [files] = await this.storage.bucket(bucket).getFiles({
      prefix: opts.prefix,
      ...(opts.limit === undefined ? {} : { maxResults: opts.limit }),
    });
    return files.map((f) => ({ key: String(f.name), metadata: normalize(f.metadata as RawMetadata) }));
  }

  async createUploadSession(
    bucket: string,
    key: string,
    opts: CreateUploadSessionOptions,
  ): Promise<UploadSession> {
    // Only set `origin` when configured — under exactOptionalPropertyTypes an
    // explicit `undefined` is rejected by the storage client's options type.
    const options: CreateResumableUploadOptions = {
      metadata: {
        contentType: opts.contentType || 'application/octet-stream',
        metadata: opts.metadata,
      },
    };
    if (opts.origin) options.origin = opts.origin;

    const [sessionUri] = await this.file(bucket, key).createResumableUpload(options);
    // The metadata above is pinned into the session server-side: the browser
    // PUTs bytes only and cannot alter it.
    return { protocol: 'gcs-resumable', url: sessionUri, clientStampsMetadata: false };
  }
}

/**
 * Build the GCS-backed store. Credentials are ADC (keyless on Cloud Run); the
 * project id is only passed when configured, matching the previous behaviour of
 * every `new Storage(...)` call site this replaced.
 */
export function createGcsStore(projectId?: string | undefined): ObjectStore {
  return new GcsStore(new Storage(projectId ? { projectId } : {}));
}
