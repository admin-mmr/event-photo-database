/**
 * fakeObjectStore.ts — ONE in-memory implementation of the `ObjectStore`
 * interface, shared by every test that needs a bucket (AZ2).
 *
 * The sibling of `fakeDb.ts`, and there for the same reason: before this
 * existed, each test that touched storage hand-rolled its own
 * `{ bucket: () => ({ file: () => … }) }` literal shaped like whatever the
 * author assumed `@google-cloud/storage` does. That is exactly the assumption
 * the Azure port has to pin down, so it now lives in one place that the
 * contract suite holds honest.
 *
 * Semantics deliberately matched to the interface:
 *   - `remove` of a missing object is a no-op, not an error.
 *   - `head` of a missing object returns `null`, not a throw.
 *   - `md5Hex` is computed from the stored bytes for anything written through
 *     `write()`, and is whatever `seed()` says otherwise — including `''`, which
 *     is how a browser-committed Azure blob and an unhashed Drive file both
 *     look, and which callers must read as *unknown*.
 *   - `read({ start, end })` is inclusive on BOTH ends.
 *   - `list` is ordered by key, so a `limit` cut is deterministic.
 */

import { createHash } from 'node:crypto';
import type {
  CreateUploadSessionOptions,
  ObjectMetadata,
  ObjectStore,
  SignReadUrlOptions,
  StoredObject,
  UploadProtocol,
  UploadSession,
} from '../../src/lib/storage/types.js';

interface Entry {
  body: Buffer;
  /** Reported size. Usually `body.length` — see `SeedOptions.size`. */
  size: number;
  contentType: string;
  /** Overrides the body hash when set (including to `''` = unknown). */
  md5Hex: string;
  custom: Record<string, string>;
}

export interface SeedOptions {
  body?: Buffer | string;
  /**
   * Reported size, DECOUPLED from the bytes and allocating nothing.
   *
   * The recovery tests turn on how a 9 GiB video is chunked and costed, and
   * allocating 9 GiB to assert on a number would take the test runner down. Only
   * set this when the test reads metadata and not bytes.
   */
  size?: number;
  contentType?: string;
  /** Omit for "hash the body"; pass `''` for a provider that reports no hash. */
  md5Hex?: string;
  custom?: Record<string, string>;
}

function md5Of(body: Buffer): string {
  return createHash('md5').update(body).digest('hex');
}

export class FakeObjectStore implements ObjectStore {
  /** bucket → (key → entry). Exposed so tests can seed and assert directly. */
  readonly data = new Map<string, Map<string, Entry>>();

  /** Every `remove` that hit an existing object, in order. */
  readonly removed: string[] = [];
  /** Every `signReadUrl` call, so a test can assert the TTL/filename policy. */
  readonly signed: Array<{ bucket: string; key: string; opts: SignReadUrlOptions }> = [];
  /** Every `createUploadSession` call. */
  readonly sessions: Array<{ bucket: string; key: string; opts: CreateUploadSessionOptions }> = [];

  /** Which protocol minted sessions report. Flip to model the Azure adapter. */
  protocol: UploadProtocol = 'gcs-resumable';

  /** Keys whose next operation should throw, to exercise failure paths. */
  readonly failOn = new Set<string>();

  private bucket(name: string): Map<string, Entry> {
    let b = this.data.get(name);
    if (!b) {
      b = new Map<string, Entry>();
      this.data.set(name, b);
    }
    return b;
  }

  private guard(key: string): void {
    if (this.failOn.has(key)) throw new Error(`fake storage failure: ${key}`);
  }

  private meta(entry: Entry): ObjectMetadata {
    return {
      size: entry.size,
      // Both providers default an unset type; the fake must too, or a test that
      // seeds a typeless object passes here and fails against the real thing.
      contentType: entry.contentType || 'application/octet-stream',
      md5Hex: entry.md5Hex,
      custom: { ...entry.custom },
    };
  }

  async signReadUrl(bucket: string, key: string, opts: SignReadUrlOptions): Promise<string> {
    this.guard(key);
    this.signed.push({ bucket, key, opts });
    const query = opts.filename ? `&name=${encodeURIComponent(opts.filename)}` : '';
    return `https://fake.storage/${bucket}/${key}?exp=${opts.ttlMs}${query}`;
  }

  async write(bucket: string, key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    this.guard(key);
    this.bucket(bucket).set(key, {
      body: Buffer.from(body),
      size: body.length,
      contentType: opts.contentType,
      md5Hex: md5Of(body),
      custom: {},
    });
  }

  async read(bucket: string, key: string, range?: { start: number; end: number }): Promise<Buffer> {
    this.guard(key);
    const entry = this.data.get(bucket)?.get(key);
    if (!entry) throw Object.assign(new Error(`no such object: ${bucket}/${key}`), { code: 404 });
    // Inclusive end, matching the interface and both providers' semantics, and
    // clamped to the object's size the way a real range request is.
    const start = range ? range.start : 0;
    const end = Math.min(range ? range.end : entry.size - 1, entry.size - 1);
    if (end < start) return Buffer.alloc(0);
    const slice = entry.body.subarray(start, end + 1);
    if (slice.length === end - start + 1) return slice;
    // An entry seeded with a declared `size` and no bytes (see SeedOptions.size):
    // materialize zeros for just the requested window, so a caller that copies
    // the object gets the number of bytes its metadata promised. Only the range
    // actually read is allocated — a test can declare a 9 GiB video safely as
    // long as it never asks for all of it at once.
    const out = Buffer.alloc(end - start + 1);
    slice.copy(out);
    return out;
  }

  async head(bucket: string, key: string): Promise<ObjectMetadata | null> {
    this.guard(key);
    const entry = this.data.get(bucket)?.get(key);
    return entry ? this.meta(entry) : null;
  }

  async remove(bucket: string, key: string): Promise<void> {
    this.guard(key);
    if (this.data.get(bucket)?.delete(key)) this.removed.push(key);
  }

  async list(bucket: string, opts: { prefix: string; limit?: number }): Promise<StoredObject[]> {
    const entries = [...(this.data.get(bucket)?.entries() ?? [])]
      .filter(([key]) => key.startsWith(opts.prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => ({ key, metadata: this.meta(entry) }));
    return opts.limit === undefined ? entries : entries.slice(0, opts.limit);
  }

  async createUploadSession(
    bucket: string,
    key: string,
    opts: CreateUploadSessionOptions,
  ): Promise<UploadSession> {
    this.guard(key);
    this.sessions.push({ bucket, key, opts });
    const clientStampsMetadata = this.protocol === 'azure-block-blob';
    // A GCS session pins the metadata server-side, so model that by stamping an
    // empty object now: a test can then assert that the copy path sees the
    // metadata WITHOUT the client having sent any.
    if (!clientStampsMetadata) {
      this.bucket(bucket).set(key, {
        body: Buffer.alloc(0),
        size: 0,
        contentType: opts.contentType,
        md5Hex: '',
        custom: { ...opts.metadata },
      });
    }
    return {
      protocol: this.protocol,
      url: `https://fake.storage/${bucket}/${key}?upload=1`,
      clientStampsMetadata,
    };
  }

  // ── test conveniences ──────────────────────────────────────────────────────

  /** Seed one object. See `SeedOptions.size` for the bytes-vs-size distinction. */
  seed(bucket: string, key: string, opts: SeedOptions = {}): this {
    const body =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(opts.body)
          ? opts.body
          : Buffer.from(opts.body);
    this.bucket(bucket).set(key, {
      body,
      size: opts.size ?? body.length,
      contentType: opts.contentType ?? 'application/octet-stream',
      md5Hex: opts.md5Hex ?? md5Of(body),
      custom: { ...(opts.custom ?? {}) },
    });
    return this;
  }

  /** All keys in a bucket, sorted. */
  keys(bucket: string): string[] {
    return [...(this.data.get(bucket)?.keys() ?? [])].sort();
  }

  has(bucket: string, key: string): boolean {
    return this.data.get(bucket)?.has(key) ?? false;
  }

  reset(): void {
    this.data.clear();
    this.removed.length = 0;
    this.signed.length = 0;
    this.sessions.length = 0;
    this.failOn.clear();
    this.protocol = 'gcs-resumable';
  }
}

export function fakeObjectStore(): FakeObjectStore {
  return new FakeObjectStore();
}
