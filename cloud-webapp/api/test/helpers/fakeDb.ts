/**
 * fakeDb.ts — ONE in-memory implementation of the `DocumentStore` interface,
 * shared by every test that needs a database (AZ2).
 *
 * Before this existed, ~40 test files each hand-rolled a Firestore-shaped
 * object literal cast through `as unknown as Firestore`. That was tolerable
 * while there was exactly one backend; it stops being tolerable during the
 * Cosmos port, because a bespoke fake encodes whatever the test author assumed
 * Firestore does — which is precisely the thing the port needs to pin down.
 *
 * This fake implements the interface honestly, so a behaviour it gets wrong is
 * a bug in ONE place, and any test written against it is automatically a test
 * of the contract both the Firestore and Cosmos adapters must satisfy.
 *
 * Semantics deliberately matched to Firestore:
 *   - `set` replaces, `set(…, { merge: true })` shallow-merges.
 *   - `create` rejects if the document exists; `update` rejects if it does not.
 *   - a query only returns documents that HAVE every `orderBy` field — this is
 *     the rule the gallery's `addedAt` fallback exists to work around, so a fake
 *     that ignores it would hide that logic entirely.
 *   - `select()` with no arguments projects to ids only.
 *   - documents are deep-cloned in and out, so a caller mutating a returned
 *     object cannot corrupt the store.
 */

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
} from '../../src/lib/db/types.js';
import type { StoreHarness } from './documentStoreContract.js';

interface Filter {
  field: string;
  value: unknown;
}

interface Order {
  field: OrderField;
  dir: Direction;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (structuredClone(v) as T);
}

/** Firestore's cross-type ordering is more elaborate; this covers the types the
 *  app actually sorts on (ISO date strings, names, numbers) plus null/absent. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  const [as, bs] = [String(a), String(b)];
  return as < bs ? -1 : as > bs ? 1 : 0;
}

class FakeDocSnapshot implements DocSnapshot {
  constructor(
    readonly id: string,
    private readonly body: DocData | undefined,
    readonly ref: DocRef,
  ) {}

  get exists(): boolean {
    return this.body !== undefined;
  }

  data(): DocData | undefined {
    return clone(this.body);
  }

  get(field: string): unknown {
    return clone(this.body?.[field]);
  }
}

class FakeQuery implements Query {
  constructor(
    protected readonly db: FakeStore,
    protected readonly name: string,
    private readonly filters: readonly Filter[] = [],
    private readonly orders: readonly Order[] = [],
    private readonly max: number | null = null,
    private readonly after: readonly unknown[] | null = null,
    private readonly projection: readonly string[] | null = null,
  ) {}

  private derive(patch: {
    filters?: readonly Filter[];
    orders?: readonly Order[];
    max?: number | null;
    after?: readonly unknown[] | null;
    projection?: readonly string[] | null;
  }): Query {
    return new FakeQuery(
      this.db,
      this.name,
      patch.filters ?? this.filters,
      patch.orders ?? this.orders,
      patch.max ?? this.max,
      patch.after ?? this.after,
      patch.projection ?? this.projection,
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

  count(): AggregateQuery {
    return {
      get: async () => {
        const rows = this.rows();
        return { data: () => ({ count: rows.length }) };
      },
    };
  }

  private sortKey(id: string, body: DocData, order: Order): unknown {
    return order.field === DOC_ID ? id : body[order.field];
  }

  private rows(): Array<{ id: string; body: DocData }> {
    const coll = this.db.data.get(this.name) ?? new Map<string, DocData>();
    let rows = [...coll.entries()].map(([id, body]) => ({ id, body }));

    for (const f of this.filters) {
      rows = rows.filter((r) => r.body[f.field] === f.value);
    }

    // Firestore drops documents missing an orderBy field.
    for (const o of this.orders) {
      const field = o.field;
      if (field !== DOC_ID) {
        rows = rows.filter((r) => r.body[field] !== undefined);
      }
    }

    if (this.orders.length > 0) {
      rows.sort((x, y) => {
        for (const o of this.orders) {
          const c = compareValues(this.sortKey(x.id, x.body, o), this.sortKey(y.id, y.body, o));
          if (c !== 0) return o.dir === 'desc' ? -c : c;
        }
        return 0;
      });
    } else {
      rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    }

    if (this.after) {
      const cursor = this.after;
      const idx = rows.findIndex((r) => {
        for (let i = 0; i < cursor.length; i += 1) {
          const o = this.orders[i];
          if (!o) return false;
          const cmp = compareValues(this.sortKey(r.id, r.body, o), cursor[i]);
          const dirCmp = o.dir === 'desc' ? -cmp : cmp;
          if (dirCmp > 0) return true;
          if (dirCmp < 0) return false;
        }
        return false; // exactly equal to the cursor → excluded (startAfter)
      });
      rows = idx === -1 ? [] : rows.slice(idx);
    }

    if (this.max !== null) rows = rows.slice(0, this.max);

    if (this.projection) {
      const fields = this.projection;
      rows = rows.map((r) => ({
        id: r.id,
        body: Object.fromEntries(
          fields.filter((f) => r.body[f] !== undefined).map((f) => [f, r.body[f]]),
        ),
      }));
    }

    return rows;
  }

  async get(): Promise<QuerySnapshot> {
    const docs = this.rows().map(
      (r) =>
        new FakeDocSnapshot(r.id, r.body, new FakeDocRef(this.db, this.name, r.id)) as QueryDocSnapshot,
    );
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeCollectionRef extends FakeQuery implements CollectionRef {
  doc(id?: string): DocRef {
    return new FakeDocRef(this.db, this.name, id ?? this.db.nextId());
  }

  async add(data: DocInput): Promise<DocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeDocRef implements DocRef {
  constructor(
    private readonly db: FakeStore,
    private readonly name: string,
    readonly id: string,
  ) {}

  private coll(): Map<string, DocData> {
    let c = this.db.data.get(this.name);
    if (!c) {
      c = new Map<string, DocData>();
      this.db.data.set(this.name, c);
    }
    return c;
  }

  private read(): DocData | undefined {
    return this.db.data.get(this.name)?.get(this.id);
  }

  async get(): Promise<DocSnapshot> {
    return new FakeDocSnapshot(this.id, this.read(), this);
  }

  async set(data: DocInput, opts?: { merge?: boolean }): Promise<void> {
    this.writeSync(data, opts);
  }

  async create(data: DocInput): Promise<void> {
    if (this.read() !== undefined) {
      throw Object.assign(new Error(`ALREADY_EXISTS: ${this.name}/${this.id}`), { code: 6 });
    }
    this.writeSync(data);
  }

  async update(data: DocInput): Promise<void> {
    if (this.read() === undefined) {
      throw Object.assign(new Error(`NOT_FOUND: ${this.name}/${this.id}`), { code: 5 });
    }
    this.writeSync(data, { merge: true });
  }

  async delete(): Promise<void> {
    this.deleteSync();
  }

  /** Used by the transaction and batch wrappers, which must not await. */
  writeSync(data: DocInput, opts?: { merge?: boolean }): void {
    const next = clone(data) as DocData;
    this.coll().set(this.id, opts?.merge ? { ...(this.read() ?? {}), ...next } : next);
  }

  deleteSync(): void {
    this.db.data.get(this.name)?.delete(this.id);
  }
}

class FakeTransaction implements Transaction {
  private wrote = false;

  constructor(private readonly onWriteAfterRead: () => void) {}

  async get(ref: DocRef): Promise<DocSnapshot> {
    if (this.wrote) this.onWriteAfterRead();
    return ref.get();
  }

  set(ref: DocRef, data: DocInput, opts?: { merge?: boolean }): void {
    this.wrote = true;
    (ref as FakeDocRef).writeSync(data, opts);
  }

  update(ref: DocRef, data: DocInput): void {
    this.wrote = true;
    (ref as FakeDocRef).writeSync(data, { merge: true });
  }
}

class FakeWriteBatch implements WriteBatch {
  private readonly ops: Array<() => void> = [];

  delete(ref: DocRef): void {
    this.ops.push(() => (ref as FakeDocRef).deleteSync());
  }

  async commit(): Promise<void> {
    for (const op of this.ops) op();
    this.ops.length = 0;
  }
}

export class FakeStore implements DocumentStore {
  /** collection name → (doc id → body). Exposed so tests can seed and assert. */
  readonly data = new Map<string, Map<string, DocData>>();

  /** How many transactions have been run — some tests assert on this. */
  transactions = 0;

  private idSeq = 0;

  nextId(): string {
    this.idSeq += 1;
    return `fake-${this.idSeq}`;
  }

  collection(name: string): CollectionRef {
    return new FakeCollectionRef(this, name);
  }

  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(
      new FakeTransaction(() => {
        throw new Error('transaction read after write — Firestore forbids this');
      }),
    );
  }

  batch(): WriteBatch {
    return new FakeWriteBatch();
  }

  // ── test conveniences ────────────────────────────────────────────────────

  /** Seed documents: `seed('photos', { p1: { eventId: 'e1' } })`. */
  seed(collection: string, docs: Record<string, DocData>): this {
    let c = this.data.get(collection);
    if (!c) {
      c = new Map<string, DocData>();
      this.data.set(collection, c);
    }
    for (const [id, body] of Object.entries(docs)) c.set(id, clone(body));
    return this;
  }

  /** Read one document body, or undefined. */
  peek(collection: string, id: string): DocData | undefined {
    return clone(this.data.get(collection)?.get(id));
  }

  /** All ids in a collection, sorted — handy for order-insensitive assertions. */
  ids(collection: string): string[] {
    return [...(this.data.get(collection)?.keys() ?? [])].sort();
  }
}

export function fakeStore(): FakeStore {
  return new FakeStore();
}

/** Adapter for the shared contract suite (see documentStoreContract.ts). */
export function fakeHarness(): StoreHarness {
  const db = new FakeStore();
  return {
    store: db,
    seed: (collection, docs) => {
      db.seed(collection, docs);
    },
    peek: (collection, id) => db.peek(collection, id),
    ids: (collection) => db.ids(collection),
    transactions: () => db.transactions,
  };
}
