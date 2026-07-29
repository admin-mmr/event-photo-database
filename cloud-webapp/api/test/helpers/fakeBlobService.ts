/**
 * fakeBlobService.ts — an in-memory `BlobOps`, so `BlobStore` runs against the
 * shared ObjectStore contract without an Azure account.
 *
 * The sibling of `fakeCosmos.ts`. It models the service in ITS OWN vocabulary —
 * `contentLength`, a `contentMD5` byte array, offset+count downloads, a 404 on a
 * missing blob — precisely so the normalization in `BlobStore` (md5 → hex,
 * inclusive ranges, null-for-missing) is exercised rather than assumed. A fake
 * that already spoke the interface's language would test nothing.
 *
 * What it cannot cover, and what AZ4 is for: RU/transaction cost, real SAS
 * validation, account-level CORS, and whether a browser's Put Block List
 * actually behaves as documented.
 */

import { createHash } from 'node:crypto';

import { BlobStore, type BlobOps, type RawBlobProps } from '../../src/lib/storage/blobStore.js';
import type { ObjectStoreHarness } from './objectStoreContract.js';

interface Blob {
  body: Buffer;
  contentType: string;
  /** Absent = the service holds no Content-MD5, which is the norm for a blob a
   *  browser committed (Azure stores only what the writer supplied). */
  contentMD5?: Uint8Array | undefined;
  metadata: Record<string, string>;
}

/** A 404 shaped like the SDK's `RestError`, which is what `sdkOps` keys off. */
function notFound(): Error {
  return Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
}

export class FakeBlobService implements BlobOps {
  /** container → (blob name → blob). */
  readonly containers = new Map<string, Map<string, Blob>>();

  /** Every SAS minted, so a test can assert the permissions and TTL. */
  readonly sas: Array<{
    container: string;
    key: string;
    permissions: string;
    ttlMs: number;
    contentDisposition?: string | undefined;
  }> = [];

  private container(name: string): Map<string, Blob> {
    let c = this.containers.get(name);
    if (!c) {
      c = new Map<string, Blob>();
      this.containers.set(name, c);
    }
    return c;
  }

  private blob(container: string, key: string): Blob | undefined {
    return this.containers.get(container)?.get(key);
  }

  async getProperties(container: string, key: string): Promise<RawBlobProps | null> {
    const b = this.blob(container, key);
    if (!b) return null; // sdkOps maps the service's 404 to null; so do we
    return {
      contentLength: b.body.length,
      contentType: b.contentType,
      contentMD5: b.contentMD5,
      metadata: { ...b.metadata },
    };
  }

  async download(container: string, key: string, range?: { offset: number; count: number }): Promise<Buffer> {
    const b = this.blob(container, key);
    if (!b) throw notFound();
    return range ? b.body.subarray(range.offset, range.offset + range.count) : b.body;
  }

  async upload(container: string, key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    // The SDK's `upload()` computes and stores a Content-MD5 for a
    // single-request write, unlike a browser's staged block commit.
    this.container(container).set(key, {
      body: Buffer.from(body),
      contentType: opts.contentType,
      contentMD5: new Uint8Array(createHash('md5').update(body).digest()),
      metadata: {},
    });
  }

  async deleteIfExists(container: string, key: string): Promise<void> {
    this.containers.get(container)?.delete(key);
  }

  async list(container: string, prefix: string, limit?: number): Promise<Array<{ key: string; props: RawBlobProps }>> {
    const all = [...(this.containers.get(container)?.entries() ?? [])]
      .filter(([key]) => key.startsWith(prefix))
      // Azure returns blobs in lexicographic order by name.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, b]) => ({
        key,
        props: {
          contentLength: b.body.length,
          contentType: b.contentType,
          contentMD5: b.contentMD5,
          metadata: { ...b.metadata },
        },
      }));
    return limit === undefined ? all : all.slice(0, limit);
  }

  async sasUrl(
    container: string,
    key: string,
    opts: { permissions: string; ttlMs: number; contentDisposition?: string | undefined },
  ): Promise<string> {
    this.sas.push({ container, key, ...opts });
    const rscd = opts.contentDisposition ? `&rscd=${encodeURIComponent(opts.contentDisposition)}` : '';
    return `https://acct.blob.core.windows.net/${container}/${key}?sig=fake&sp=${opts.permissions}${rscd}`;
  }

  // ── test conveniences ──────────────────────────────────────────────────────

  seed(
    container: string,
    key: string,
    opts: { body?: Buffer | string; contentType?: string; md5Hex?: string; custom?: Record<string, string> } = {},
  ): void {
    const body =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(opts.body)
          ? opts.body
          : Buffer.from(opts.body);
    // `md5Hex: ''` models a browser-committed blob: bytes present, no hash.
    const hex = opts.md5Hex ?? createHash('md5').update(body).digest('hex');
    this.container(container).set(key, {
      body,
      contentType: opts.contentType ?? 'application/octet-stream',
      contentMD5: hex === '' ? undefined : new Uint8Array(Buffer.from(hex, 'hex')),
      metadata: { ...(opts.custom ?? {}) },
    });
  }

  keys(container: string): string[] {
    return [...(this.containers.get(container)?.keys() ?? [])].sort();
  }
}

/** Adapter for the shared contract suite (see objectStoreContract.ts). */
export function blobHarness(): ObjectStoreHarness {
  const svc = new FakeBlobService();
  return {
    store: new BlobStore(svc),
    seed: (bucket, key, opts) => svc.seed(bucket, key, opts ?? {}),
    keys: (bucket) => svc.keys(bucket),
    has: (bucket, key) => svc.keys(bucket).includes(key),
  };
}
