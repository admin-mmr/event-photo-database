/**
 * eventLabel — human label for an event (dev plan §5A B5).
 *
 * The indexer/reconciler backfill `name` from the Drive folder / master Sheet,
 * but to be safe the UI applies its own rule: it must NEVER render the literal
 * "Untitled event" for an event that actually has photos. When a named-less
 * event has photos we fall back to its date, then a short id, so the user sees
 * something meaningful rather than a dead "Untitled" label.
 */
export function eventLabel(opts: {
  name?: string | null | undefined;
  date?: string | null | undefined;
  id: string;
  hasPhotos?: boolean | undefined;
}): string {
  const name = (opts.name ?? '').trim();
  if (name) return name;
  const date = (opts.date ?? '').trim();
  if (opts.hasPhotos) {
    return date ? `Event · ${date}` : `Event ${opts.id.slice(0, 6)}`;
  }
  return date ? `Event · ${date}` : 'Untitled event';
}
