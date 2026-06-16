/**
 * selection.ts — pure multi-select reducer for photo grids (dev plan §5A B2).
 *
 * Kept framework-free and pure so the "select all / select none / invert"
 * behaviour is unit-testable without rendering (test additions in §5A).
 * Selection is a Set of photoIds; the reducer always returns a NEW Set so
 * React state updates trigger re-renders.
 */

import { useCallback, useReducer } from 'react';

export type SelectionAction =
  | { type: 'toggle'; id: string }
  | { type: 'selectAll'; ids: readonly string[] }
  | { type: 'selectNone' }
  /** Invert within the given universe (e.g. "select all, then deselect some"). */
  | { type: 'invert'; ids: readonly string[] };

export function selectionReducer(
  state: ReadonlySet<string>,
  action: SelectionAction,
): Set<string> {
  switch (action.type) {
    case 'toggle': {
      const next = new Set(state);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return next;
    }
    case 'selectAll':
      return new Set(action.ids);
    case 'selectNone':
      return new Set();
    case 'invert': {
      const next = new Set<string>();
      for (const id of action.ids) if (!state.has(id)) next.add(id);
      return next;
    }
    default:
      return new Set(state);
  }
}

export interface UseSelection {
  selected: ReadonlySet<string>;
  count: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  invert: () => void;
}

/** React hook over `selectionReducer`, bound to the current grid's ids. */
export function useSelection(ids: readonly string[]): UseSelection {
  const [selected, dispatch] = useReducer(selectionReducer, undefined, () => new Set<string>());
  return {
    selected,
    count: selected.size,
    isSelected: useCallback((id: string) => selected.has(id), [selected]),
    toggle: useCallback((id: string) => dispatch({ type: 'toggle', id }), []),
    selectAll: useCallback(() => dispatch({ type: 'selectAll', ids }), [ids]),
    selectNone: useCallback(() => dispatch({ type: 'selectNone' }), []),
    invert: useCallback(() => dispatch({ type: 'invert', ids }), [ids]),
  };
}
