/**
 * firestoreDb.ts — the Firestore implementation of the DocumentStore interface.
 *
 * Pure delegation: every method forwards to the same `@google-cloud/firestore`
 * call the code made before AZ2, so the live GCP deployment sees no behaviour
 * change. The only translation is `DOC_ID` → `FieldPath.documentId()`.
 *
 * This is the ONLY file in the api that may import from
 * `@google-cloud/firestore`.
 */

import {
  FieldPath,
  Firestore,
  type CollectionReference,
  type DocumentReference,
  type DocumentData as FsDocumentData,
  type DocumentSnapshot,
  type Query as FsQuery,
  type QuerySnapshot as FsQuerySnapshot,
  type Transaction as FsTransaction,
  type UpdateData,
  type WriteBatch as FsWriteBatch,
} from '@google-cloud/firestore';

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

function orderPath(field: OrderField): string | FieldPath {
  return field === DOC_ID ? FieldPath.documentId() : field;
}

class FsDocRef implements DocRef {
  constructor(readonly native: DocumentReference) {}

  get id(): string {
    return this.native.id;
  }

  async get(): Promise<DocSnapshot> {
    return new FsDocSnapshot(await this.native.get());
  }

  async set(data: DocInput, opts?: { merge?: boolean }): Promise<void> {
    if (opts?.merge) await this.native.set(data, { merge: true });
    else await this.native.set(data);
  }

  async create(data: DocInput): Promise<void> {
    await this.native.create(data);
  }

  async update(data: DocInput): Promise<void> {
    await this.native.update(data as UpdateData<FsDocumentData>);
  }

  async delete(): Promise<void> {
    await this.native.delete();
  }
}

class FsDocSnapshot implements DocSnapshot {
  constructor(private readonly snap: DocumentSnapshot) {}

  get id(): string {
    return this.snap.id;
  }

  get exists(): boolean {
    return this.snap.exists;
  }

  get ref(): DocRef {
    return new FsDocRef(this.snap.ref);
  }

  data(): DocData | undefined {
    return this.snap.data();
  }

  get(field: string): unknown {
    return this.snap.get(field);
  }
}

class FsQuerySnapshotWrapper implements QuerySnapshot {
  readonly docs: readonly QueryDocSnapshot[];

  constructor(snap: FsQuerySnapshot) {
    this.docs = snap.docs.map((d) => new FsDocSnapshot(d) as QueryDocSnapshot);
  }

  get size(): number {
    return this.docs.length;
  }

  get empty(): boolean {
    return this.docs.length === 0;
  }
}

class FsQueryWrapper implements Query {
  constructor(protected readonly q: FsQuery) {}

  where(field: string, _op: WhereOp, value: unknown): Query {
    return new FsQueryWrapper(this.q.where(field, '==', value));
  }

  orderBy(field: OrderField, dir: Direction = 'asc'): Query {
    return new FsQueryWrapper(this.q.orderBy(orderPath(field), dir));
  }

  limit(n: number): Query {
    return new FsQueryWrapper(this.q.limit(n));
  }

  startAfter(...values: unknown[]): Query {
    return new FsQueryWrapper(this.q.startAfter(...values));
  }

  select(...fields: string[]): Query {
    return new FsQueryWrapper(this.q.select(...fields));
  }

  count(): AggregateQuery {
    const agg = this.q.count();
    return {
      get: async () => {
        const snap = await agg.get();
        return { data: () => ({ count: Number(snap.data().count ?? 0) }) };
      },
    };
  }

  async get(): Promise<QuerySnapshot> {
    return new FsQuerySnapshotWrapper(await this.q.get());
  }
}

class FsCollectionRef extends FsQueryWrapper implements CollectionRef {
  constructor(private readonly coll: CollectionReference) {
    super(coll);
  }

  doc(id?: string): DocRef {
    return new FsDocRef(id === undefined ? this.coll.doc() : this.coll.doc(id));
  }

  async add(data: DocInput): Promise<DocRef> {
    return new FsDocRef(await this.coll.add(data));
  }
}

/** Unwrap an interface ref back to the native one. */
function native(ref: DocRef): DocumentReference {
  return (ref as FsDocRef).native;
}

class FsTransactionWrapper implements Transaction {
  constructor(private readonly tx: FsTransaction) {}

  async get(ref: DocRef): Promise<DocSnapshot> {
    return new FsDocSnapshot(await this.tx.get(native(ref)));
  }

  set(ref: DocRef, data: DocInput, opts?: { merge?: boolean }): void {
    if (opts?.merge) this.tx.set(native(ref), data, { merge: true });
    else this.tx.set(native(ref), data);
  }

  update(ref: DocRef, data: DocInput): void {
    this.tx.update(native(ref), data as UpdateData<FsDocumentData>);
  }
}

class FsWriteBatchWrapper implements WriteBatch {
  constructor(private readonly batch: FsWriteBatch) {}

  delete(ref: DocRef): void {
    this.batch.delete(native(ref));
  }

  async commit(): Promise<void> {
    await this.batch.commit();
  }
}

export class FirestoreStore implements DocumentStore {
  constructor(private readonly db: Firestore) {}

  collection(name: string): CollectionRef {
    return new FsCollectionRef(this.db.collection(name));
  }

  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction((tx) => fn(new FsTransactionWrapper(tx)));
  }

  batch(): WriteBatch {
    return new FsWriteBatchWrapper(this.db.batch());
  }
}

/**
 * Build the Firestore-backed store.
 *
 * On Cloud Run, authentication is via Application Default Credentials picked up
 * from the attached service account. Locally, run
 * `gcloud auth application-default login` once.
 *
 * Pass a `projectId` only if we can't rely on ADC's auto-detection (e.g.
 * running tests against the emulator).
 */
export function createFirestoreStore(projectId?: string): DocumentStore {
  return new FirestoreStore(new Firestore(projectId ? { projectId } : {}));
}
