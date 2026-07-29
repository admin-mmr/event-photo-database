/**
 * cosmosSql.ts — Firestore query shape → Cosmos SQL.
 *
 * Split out from the adapter and kept PURE so the translation can be tested
 * exhaustively without a Cosmos account. This is where the porting bugs live,
 * so it is the part that gets the most tests (`test/cosmosSql.test.ts`).
 *
 * Three translations are load-bearing and easy to get wrong:
 *
 * 1. **`IS_DEFINED` for every `orderBy` field.** Firestore silently EXCLUDES
 *    documents that lack an `orderBy` field. Cosmos does not — it sorts them as
 *    `undefined`. Without this, an event indexed before `addedAt` existed would
 *    return unsorted rows on Azure where GCP returns an empty page, and
 *    `gallery.ts`'s fallback (which triggers on an empty first page) would never
 *    fire. The gallery would silently mis-order instead of falling back.
 *
 * 2. **Keyset `startAfter` (decision D8)**, not continuation tokens. For orders
 *    `[(f1,d1), (f2,d2)]` and cursor `[v1,v2]`:
 *      (f1 ⋗ v1) OR (f1 = v1 AND f2 ⋗ v2)
 *    where ⋗ is `>` ascending and `<` descending. Same composite index serves
 *    it, and the HTTP cursor contract stays byte-identical to GCP's.
 *
 * 3. **Field access via `c["name"]`**, never `c.name` — `name`, `value`, `order`
 *    and friends are reserved words in Cosmos SQL, and `name` is a real field on
 *    `photos`.
 */

import { DOC_ID, type Direction, type OrderField } from './types.js';

export interface SqlFilter {
  field: string;
  value: unknown;
}

export interface SqlOrder {
  field: OrderField;
  dir: Direction;
}

export interface QuerySpec {
  filters: readonly SqlFilter[];
  orders: readonly SqlOrder[];
  limit: number | null;
  /** Cursor values, positionally matching `orders`. */
  startAfter: readonly unknown[] | null;
  /** `null` = no projection; `[]` = ids only. */
  projection: readonly string[] | null;
  /** Emit `SELECT VALUE COUNT(1)` instead of documents. */
  count?: boolean;
}

export interface SqlQuery {
  query: string;
  parameters: Array<{ name: string; value: unknown }>;
}

/** The alias `data()` strips back off — avoids colliding with a real `id` field. */
export const ID_ALIAS = '__id';

/** A field reference. `DOC_ID` is Cosmos's system `id` property. */
function ref(field: OrderField): string {
  return field === DOC_ID ? 'c.id' : `c[${JSON.stringify(field)}]`;
}

class Params {
  readonly list: Array<{ name: string; value: unknown }> = [];

  add(value: unknown): string {
    const name = `@p${this.list.length}`;
    this.list.push({ name, value });
    return name;
  }
}

function selectClause(spec: QuerySpec): string {
  if (spec.count) return 'SELECT VALUE COUNT(1)';
  if (spec.projection === null) return 'SELECT *';
  // Projection: build an explicit object so the id never collides with a
  // projected field, and absent fields stay absent (Cosmos omits undefined).
  const fields = spec.projection
    .map((f) => `${JSON.stringify(f)}: ${ref(f)}`)
    .join(', ');
  const body = fields ? `, ${fields}` : '';
  return `SELECT VALUE { ${JSON.stringify(ID_ALIAS)}: c.id${body} }`;
}

function keysetPredicate(spec: QuerySpec, params: Params): string | null {
  const cursor = spec.startAfter;
  if (!cursor || cursor.length === 0) return null;

  const clauses: string[] = [];
  for (let i = 0; i < cursor.length; i += 1) {
    const order = spec.orders[i];
    if (!order) break;
    const parts: string[] = [];
    // All earlier keys equal…
    for (let j = 0; j < i; j += 1) {
      const prev = spec.orders[j];
      if (!prev) break;
      parts.push(`${ref(prev.field)} = ${params.add(cursor[j])}`);
    }
    // …and this key strictly past the cursor, in the sort's direction.
    const op = order.dir === 'desc' ? '<' : '>';
    parts.push(`${ref(order.field)} ${op} ${params.add(cursor[i])}`);
    clauses.push(`(${parts.join(' AND ')})`);
  }
  return clauses.length > 0 ? `(${clauses.join(' OR ')})` : null;
}

export function buildQuery(spec: QuerySpec): SqlQuery {
  const params = new Params();
  const where: string[] = [];

  for (const f of spec.filters) {
    where.push(`${ref(f.field)} = ${params.add(f.value)}`);
  }

  // Firestore drops documents missing an orderBy field — see header note 1.
  for (const o of spec.orders) {
    if (o.field !== DOC_ID) where.push(`IS_DEFINED(${ref(o.field)})`);
  }

  const keyset = keysetPredicate(spec, params);
  if (keyset) where.push(keyset);

  let sql = `${selectClause(spec)} FROM c`;
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;

  if (!spec.count && spec.orders.length > 0) {
    const order = spec.orders
      .map((o) => `${ref(o.field)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`)
      .join(', ');
    sql += ` ORDER BY ${order}`;
  }

  // COUNT ignores paging; a limited count would silently under-report.
  if (!spec.count && spec.limit !== null) sql += ` OFFSET 0 LIMIT ${spec.limit}`;

  return { query: sql, parameters: params.list };
}

/** Find one document by id when its partition key is unknown (cross-partition). */
export function buildByIdQuery(id: string): SqlQuery {
  return { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] };
}
