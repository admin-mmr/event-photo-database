/**
 * indexState.ts — when an event's `indexState` says a run is still in flight.
 *
 * Shared by every path that can start the indexer (index-scan, "Index now", and
 * the volunteer upload worker) so they agree on what "already running" means.
 */

/** Index-state values that mean "a run is already in flight" — skipped by the
 *  scan so we never stack executions on the same event. */
export const IN_FLIGHT = new Set(['queued', 'running']);

/**
 * How old an in-flight `indexState` may get before we stop believing it.
 *
 * A `queued`/`running` state with no expiry is a trap: the indexer records
 * `failed` from its own except block, so a run that dies WITHOUT running that
 * block — a container killed by OOM or the task timeout, or a crash before the
 * handler is installed (a missing model file did exactly this to event
 * 5ff5ff5c on 2026-08-02) — leaves the state in flight forever. The scan then
 * skips the event as already-running on every tick and the "Index now" button
 * 409s, so the one path that could clear it never runs. The event shows
 * "Indexing…" until a human notices.
 *
 * The window must be comfortably above the indexer's longest un-heartbeaten
 * stretch, or a live run is mistaken for a dead one and a second execution is
 * stacked on top of it. The heartbeat (HEARTBEAT_SEC, 30s) only fires inside
 * the embedding loop; the stretches around it — cold start + model load, the
 * recursive Drive listing, loading the previous store, the per-photo Firestore
 * upserts and the final store write — all grow with the event. At ~7k photos
 * they fit easily in 30 minutes; at the 100k+ an NYC-Marathon-sized event
 * reaches they do not (the listing alone is 100+ serial pages, and the store is
 * gigabytes), so the window is 60 minutes. If you lengthen the heartbeat gap,
 * lengthen this too.
 */
export const STALE_INDEX_MS = 60 * 60 * 1000;

/** Whether an event's index run should still be treated as in flight. A state
 *  whose `updatedAt` is missing or unparseable is treated as fresh: an unknown
 *  age must not license a second concurrent execution. */
export function isIndexInFlight(indexState: unknown, now = Date.now()): boolean {
  const state = (indexState ?? {}) as { status?: unknown; updatedAt?: unknown };
  if (!IN_FLIGHT.has(String(state.status))) return false;
  const updatedAt = Date.parse(String(state.updatedAt ?? ''));
  if (!Number.isFinite(updatedAt)) return true;
  return now - updatedAt < STALE_INDEX_MS;
}
