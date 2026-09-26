/**
 * uploadCostModel.ts — how long one staged object takes to copy to Drive.
 *
 * Shared by the two places that must not outlive the upload worker's 1800s
 * request window: the recovery tool (spacing its dispatches and sizing chunks)
 * and the worker itself (deciding when to stop and hand the rest of a batch to a
 * continuation task). One model, so the two can never disagree about what fits.
 *
 * The constants come from measured runs, not guesses:
 *   - 8.8 GB of video moved in 1,295s ≈ 6.8 MB/s through GCS → worker → Drive,
 *     so 6 MB/s is slightly conservative;
 *   - 1.2s covers the per-object overhead (metadata read, md5 claim, Drive
 *     create, the shared Drive pacing gate);
 *   - together they predict ~2.2s for a 6 MB photo, against 2.5s observed on the
 *     663-photo batch of 2026-09-19 that took 1,685s — 94% of the window.
 */

export const PER_OBJECT_MS = 1_200;
export const THROUGHPUT_BYTES_PER_SEC = 6 * 1024 * 1024;

/** Expected wall-clock to copy one object of `bytes`. */
export function objectCostMs(bytes: number): number {
  return PER_OBJECT_MS + (bytes / THROUGHPUT_BYTES_PER_SEC) * 1000;
}
