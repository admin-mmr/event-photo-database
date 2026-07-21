import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: Array<Record<string, unknown>> = [];

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (_name: string) => ({
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: rows.filter((d) => d[field] === value).map((d) => ({ data: () => d })),
        }),
      }),
    }),
  }),
}));

const { confirmedPhotoIdsForUser } = await import('../src/services/feedback.js');

describe('confirmedPhotoIdsForUser', () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it('returns only confirmed photos for the given user+event', async () => {
    rows.push(
      { uid: 'u1', eventId: 'ev1', photoId: 'a', verdict: 'confirmed', createdAt: '1' },
      { uid: 'u1', eventId: 'ev1', photoId: 'b', verdict: 'not_me', createdAt: '2' },
      { uid: 'u1', eventId: 'ev2', photoId: 'c', verdict: 'confirmed', createdAt: '3' },
      { uid: 'u2', eventId: 'ev1', photoId: 'd', verdict: 'confirmed', createdAt: '4' },
    );
    expect(await confirmedPhotoIdsForUser('u1', 'ev1')).toEqual(['a']);
  });

  it('de-dupes repeated confirmations, newest first', async () => {
    rows.push(
      { uid: 'u1', eventId: 'ev1', photoId: 'a', verdict: 'confirmed', createdAt: '2026-01-01' },
      { uid: 'u1', eventId: 'ev1', photoId: 'b', verdict: 'confirmed', createdAt: '2026-03-01' },
      { uid: 'u1', eventId: 'ev1', photoId: 'a', verdict: 'confirmed', createdAt: '2026-02-01' },
    );
    expect(await confirmedPhotoIdsForUser('u1', 'ev1')).toEqual(['b', 'a']);
  });

  it('caps the number of folded references', async () => {
    for (let i = 0; i < 40; i++) {
      rows.push({ uid: 'u1', eventId: 'ev1', photoId: `p${i}`, verdict: 'confirmed', createdAt: String(i).padStart(3, '0') });
    }
    expect(await confirmedPhotoIdsForUser('u1', 'ev1', 25)).toHaveLength(25);
  });

  it('returns empty when there are no confirmations', async () => {
    expect(await confirmedPhotoIdsForUser('u1', 'ev1')).toEqual([]);
  });
});
