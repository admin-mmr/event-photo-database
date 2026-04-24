/**
 * emailTriggers.ts — GAS time-trigger lifecycle for scheduled email jobs.
 *
 * Extracted from emailService.ts (§1.1 god-file split) so that trigger
 * installation/removal lives in isolation from email rendering and dispatch.
 *
 * Run these functions once from the GAS editor after the first deploy to
 * install the scheduled triggers. All functions are idempotent.
 */

/* global ScriptApp, Logger */

// ─── Report triggers ──────────────────────────────────────────────────────────

/**
 * Installs the daily and weekly time-driven triggers if they don't exist.
 *
 * Run this once from the GAS editor (Run → installEmailReportTriggers) after
 * the first deploy. Idempotent — uses the handler function name as the
 * uniqueness key, so calling it again is a no-op.
 *
 * Schedule (all in the script's timezone — see File → Project properties):
 *   • dailyReportTrigger   — every day between 07:00 and 08:00
 *   • weeklyReportTrigger  — every Monday between 07:00 and 08:00
 */
export function installEmailReportTriggers(): void {
  const existing = ScriptApp.getProjectTriggers();
  const names = new Set(existing.map((t) => t.getHandlerFunction()));

  if (!names.has('dailyReportTrigger')) {
    ScriptApp.newTrigger('dailyReportTrigger').timeBased().everyDays(1).atHour(7).create();
  }
  if (!names.has('weeklyReportTrigger')) {
    ScriptApp.newTrigger('weeklyReportTrigger')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(7)
      .create();
  }
}

/**
 * Removes the daily / weekly triggers, if present.
 * Run from the GAS editor to pause scheduled digests without a redeploy.
 */
export function uninstallEmailReportTriggers(): void {
  const all = ScriptApp.getProjectTriggers();
  for (const t of all) {
    const fn = t.getHandlerFunction();
    if (fn === 'dailyReportTrigger' || fn === 'weeklyReportTrigger') {
      ScriptApp.deleteTrigger(t);
    }
  }
}

// ─── Retry trigger ────────────────────────────────────────────────────────────

/**
 * Installs the hourly email retry trigger if it does not already exist.
 * Run once from the GAS editor alongside installEmailReportTriggers().
 * Idempotent — safe to call multiple times.
 */
export function installEmailRetryTrigger(): void {
  const existing = ScriptApp.getProjectTriggers();
  const names    = new Set(existing.map((t) => t.getHandlerFunction()));
  if (!names.has('retryFailedEmailsTrigger')) {
    ScriptApp.newTrigger('retryFailedEmailsTrigger').timeBased().everyHours(1).create();
    Logger.log('[emailTriggers.installEmailRetryTrigger] Installed retryFailedEmailsTrigger (hourly)');
  }
}

/**
 * Removes the email retry trigger if present.
 */
export function uninstallEmailRetryTrigger(): void {
  const all = ScriptApp.getProjectTriggers();
  for (const t of all) {
    if (t.getHandlerFunction() === 'retryFailedEmailsTrigger') {
      ScriptApp.deleteTrigger(t);
    }
  }
}
