import { describe, it, expect } from 'vitest';
import { selectionReducer } from './selection.js';

const IDS = ['a', 'b', 'c', 'd'];

describe('selectionReducer (B2)', () => {
  it('toggle adds then removes an id, returning a new Set each time', () => {
    const empty = new Set<string>();
    const added = selectionReducer(empty, { type: 'toggle', id: 'a' });
    expect([...added]).toEqual(['a']);
    expect(added).not.toBe(empty); // new reference → React re-renders

    const removed = selectionReducer(added, { type: 'toggle', id: 'a' });
    expect([...removed]).toEqual([]);
  });

  it('selectAll selects exactly the provided universe', () => {
    const all = selectionReducer(new Set(['a']), { type: 'selectAll', ids: IDS });
    expect([...all].sort()).toEqual([...IDS].sort());
  });

  it('selectNone clears everything', () => {
    const cleared = selectionReducer(new Set(IDS), { type: 'selectNone' });
    expect(cleared.size).toBe(0);
  });

  it('invert flips membership within the universe (select-all-then-deselect)', () => {
    // Start with a,b selected → invert over a..d → expect c,d.
    const inverted = selectionReducer(new Set(['a', 'b']), { type: 'invert', ids: IDS });
    expect([...inverted].sort()).toEqual(['c', 'd']);

    // Inverting twice returns the original selection.
    const back = selectionReducer(inverted, { type: 'invert', ids: IDS });
    expect([...back].sort()).toEqual(['a', 'b']);
  });

  it('invert ignores stale ids no longer in the universe', () => {
    const inverted = selectionReducer(new Set(['x']), { type: 'invert', ids: IDS });
    expect([...inverted].sort()).toEqual([...IDS].sort());
  });
});
