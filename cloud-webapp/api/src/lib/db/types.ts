/**
 * types.ts — the provider-neutral document-store interface (AZ2).
 *
 * This is deliberately the *measured* subset of Firestore this app actually
 * uses, not a general abstraction. As of 2026-07-28 the api's whole database
 * surface is:
 *
 *   queries   where(field, '==', v) · orderBy(field | DOC_ID, asc|desc) ·
 *             limit(n) · startAfter(...values) · select(...fields) · count()
 *   writes    set(data, {merge}) · create(data) · update(data) · delete() ·
 *             add(data)
 *   tx        get(docRef) · set(docRef, data, {merge}) · update(docRef, data)
 *             — all 12 transaction reads are single-doc; none reads a query,
 *               which is what makes an ETag if-match port to Cosmos tractable
 *   batch     delete(docRef) · commit()
 *
 * Keeping the shape Firestore-like is intentional: the Firestore adapter is
 * then pure delegation (zero behaviour change for the live GCP deployment),
 * and the porting risk lands entirely in the Cosmos adapter where it can be
 * tested against the same shared fake.
 *
 * Deliberately absent, because nothing uses them — do not add without a
 * call site: collectionGroup, onSnapshot, FieldValue.increment/arrayUnion,
 * array-contains / in / range filters, in-transaction queries, sub-collections.
 */

/**
 * A document body as read back.
 *
 * Values are `any`, deliberately: this mirrors Firestore's own `DocumentData`
 * (`{ [field: string]: any }`). Narrowing to `unknown` would be more honest
 * about what a database read guarantees, but it would also force a cast at
 * every one of the ~90 read sites — churn that buys no safety, since none of
 * them validate the shape today either. Tightening this is a follow-up worth
 * doing per-collection with a schema, not a side effect of the Azure port.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DocData = Record<string, any>;

/**
 * A document body being written.
 *
 * `object` rather than `DocData` because TypeScript only grants implicit index
 * signatures to type aliases, not interfaces — so the many call sites that
 * write a typed record (`AuditRecord`, `EmailPrefs`, …) would not satisfy
 * `Record<string, …>`. Firestore accepts them via `WithFieldValue<T>`; this is
 * the same permissiveness stated plainly.
 */
export type DocInput = object;

/** The only comparison the app uses. Widen only alongside a real call site. */
export type WhereOp = '==';

export type Direction = 'asc' | 'desc';

/**
 * Order by the document id rather than a field — Firestore's
 * `FieldPath.documentId()`, Cosmos's `c.id`. A sentinel rather than the literal
 * `'__name__'` so a document that happens to carry that field can't collide
 * with it.
 */
export const DOC_ID = Symbol.for('findme.db.documentId');
export type OrderField = string | typeof DOC_ID;

export interface DocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  readonly ref: DocRef;
  data(): DocData | undefined;
  /** Single-field accessor — Firestore's `snap.get(field)`. Not a dotted path:
   *  no call site uses one, and Cosmos would need a different traversal. */
  get(field: string): unknown;
}

/** A snapshot that came from a query, so it is known to exist. */
export interface QueryDocSnapshot extends DocSnapshot {
  data(): DocData;
}

export interface QuerySnapshot {
  readonly docs: readonly QueryDocSnapshot[];
  readonly size: number;
  readonly empty: boolean;
}

export interface CountSnapshot {
  data(): { count: number };
}

export interface AggregateQuery {
  get(): Promise<CountSnapshot>;
}

export interface DocRef {
  readonly id: string;
  get(): Promise<DocSnapshot>;
  /** `{ merge: true }` leaves unlisted fields untouched. */
  set(data: DocInput, opts?: { merge?: boolean }): Promise<void>;
  /** Fails if the document already exists — the basis of the upload md5 claim. */
  create(data: DocInput): Promise<void>;
  /** Fails if the document does NOT exist (unlike `set`). */
  update(data: DocInput): Promise<void>;
  delete(): Promise<void>;
}

export interface Query {
  where(field: string, op: WhereOp, value: unknown): Query;
  orderBy(field: OrderField, dir?: Direction): Query;
  limit(n: number): Query;
  /**
   * Keyset pagination: resume strictly after the document whose `orderBy`
   * values are `values`, positionally matching the `orderBy` calls.
   *
   * Value-based rather than an opaque provider token on purpose. Cosmos
   * continuation tokens are single-use and forward-only, whereas the gallery's
   * base64url `{field, id}` cursor is already value-based, stable across
   * deploys, and page-size independent. The Cosmos adapter renders this as a
   * keyset predicate — `field > @v OR (field = @v AND c.id > @id)` — which the
   * same composite index serves.
   */
  startAfter(...values: unknown[]): Query;
  /** Projection. No arguments = ids only (existence/deletion sweeps). */
  select(...fields: string[]): Query;
  count(): AggregateQuery;
  get(): Promise<QuerySnapshot>;
}

export interface CollectionRef extends Query {
  /** Omit `id` to get a reference with a generated id. */
  doc(id?: string): DocRef;
  add(data: DocInput): Promise<DocRef>;
}

/**
 * Single-document transaction. Every read must precede every write (Firestore's
 * rule), which also keeps it expressible as a read-then-if-match write on
 * Cosmos.
 */
export interface Transaction {
  get(ref: DocRef): Promise<DocSnapshot>;
  set(ref: DocRef, data: DocInput, opts?: { merge?: boolean }): void;
  update(ref: DocRef, data: DocInput): void;
}

export interface WriteBatch {
  delete(ref: DocRef): void;
  commit(): Promise<void>;
}

export interface DocumentStore {
  collection(name: string): CollectionRef;
  /**
   * Runs `fn` inside a transaction, retrying it on contention. `fn` must be
   * idempotent — it can run more than once.
   */
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /**
   * Atomic only within one partition on Cosmos, and the one caller that spans
   * collections (`eventDeletionService`) is already documented idempotent, so
   * treat a batch as "grouped writes", not "all-or-nothing".
   */
  batch(): WriteBatch;
}
