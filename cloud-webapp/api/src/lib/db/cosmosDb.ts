/**
 * cosmosDb.ts — the Cosmos DB implementation of the DocumentStore interface (AZ2).
 *
 * Must satisfy the same contract tests as the Firestore adapter
 * (`test/fakeDb.test.ts`); that suite, not the SDK docs, is the definition of
 * correct here.
 *
 * ## Shape
 *
 * Firestore collection → Cosmos container of the same name. All SQL translation
 * lives in `cosmosSql.ts` (pure, exhaustively tested). All SDK contact lives
 * behind the `CosmosOps` port at the bottom of this file, so the semantics above
 * it can be tested without an account or an emulator.
 *
 * ## The four places Cosmos differs, and what we do about it
 *
 * 1. **Point reads need the partition key, and often we only have the id.**
 *    `collection('photos').doc(photoId).get()` has no `eventId`, but `photos` is
 *    partitioned by `/eventId`. So a point read uses the partition key only when
 *    the key path is `/id`; otherwise it falls back to a cross-partition
 *    `WHERE c.id = @id` query. That costs more RU than a point read but is
 *    always CORRECT — which means a wrong entry in `PARTITION_KEYS` costs money,
 *    never data. Writes don't have this problem: Cosmos extracts the partition
 *    key from the document body itself.
 *
 * 2. **`id` is a real, reserved document property.** Firestore keeps the doc id
 *    outside the body; Cosmos puts it inside. `data()` therefore strips `id`
 *    along with Cosmos's `_rid`/`_self`/`_etag`/`_ts`/`_attachments`, so a body
 *    round-trips byte-identical to Firestore's. Verified safe: no collection
 *    stores its own `id` field — the queue services build it as
 *    `{ id: snap.id, ...snap.data() }`.
 *
 * 3. **Cosmos forbids `/ \ ? #` in an id**; Firestore allows all but `/`. Ids are
 *    percent-encoded on the way in and decoded on the way out, so `snap.id`
 *    always returns what the caller passed. No current id contains those
 *    characters — this exists so a future one cannot produce a baffling HTTP 400.
 *
 * 4. **There are no multi-document transactions across partitions.** Every one of
 *    the app's 12 transaction reads is single-doc (see `types.ts`), so
 *    `runTransaction` is implemented as read-with-ETag → write with `if-match`,
 *    retried on 412. A transaction that tries to write two different documents
 *    throws rather than silently losing atomicity.
 */

import {
  buildByIdQuery,
  buildQuery,
  ID_ALIAS,
  type QuerySpec,
  type SqlFilter,
  type SqlOrder,
} from './cosmosSql.js';
import {
  DOC_ID,
  type AggregateQuery,
  type CollectionRef,
  type Direction,
  type DocData,
  type DocInput,
  type DocRef,
  type DocSnapshot,
  type DocumentStore,
  type OrderField,
  type Query,
  type QueryDocSnapshot,
  type QuerySnapshot,
  type Transaction,
  type WhereOp,
  type WriteBatch,
} from './types.js';

/**
 * Container → partition-key path. Extends the five in
 * `azure-webapp/infra/cosmos-access-notes.md` to every collection the api
 * touches, choosing the field that queries actually filter on.
 *
 * Anything absent defaults to `/id`. Because point reads fall back to a
 * cross-partition id query (see header note 1), a suboptimal choice here is an
 * RU cost, not a correctness bug — but changing a partition key after data
 * exists requires recreating the container and re-copying, so review this before
 * AZ4 rather than after.
 */
export const PARTITION_KEYS: Readonly<Record<string, string>> = {
  // Event-scoped: every query filters by the event, so co-locate per event.
  photos: '/eventId',
  specialFolders: '/eventId',
  // User-scoped: the erasure path (`userData.ts`) queries all three by uid.
  consents: '/uid',
  match_runs: '/uid',
  match_feedback: '/uid',
  find_me_uploads: '/uid',
  // Looked up by link token.
  uploadLinks: '/token',
  // Time-bucketed append; spreads writes and lets a day be expired cheaply.
  auditLog: '/day',
  // Point-read dominated — id is the natural key.
  events: '/id',
  clubs: '/id',
  users: '/id',
  emailPrefs: '/id',
  rate_limits: '/id',
  upload_dedup: '/id',
  upload_batches: '/id',
  admin_audit: '/id',
  folderRebuildBatches: '/id',
  duplicateRemovalBatches: '/id',
};

const DEFAULT_PARTITION_KEY = '/id';

export function partitionKeyPath(collection: string): string {
  return PARTITION_KEYS[collection] ?? DEFAULT_PARTITION_KEY;
}

/** Cosmos system properties that are not part of the document body. */
const SYSTEM_FIELDS = new Set(['id', '_rid', '_self', '_etag', '_ts', '_attachments']);

function stripSystemFields(row: DocData): DocData {
  const out: DocData = {};
  for (const [k, v] of Object.entries(row)) {
    if (!SYSTEM_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/** Characters Cosmos rejects in an `id`. Firestore permits all but `/`. */
const FORBIDDEN_ID_CHARS = /[/\\?#]/g;
const ENCODED_ID_CHARS = /%(2F|5C|3F|23)/gi;

export function encodeDocId(id: string): string {
  return id.replace(FORBIDDEN_ID_CHARS, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function decodeDocId(id: string): string {
  return id.replace(ENCODED_ID_CHARS, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
}

// ── the SDK port ─────────────────────────────────────────────────────────────

export interface CosmosReadResult {
  /** Raw row including system fields, or undefined when the item is absent. */
  row?: DocData | undefined;
  etag?: string | undefined;
}

/**
 * The entire Cosmos surface this adapter uses. Implemented for real by
 * `sdkOps()`; stubbed in tests. Errors must be normalized: `notFound` and
 * `conflict`/`preconditionFailed` are control flow here, not failures.
 */
export interface CosmosOps {
  readById(collection: string, id: string, partitionKey?: string): Promise<CosmosReadResult>;
  query(collection: string, sql: { query: string; parameters: Array<{ name: string; value: unknown }> }): Promise<DocData[]>;
  upsert(collection: string, body: DocData, ifMatch?: string): Promise<void>;
  create(collection: string, body: DocData): Promise<void>;
  remove(collection: string, id: string, partitionKey?: string): Promise<void>;
}

export class ConflictError extends Error {
  readonly conflict = true;
}
export class PreconditionFailedError extends Error {
  readonly preconditionFailed = true;
}

function isRetryableWriteError(err: unknown): boolean {
  return err instanceof PreconditionFailedError || err instanceof ConflictError;
}

// ── snapshots ────────────────────────────────────────────────────────────────

class CosmosDocSnapshot implements DocSnapshot {
  constructor(
    readonly id: string,
    private readonly body: DocData | undefined,
    readonly ref: DocRef,
    /** ETag captured at read time, for if-match writes. */
    readonly etag: string | undefined,
  ) {}

  get exists(): boolean {
    return this.body !== undefined;
  }

  data(): DocData | undefined {
    // Deep, not shallow: Firestore materializes a fresh object graph on every
    // `data()`, so callers may mutate what they get back. A shallow spread would
    // share nested arrays/objects with the cached row and let a caller corrupt
    // it — a difference that only shows up with nested fields.
    return this.body === undefined ? undefined : structuredClone(this.body);
  }

  get(field: string): unknown {
    const v = this.body?.[field];
    return v === undefined ? undefined : structuredClone(v);
  }
}

// ── queries ──────────────────────────────────────────────────────────────────

class CosmosQuery implements Query {
  constructor(
    protected readonly ops: CosmosOps,
    protected readonly name: string,
    private readonly filters: readonly SqlFilter[] = [],
    private readonly orders: readonly SqlOrder[] = [],
    private readonly max: number | null = null,
    private readonly after: readonly unknown[] | null = null,
    private readonly projection: readonly string[] | null = null,
  ) {}

  private derive(patch: Partial<{
    filters: readonly SqlFilter[];
    orders: readonly SqlOrder[];
    max: number | null;
    after: readonly unknown[] | null;
    projection: readonly string[] | null;
  }>): Query {
    return new CosmosQuery(
      this.ops,
      this.name,
      patch.filters ?? this.filters,
      patch.orders ?? this.orders,
      patch.max !== undefined ? patch.max : this.max,
      patch.after !== undefined ? patch.after : this.after,
      patch.projection !== undefined ? patch.projection : this.projection,
    );
  }

  where(field: string, _op: WhereOp, value: unknown): Query {
    return this.derive({ filters: [...this.filters, { field, value }] });
  }

  orderBy(field: OrderField, dir: Direction = 'asc'): Query {
    return this.derive({ orders: [...this.orders, { field, dir }] });
  }

  limit(n: number): Query {
    return this.derive({ max: n });
  }

  startAfter(...values: unknown[]): Query {
    return this.derive({ after: values });
  }

  select(...fields: string[]): Query {
    return this.derive({ projection: fields });
  }

  private spec(count = false): QuerySpec {
    return {
      filters: this.filters,
      orders: this.orders,
      limit: this.max,
      startAfter: this.after,
      projection: this.projection,
      count,
    };
  }

  count(): AggregateQuery {
    return {
      get: async () => {
        const rows = await this.ops.query(this.name, buildQuery(this.spec(true)));
        // SELECT VALUE COUNT(1) yields a bare number.
        const n = Number(rows[0] ?? 0);
        return { data: () => ({ count: Number.isFinite(n) ? n : 0 }) };
      },
    };
  }

  async get(): Promise<QuerySnapshot> {
    const rows = await this.ops.query(this.name, buildQuery(this.spec()));
    const docs = rows.map((row) => {
      // A projected row carries its id under ID_ALIAS; a `SELECT *` row has `id`.
      const rawId = String((row[ID_ALIAS] ?? row.id) as string);
      const body =
        this.projection === null
          ? stripSystemFields(row)
          : Object.fromEntries(Object.entries(row).filter(([k]) => k !== ID_ALIAS));
      const id = decodeDocId(rawId);
      return new CosmosDocSnapshot(
        id,
        body,
        new CosmosDocRef(this.ops, this.name, id),
        row._etag as string | undefined,
      ) as QueryDocSnapshot;
    });
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class CosmosCollectionRef extends CosmosQuery implements CollectionRef {
  doc(id?: string): DocRef {
    return new CosmosDocRef(this.ops, this.name, id ?? crypto.randomUUID());
  }

  async add(data: DocInput): Promise<DocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

// ── document references ──────────────────────────────────────────────────────

class CosmosDocRef implements DocRef {
  constructor(
    private readonly ops: CosmosOps,
    /** Container name. Readable so the transaction commit can address it. */
    readonly collection: string,
    readonly id: string,
  ) {}

  private get name(): string {
    return this.collection;
  }

  /** The partition key value, when derivable from the id alone. */
  private pkFromId(): string | undefined {
    return partitionKeyPath(this.name) === '/id' ? encodeDocId(this.id) : undefined;
  }

  /** Raw read + etag. Falls back to a cross-partition id query (header note 1). */
  async read(): Promise<CosmosReadResult> {
    const pk = this.pkFromId();
    if (pk !== undefined) {
      return this.ops.readById(this.name, encodeDocId(this.id), pk);
    }
    const rows = await this.ops.query(this.name, buildByIdQuery(encodeDocId(this.id)));
    const row = rows[0];
    return row ? { row, etag: row._etag as string | undefined } : {};
  }

  async get(): Promise<DocSnapshot> {
    const { row, etag } = await this.read();
    return new CosmosDocSnapshot(
      this.id,
      row === undefined ? undefined : stripSystemFields(row),
      this,
      etag,
    );
  }

  /** The body as Cosmos stores it: caller fields plus the reserved `id`. */
  private toRow(body: DocData): DocData {
    return { ...body, id: encodeDocId(this.id) };
  }

  async set(data: DocInput, opts?: { merge?: boolean }): Promise<void> {
    if (!opts?.merge) {
      await this.ops.upsert(this.name, this.toRow({ ...(data as DocData) }));
      return;
    }
    // Merge is read-modify-write; if-match makes a concurrent write retry rather
    // than silently lose one side of the merge.
    await this.withRetry(async () => {
      const { row, etag } = await this.read();
      const base = row === undefined ? {} : stripSystemFields(row);
      await this.ops.upsert(this.name, this.toRow({ ...base, ...(data as DocData) }), etag);
    });
  }

  async create(data: DocInput): Promise<void> {
    // The 409 IS the signal — see the upload md5 claim in uploadDedupService.
    await this.ops.create(this.name, this.toRow({ ...(data as DocData) }));
  }

  async update(data: DocInput): Promise<void> {
    await this.withRetry(async () => {
      const { row, etag } = await this.read();
      if (row === undefined) {
        throw Object.assign(new Error(`NOT_FOUND: ${this.name}/${this.id}`), { code: 5 });
      }
      await this.ops.upsert(
        this.name,
        this.toRow({ ...stripSystemFields(row), ...(data as DocData) }),
        etag,
      );
    });
  }

  async delete(): Promise<void> {
    // Firestore deleting a missing doc is a no-op; `remove` swallows 404.
    const pk = this.pkFromId();
    if (pk !== undefined) {
      await this.ops.remove(this.name, encodeDocId(this.id), pk);
      return;
    }
    // Partition key isn't derivable, so learn it from the stored document.
    const { row } = await this.read();
    if (row === undefined) return;
    const path = partitionKeyPath(this.name).replace(/^\//, '');
    await this.ops.remove(this.name, encodeDocId(this.id), row[path] as string | undefined);
  }

  private async withRetry(fn: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fn();
        return;
      } catch (err) {
        if (attempt >= MAX_WRITE_RETRIES || !isRetryableWriteError(err)) throw err;
      }
    }
  }
}

const MAX_WRITE_RETRIES = 5;

// ── transactions ─────────────────────────────────────────────────────────────

interface BufferedWrite {
  ref: CosmosDocRef;
  data: DocData;
  merge: boolean;
}

/**
 * Records reads (with their ETags) and buffers writes, so the commit can use
 * if-match. `set`/`update` stay synchronous, matching the interface.
 */
class CosmosTransaction implements Transaction {
  readonly reads = new Map<string, { etag?: string | undefined; existed: boolean; body: DocData }>();
  readonly writes: BufferedWrite[] = [];

  constructor(private readonly onReadAfterWrite: () => void) {}

  private key(ref: DocRef): string {
    return (ref as CosmosDocRef).id;
  }

  async get(ref: DocRef): Promise<DocSnapshot> {
    if (this.writes.length > 0) this.onReadAfterWrite();
    const cref = ref as CosmosDocRef;
    const { row, etag } = await cref.read();
    this.reads.set(this.key(ref), {
      etag,
      existed: row !== undefined,
      body: row === undefined ? {} : stripSystemFields(row),
    });
    return new CosmosDocSnapshot(
      cref.id,
      row === undefined ? undefined : stripSystemFields(row),
      ref,
      etag,
    );
  }

  set(ref: DocRef, data: DocInput, opts?: { merge?: boolean }): void {
    this.writes.push({
      ref: ref as CosmosDocRef,
      data: { ...(data as DocData) },
      merge: opts?.merge === true,
    });
  }

  update(ref: DocRef, data: DocInput): void {
    // Firestore's tx.update merges the given fields.
    this.writes.push({ ref: ref as CosmosDocRef, data: { ...(data as DocData) }, merge: true });
  }
}

// ── the store ────────────────────────────────────────────────────────────────

export class CosmosStore implements DocumentStore {
  constructor(private readonly ops: CosmosOps) {}

  collection(name: string): CollectionRef {
    return new CosmosCollectionRef(this.ops, name);
  }

  /**
   * Single-document transaction as optimistic concurrency: run `fn`, then commit
   * its one buffered write with `if-match` on the ETag read inside `fn`. A 412
   * (someone else wrote first) or 409 (someone else created first) re-runs `fn`
   * from scratch — which is why the interface requires `fn` to be idempotent.
   */
  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const tx = new CosmosTransaction(() => {
        throw new Error('transaction read after write — Firestore forbids this');
      });
      const result = await fn(tx);

      const targets = new Set(tx.writes.map((w) => `${w.ref.id}`));
      if (targets.size > 1) {
        throw new Error(
          `cosmos: a transaction wrote ${targets.size} documents; only single-document ` +
            'transactions are supported (Cosmos has no cross-partition atomicity)',
        );
      }
      if (tx.writes.length === 0) return result;

      try {
        await this.commit(tx);
        return result;
      } catch (err) {
        if (attempt >= MAX_WRITE_RETRIES || !isRetryableWriteError(err)) throw err;
        // fall through and re-run fn against fresh state
      }
    }
  }

  private async commit(tx: CosmosTransaction): Promise<void> {
    // Collapse the writes for the single target in order.
    const first = tx.writes[0];
    if (!first) return;
    const ref = first.ref;
    const priorRead = tx.reads.get(ref.id);

    let body: DocData = {};
    if (first.merge && priorRead) body = { ...priorRead.body };
    for (const w of tx.writes) {
      body = w.merge ? { ...body, ...w.data } : { ...w.data };
    }

    const row = { ...body, id: encodeDocId(ref.id) };

    if (priorRead && !priorRead.existed) {
      // Read said "absent" — a plain upsert would clobber a doc created since.
      // The 409 becomes a retry, which is what preserves claim semantics.
      await this.ops.create(ref.collection, row);
      return;
    }
    await this.ops.upsert(ref.collection, row, priorRead?.etag);
  }

  /**
   * Cosmos has no cross-partition atomic batch, and the one caller that spans
   * collections (`eventDeletionService`) is documented idempotent, so this is
   * "grouped writes applied on commit", exactly as `types.ts` states.
   */
  batch(): WriteBatch {
    const ops: Array<() => Promise<void>> = [];
    return {
      delete: (ref: DocRef) => {
        ops.push(() => ref.delete());
      },
      commit: async () => {
        for (const op of ops) await op();
        ops.length = 0;
      },
    };
  }
}

export { DOC_ID };

// ── the real SDK implementation of the port ──────────────────────────────────

/** Minimal shape of the `@azure/cosmos` Database we use — keeps this module
 *  importable (and testable) without the SDK loaded. */
interface CosmosDatabaseLike {
  container(id: string): {
    item(
      id: string,
      partitionKey?: unknown,
    ): {
      read(): Promise<{ resource?: unknown }>;
      delete(): Promise<unknown>;
    };
    items: {
      query(
        spec: { query: string; parameters: Array<{ name: string; value: unknown }> },
        options?: unknown,
      ): { fetchAll(): Promise<{ resources: unknown[] }> };
      create(body: unknown): Promise<unknown>;
      upsert(body: unknown, options?: unknown): Promise<unknown>;
    };
  };
}

function statusOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'number') return code;
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Wrap the SDK, normalizing the three status codes this adapter treats as
 * control flow: 404 (absent), 409 (already exists), 412 (ETag mismatch).
 * Everything else propagates unchanged.
 */
export function sdkOps(database: CosmosDatabaseLike): CosmosOps {
  return {
    async readById(collection, id, partitionKey) {
      try {
        const res = await database.container(collection).item(id, partitionKey).read();
        const row = res.resource as DocData | undefined;
        return row === undefined ? {} : { row, etag: row._etag as string | undefined };
      } catch (err) {
        if (statusOf(err) === 404) return {};
        throw err;
      }
    },

    async query(collection, sql) {
      const res = await database
        .container(collection)
        .items.query(sql, { maxItemCount: -1 })
        .fetchAll();
      return res.resources as DocData[];
    },

    async upsert(collection, body, ifMatch) {
      try {
        await database
          .container(collection)
          .items.upsert(body, ifMatch ? { accessCondition: { type: 'IfMatch', condition: ifMatch } } : undefined);
      } catch (err) {
        if (statusOf(err) === 412) throw new PreconditionFailedError('etag mismatch');
        throw err;
      }
    },

    async create(collection, body) {
      try {
        await database.container(collection).items.create(body);
      } catch (err) {
        if (statusOf(err) === 409) {
          throw new ConflictError(`ALREADY_EXISTS: ${collection}/${String(body.id)}`);
        }
        throw err;
      }
    },

    async remove(collection, id, partitionKey) {
      try {
        await database.container(collection).item(id, partitionKey).delete();
      } catch (err) {
        // Firestore treats deleting a missing document as a no-op.
        if (statusOf(err) === 404) return;
        throw err;
      }
    },
  };
}

/**
 * Build the Cosmos-backed store from env.
 *
 * Auth is the api's **managed identity** holding the Cosmos DB Built-in Data
 * Contributor role (see `provision-runtime-identities.sh`) — no account key in
 * config, matching the keyless posture the GCP side already has. The SDK is
 * imported dynamically so the GCP deployment never loads it.
 */
export async function createCosmosStore(opts: {
  endpoint: string;
  databaseId: string;
  /** Account key. Omit in deployed environments — managed identity is preferred. */
  key?: string | undefined;
}): Promise<DocumentStore> {
  const { CosmosClient } = await import('@azure/cosmos');

  let client;
  if (opts.key) {
    // Local dev / the Cosmos emulator, which has no Entra identity.
    client = new CosmosClient({ endpoint: opts.endpoint, key: opts.key });
  } else {
    const { DefaultAzureCredential } = await import('@azure/identity');
    client = new CosmosClient({
      endpoint: opts.endpoint,
      aadCredentials: new DefaultAzureCredential(),
    });
  }

  return new CosmosStore(sdkOps(client.database(opts.databaseId) as unknown as CosmosDatabaseLike));
}
