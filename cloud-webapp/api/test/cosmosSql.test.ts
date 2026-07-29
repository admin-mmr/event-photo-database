/**
 * cosmosSql.test.ts — golden SQL for the Firestore→Cosmos query translation.
 *
 * `cosmosDb.test.ts` proves the adapter behaves correctly against an in-memory
 * executor. This file proves the SQL is the SQL we mean to send — the part a
 * fake executor can agree with while a real Cosmos account would not (index
 * usage, reserved words, parameter binding).
 *
 * Treat a diff here as a decision, not a nuisance: changing the emitted shape
 * can change which composite index serves a query, and therefore its RU cost.
 */

import { describe, it, expect } from 'vitest';

import { buildByIdQuery, buildQuery, type QuerySpec } from '../src/lib/db/cosmosSql.js';
import { DOC_ID } from '../src/lib/db/types.js';

const base: QuerySpec = {
  filters: [],
  orders: [],
  limit: null,
  startAfter: null,
  projection: null,
};

describe('buildQuery — shape', () => {
  it('emits a bare scan when nothing is constrained', () => {
    expect(buildQuery(base)).toEqual({ query: 'SELECT * FROM c', parameters: [] });
  });

  it('parameterizes equality filters (never string-interpolates values)', () => {
    // SQL injection via an event id would otherwise be one bad concat away.
    const q = buildQuery({ ...base, filters: [{ field: 'eventId', value: "e1' OR 1=1--" }] });
    expect(q.query).toBe('SELECT * FROM c WHERE c["eventId"] = @p0');
    expect(q.parameters).toEqual([{ name: '@p0', value: "e1' OR 1=1--" }]);
  });

  it('quotes field references so reserved words are safe', () => {
    // `name` is both a real field on photos and a Cosmos reserved word.
    const q = buildQuery({ ...base, orders: [{ field: 'name', dir: 'asc' }] });
    expect(q.query).toContain('c["name"]');
    expect(q.query).not.toContain('c.name');
  });

  it('guards every orderBy field with IS_DEFINED, but not the document id', () => {
    // Firestore excludes docs missing the sort field; Cosmos does not unless
    // told. Without this the gallery's addedAt fallback never triggers.
    const q = buildQuery({
      ...base,
      orders: [
        { field: 'takenAt', dir: 'asc' },
        { field: DOC_ID, dir: 'asc' },
      ],
    });
    expect(q.query).toContain('IS_DEFINED(c["takenAt"])');
    expect(q.query).not.toContain('IS_DEFINED(c.id)');
  });
});

describe('buildQuery — the gallery page (decision D8 keyset paging)', () => {
  const galleryPage = (dir: 'asc' | 'desc', cursor?: [string, string]): QuerySpec => ({
    ...base,
    filters: [{ field: 'eventId', value: 'e1' }],
    orders: [
      { field: 'takenAt', dir },
      { field: DOC_ID, dir },
    ],
    limit: 24,
    startAfter: cursor ?? null,
  });

  it('ascending: strictly-after on (field, id)', () => {
    const q = buildQuery(galleryPage('asc', ['2026-01-01', 'p1']));
    expect(q.query).toBe(
      'SELECT * FROM c WHERE c["eventId"] = @p0 AND IS_DEFINED(c["takenAt"]) AND ' +
        '((c["takenAt"] > @p1) OR (c["takenAt"] = @p2 AND c.id > @p3)) ' +
        'ORDER BY c["takenAt"] ASC, c.id ASC OFFSET 0 LIMIT 24',
    );
    expect(q.parameters.map((p) => p.value)).toEqual(['e1', '2026-01-01', '2026-01-01', 'p1']);
  });

  it('descending: the comparison flips with the sort direction', () => {
    // Getting this wrong returns page 1 forever — the paging bug that never
    // errors, it just silently loops.
    const q = buildQuery(galleryPage('desc', ['2026-01-01', 'p1']));
    expect(q.query).toContain('((c["takenAt"] < @p1) OR (c["takenAt"] = @p2 AND c.id < @p3))');
    expect(q.query).toContain('ORDER BY c["takenAt"] DESC, c.id DESC');
  });

  it('omits the keyset predicate on the first page', () => {
    const q = buildQuery(galleryPage('asc'));
    expect(q.query).not.toContain(' OR ');
    expect(q.query).toContain('OFFSET 0 LIMIT 24');
  });

  it('orders the ORDER BY terms exactly as requested', () => {
    // The composite index only serves the query in this order.
    const q = buildQuery(galleryPage('asc'));
    expect(q.query.indexOf('c["takenAt"] ASC')).toBeLessThan(q.query.indexOf('c.id ASC'));
  });
});

describe('buildQuery — projections and count', () => {
  it('projects into an explicit object, aliasing the id out of the way', () => {
    const q = buildQuery({
      ...base,
      filters: [{ field: 'eventId', value: 'e1' }],
      projection: ['contentHash'],
    });
    expect(q.query).toBe(
      'SELECT VALUE { "__id": c.id, "contentHash": c["contentHash"] } FROM c ' +
        'WHERE c["eventId"] = @p0',
    );
  });

  it('select() with no fields yields ids only', () => {
    const q = buildQuery({ ...base, projection: [] });
    expect(q.query).toBe('SELECT VALUE { "__id": c.id } FROM c');
  });

  it('count ignores paging so it cannot under-report', () => {
    // A COUNT with LIMIT would silently cap at the page size.
    const q = buildQuery({
      ...base,
      filters: [{ field: 'eventId', value: 'e1' }],
      limit: 5,
      count: true,
    });
    expect(q.query).toBe('SELECT VALUE COUNT(1) FROM c WHERE c["eventId"] = @p0');
    expect(q.query).not.toContain('LIMIT');
    expect(q.query).not.toContain('ORDER BY');
  });
});

describe('buildByIdQuery', () => {
  it('finds one document across partitions', () => {
    // Used when the partition key is not derivable from the id — see cosmosDb.ts.
    expect(buildByIdQuery('p1')).toEqual({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: 'p1' }],
    });
  });
});
