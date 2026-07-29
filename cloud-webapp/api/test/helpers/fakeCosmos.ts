/**
 * fakeCosmos.ts — an in-memory `CosmosOps` that EXECUTES the SQL the adapter
 * generates, so the Cosmos adapter can be held to the same contract suite as
 * the Firestore one without an account or an emulator.
 *
 * Why execute the SQL rather than stub the results: the highest-risk part of the
 * port is the query translation (`cosmosSql.ts`) — the `IS_DEFINED` guards and
 * the keyset `startAfter` predicate of decision D8. A stub that returned canned
 * rows would test everything except the thing most likely to be wrong.
 *
 * This evaluates exactly the dialect `buildQuery` emits — a machine-generated
 * grammar with no nesting beyond one level of OR-group — NOT Cosmos SQL in
 * general. If `buildQuery` grows a construct, this must grow with it; an
 * unrecognized term throws rather than silently evaluating to true.
 *
 * It is a model of Cosmos, not Cosmos. It cannot prove RU cost, index
 * requirements, or cross-partition ORDER BY behaviour — those need the emulator
 * or a real account, which is an AZ4 item.
 */

import {
  ConflictError,
  CosmosStore,
  PreconditionFailedError,
  encodeDocId,
  partitionKeyPath,
  type CosmosOps,
  type CosmosReadResult,
} from '../../src/lib/db/cosmosDb.js';
import type { DocData, DocumentStore } from '../../src/lib/db/types.js';
import type { StoreHarness } from './documentStoreContract.js';

// ── tiny SQL evaluator for the generated dialect ─────────────────────────────

/** Split on `sep` at paren depth 0, ignoring separators inside quotes. */
function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && input.startsWith(sep, i)) {
      out.push(input.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    // Only strip when the leading paren matches the trailing one.
    let depth = 0;
    let matches = true;
    for (let i = 0; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')') {
        depth -= 1;
        if (depth === 0 && i < t.length - 1) {
          matches = false;
          break;
        }
      }
    }
    if (!matches) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** `c.id` → the row id; `c["field"]` → that field. */
function readRef(row: DocData, ref: string): unknown {
  const t = ref.trim();
  if (t === 'c.id') return row.id;
  const m = /^c\[(".*")\]$/.exec(t);
  if (!m) throw new Error(`fakeCosmos: unsupported field reference ${ref}`);
  return row[JSON.parse(m[1]!) as string];
}

/** Same ordering the FakeStore uses, so the two adapters are held to one rule. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  const [as, bs] = [String(a), String(b)];
  return as < bs ? -1 : as > bs ? 1 : 0;
}

type Params = Record<string, unknown>;

function evalPredicate(row: DocData, expr: string, params: Params): boolean {
  const e = stripOuterParens(expr);

  const ors = splitTopLevel(e, ' OR ');
  if (ors.length > 1) return ors.some((o) => evalPredicate(row, o, params));

  const ands = splitTopLevel(e, ' AND ');
  if (ands.length > 1) return ands.every((a) => evalPredicate(row, a, params));

  const defined = /^IS_DEFINED\((.+)\)$/.exec(e);
  if (defined) return readRef(row, defined[1]!) !== undefined;

  const cmp = /^(.+?)\s*(=|>|<)\s*(@\w+)$/.exec(e);
  if (cmp) {
    const left = readRef(row, cmp[1]!);
    const right = params[cmp[3]!];
    if (cmp[2] === '=') return left === right;
    const c = compareValues(left, right);
    return cmp[2] === '>' ? c > 0 : c < 0;
  }

  throw new Error(`fakeCosmos: unsupported predicate '${e}'`);
}

interface ParsedSelect {
  count: boolean;
  star: boolean;
  /** field name → reference expression, for the projected-object form. */
  projection: Array<{ key: string; ref: string }>;
}

function parseSelect(clause: string): ParsedSelect {
  const c = clause.trim();
  if (c === 'SELECT VALUE COUNT(1)') return { count: true, star: false, projection: [] };
  if (c === 'SELECT *') return { count: false, star: true, projection: [] };
  const obj = /^SELECT VALUE \{(.*)\}$/.exec(c);
  if (!obj) throw new Error(`fakeCosmos: unsupported SELECT '${clause}'`);
  const projection = splitTopLevel(obj[1]!, ',').map((pair) => {
    const idx = pair.indexOf(':');
    return {
      key: JSON.parse(pair.slice(0, idx).trim()) as string,
      ref: pair.slice(idx + 1).trim(),
    };
  });
  return { count: false, star: false, projection };
}

function evaluate(
  rows: DocData[],
  sql: { query: string; parameters: Array<{ name: string; value: unknown }> },
): DocData[] {
  const params: Params = Object.fromEntries(sql.parameters.map((p) => [p.name, p.value]));
  const q = sql.query;

  const limitMatch = /\sOFFSET 0 LIMIT (\d+)$/.exec(q);
  const body = limitMatch ? q.slice(0, limitMatch.index) : q;

  const orderIdx = body.indexOf(' ORDER BY ');
  const beforeOrder = orderIdx === -1 ? body : body.slice(0, orderIdx);
  const orderClause = orderIdx === -1 ? '' : body.slice(orderIdx + ' ORDER BY '.length);

  const whereIdx = beforeOrder.indexOf(' WHERE ');
  const selectFrom = whereIdx === -1 ? beforeOrder : beforeOrder.slice(0, whereIdx);
  const whereClause = whereIdx === -1 ? '' : beforeOrder.slice(whereIdx + ' WHERE '.length);

  const select = parseSelect(selectFrom.replace(/\sFROM c$/, ''));

  let out = whereClause ? rows.filter((r) => evalPredicate(r, whereClause, params)) : [...rows];

  if (orderClause) {
    const terms = splitTopLevel(orderClause, ',').map((t) => {
      const m = /^(.+?)\s+(ASC|DESC)$/.exec(t.trim());
      if (!m) throw new Error(`fakeCosmos: unsupported ORDER BY term '${t}'`);
      return { ref: m[1]!, desc: m[2] === 'DESC' };
    });
    out.sort((a, b) => {
      for (const t of terms) {
        const c = compareValues(readRef(a, t.ref), readRef(b, t.ref));
        if (c !== 0) return t.desc ? -c : c;
      }
      return 0;
    });
  }

  if (limitMatch) out = out.slice(0, Number(limitMatch[1]));

  if (select.count) return [out.length as unknown as DocData];
  if (select.star) return out;
  return out.map((r) => {
    const projected: DocData = {};
    for (const p of select.projection) {
      const v = readRef(r, p.ref);
      if (v !== undefined) projected[p.key] = v; // Cosmos omits undefined
    }
    return projected;
  });
}

// ── the in-memory CosmosOps ──────────────────────────────────────────────────

export class FakeCosmos implements CosmosOps {
  /** container → (encoded id → raw row, including `id` and `_etag`). */
  readonly containers = new Map<string, Map<string, DocData>>();

  private etagSeq = 0;

  private container(name: string): Map<string, DocData> {
    let c = this.containers.get(name);
    if (!c) {
      c = new Map<string, DocData>();
      this.containers.set(name, c);
    }
    return c;
  }

  private nextEtag(): string {
    this.etagSeq += 1;
    return `"etag-${this.etagSeq}"`;
  }

  /** The stored partition-key value for a row, per the adapter's own map. */
  private pkValueOf(collection: string, row: DocData): unknown {
    return row[partitionKeyPath(collection).replace(/^\//, '')];
  }

  async readById(
    collection: string,
    id: string,
    partitionKey?: string,
  ): Promise<CosmosReadResult> {
    const row = this.container(collection).get(id);
    if (!row) return {};
    // Real Cosmos 404s a point read carrying the wrong partition key. Emulating
    // that is what makes a bad PARTITION_KEYS entry fail loudly in tests.
    if (partitionKey !== undefined && this.pkValueOf(collection, row) !== partitionKey) return {};
    return { row: structuredClone(row), etag: row._etag as string };
  }

  async query(
    collection: string,
    sql: { query: string; parameters: Array<{ name: string; value: unknown }> },
  ): Promise<DocData[]> {
    // Clone in and out: the real SDK crosses a JSON boundary, so no caller ever
    // shares an object graph with stored state.
    const rows = [...this.container(collection).values()].map((r) => structuredClone(r));
    return evaluate(rows, sql);
  }

  async upsert(collection: string, body: DocData, ifMatch?: string): Promise<void> {
    const c = this.container(collection);
    const id = String(body.id);
    const existing = c.get(id);
    if (ifMatch !== undefined && existing && existing._etag !== ifMatch) {
      throw new PreconditionFailedError(`etag mismatch on ${collection}/${id}`);
    }
    c.set(id, structuredClone({ ...body, _etag: this.nextEtag() }));
  }

  async create(collection: string, body: DocData): Promise<void> {
    const c = this.container(collection);
    const id = String(body.id);
    if (c.has(id)) throw new ConflictError(`ALREADY_EXISTS: ${collection}/${id}`);
    c.set(id, structuredClone({ ...body, _etag: this.nextEtag() }));
  }

  async remove(collection: string, id: string, _partitionKey?: string): Promise<void> {
    this.container(collection).delete(id); // missing id is a no-op, as in the adapter
  }
}

// ── harness ──────────────────────────────────────────────────────────────────

const SYSTEM = new Set(['id', '_etag']);

export function cosmosHarness(): StoreHarness {
  const ops = new FakeCosmos();
  const store = new CosmosStore(ops);
  let transactions = 0;
  const counting: DocumentStore = {
    collection: (n) => store.collection(n),
    batch: () => store.batch(),
    runTransaction: (fn) => {
      transactions += 1;
      return store.runTransaction(fn);
    },
  };

  return {
    store: counting,
    seed(collection, docs) {
      for (const [id, body] of Object.entries(docs)) {
        void ops.create(collection, { ...body, id: encodeDocId(id) });
      }
    },
    peek(collection, id) {
      const row = ops.containers.get(collection)?.get(encodeDocId(id));
      if (!row) return undefined;
      return Object.fromEntries(Object.entries(row).filter(([k]) => !SYSTEM.has(k)));
    },
    ids(collection) {
      return [...(ops.containers.get(collection)?.keys() ?? [])].sort();
    },
    transactions: () => transactions,
  };
}
