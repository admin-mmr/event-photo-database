/**
 * types.ts — the provider-neutral object-store interface (AZ2).
 *
 * The sibling of `lib/db/types.ts`, and written the same way: this is the
 * *measured* subset of Cloud Storage the api actually uses, not a general
 * abstraction. As of 2026-07-29 the whole storage surface across
 * `gcsService.ts`, `volunteerUploadService.ts`, `uploadRecoveryService.ts` and
 * `eventDeletionService.ts` is:
 *
 *   read      signReadUrl (V4 signed URL ↔ user-delegation SAS) · read (whole
 *             object or a byte range) · head · list(prefix, limit)
 *   write     write(buffer) · remove · createUploadSession (browser-direct)
 *
 * Deliberately absent, because nothing uses them — do not add without a call
 * site: copy/compose, ACL/IAM edits, bucket creation, resumable *server-side*
 * uploads, streaming handles. `origFile()` used to hand a `@google-cloud/storage`
 * `File` out of the service so a caller could `createReadStream()` into a ZIP;
 * that path was removed when originals moved to signed URLs (CLAUDE.md — never
 * serve photo bytes through the Hosting rewrite), and the function is gone with
 * it rather than being ported.
 *
 * Three normalizations the adapters own, because the providers genuinely differ:
 *
 *  1. **md5 is lowercase hex.** GCS reports base64 (`md5Hash`), Azure a byte
 *     array (`contentMD5`); Drive and the photo index use hex, and the upload
 *     dedup claim keys off it. Normalizing here deleted two hand-rolled
 *     base64→hex helpers that had drifted apart (`gcsMd5ToHex`, `b64ToHex`).
 *     `''` means "the provider has no hash", which callers must read as
 *     *unknown*, never as *no match* — that distinction is what keeps an
 *     unhashed staged object recoverable.
 *  2. **A delete of a missing object is a no-op.** Every one of the 8 call
 *     sites passed `ignoreNotFound: true`, so it is the only behaviour, not an
 *     option. Matches how the document store treats a delete.
 *  3. **`head` returns `null` rather than throwing.** The GCS path was
 *     `exists()` then `getMetadata()` — two round trips to learn one thing.
 */

/** Object metadata, normalized across providers. */
export interface ObjectMetadata {
  /** Size in bytes. 0 for an empty (or not-yet-committed) object. */
  size: number;
  /** Never empty — providers default an unset type to application/octet-stream. */
  contentType: string;
  /** Lowercase hex md5, or `''` when the provider reports none (= unknown). */
  md5Hex: string;
  /** User-defined metadata stamped when the object was created. */
  custom: Record<string, string>;
}

/** One object from a prefix listing. */
export interface StoredObject {
  /** Full object key (GCS object name / blob name), not relative to the prefix. */
  key: string;
  metadata: ObjectMetadata;
}

/**
 * Which wire protocol the browser must speak to the URL in an `UploadSession`.
 * The two are not interchangeable — see `web/src/lib/resumableUpload.ts`, which
 * branches on exactly this field:
 *
 *   `gcs-resumable`    POST-initiated session URI; PUT chunks with
 *                      `Content-Range`, HTTP 308 + `Range` reports the
 *                      committed offset.
 *   `azure-block-blob` blob SAS URL; `PUT ?comp=block&blockid=…` per chunk then
 *                      `PUT ?comp=blocklist` to commit; resume by listing
 *                      uncommitted blocks.
 */
export type UploadProtocol = 'gcs-resumable' | 'azure-block-blob';

export interface UploadSession {
  protocol: UploadProtocol;
  /**
   * Where the browser sends bytes. Carries its own credential (a resumable
   * session id / a SAS token) and is scoped to ONE object key, so it is safe to
   * hand to an unauthenticated volunteer and cannot be used to write anywhere
   * else in the bucket.
   */
  url: string;
  /**
   * Whether the client is responsible for stamping `metadata` onto the object
   * as it commits.
   *
   * `false` on GCS: the metadata is baked into the session server-side and the
   * browser cannot alter it. `true` on Azure: Put Block List *overwrites* the
   * blob's properties and metadata ("the blob's existing properties and
   * metadata are overwritten" — Put Block List, Remarks), so a server-side
   * pre-stamp does not survive the commit and the client must send
   * `x-ms-meta-*` itself.
   *
   * Consequence, and the reason this is surfaced rather than hidden: on Azure
   * the object's custom metadata is client-supplied. Nothing may trust it for
   * authorization. The copy path already doesn't — `enqueueStagedBatch` takes
   * eventId/clubName/tag from the api-validated link and reads only
   * `originalName` / `photographerName` off the object, both of which the
   * volunteer types anyway — and `uploadRecoveryService` already prefers the
   * object *key* over metadata for the batch id. The key is chosen by the api
   * and the SAS is scoped to it, so eventId/batchId/uploadId are never
   * client-controlled on either provider.
   */
  clientStampsMetadata: boolean;
}

export interface SignReadUrlOptions {
  /** Lifetime from now, in ms. Callers cap this at `SIGNED_URL_TTL_MINUTES`. */
  ttlMs: number;
  /**
   * Raw (unencoded) filename to save as. Set it and the signed URL carries a
   * `Content-Disposition: attachment` with an RFC-5987 `filename*`, so a direct
   * browser navigation saves under the original name. The adapter does the
   * percent-encoding — passing an already-encoded name double-encodes it.
   */
  filename?: string;
}

export interface CreateUploadSessionOptions {
  contentType: string;
  /** Stamped as GCS custom metadata / Azure `x-ms-meta-*`. */
  metadata: Record<string, string>;
  /**
   * Web origin allowed to send the bytes. GCS bakes it into the resumable
   * session; Azure enforces CORS at the account level, so it is advisory there.
   * Empty/undefined = same-origin only.
   */
  origin?: string | undefined;
  /** How long the returned URL stays usable, in ms. */
  ttlMs: number;
}

export interface ObjectStore {
  /**
   * Short-lived read URL. Bytes flow storage → browser directly, never through
   * the api (CLAUDE.md: serving originals through the Hosting rewrite bills the
   * same bytes twice).
   */
  signReadUrl(bucket: string, key: string, opts: SignReadUrlOptions): Promise<string>;

  /** Upload a whole object from memory. Used for reference selfies only. */
  write(bucket: string, key: string, body: Buffer, opts: { contentType: string }): Promise<void>;

  /**
   * Download bytes. `range` is inclusive on both ends, matching GCS's
   * `{ start, end }` and HTTP's `Range: bytes=start-end`; it is what keeps the
   * chunked staging→Drive copy of a 10 GiB video inside the api's memory limit.
   */
  read(bucket: string, key: string, range?: { start: number; end: number }): Promise<Buffer>;

  /** Metadata, or `null` if the object does not exist. */
  head(bucket: string, key: string): Promise<ObjectMetadata | null>;

  /** Delete. A missing object is a no-op, never an error. */
  remove(bucket: string, key: string): Promise<void>;

  /**
   * Objects under `prefix`, at most `limit` of them (omit for all). Ordered by
   * key on both providers, which is what makes a capped count deterministic.
   */
  list(bucket: string, opts: { prefix: string; limit?: number }): Promise<StoredObject[]>;

  /**
   * Mint a credential the browser can send bytes to directly, for ONE object
   * key. The api never proxies volunteer uploads and never hands out a broad
   * storage credential.
   */
  createUploadSession(
    bucket: string,
    key: string,
    opts: CreateUploadSessionOptions,
  ): Promise<UploadSession>;
}
