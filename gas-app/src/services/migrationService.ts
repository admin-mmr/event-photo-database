/**
 * migrationService.ts — one-time data migration for the Phase 7 model change.
 *
 * Background
 * ----------
 * Before Phase 1 introduced the link-based upload model, the system allowed
 * admins to upload directly to a special "admin club" (ADMIN_CLUB_ID = '__admin__').
 * Those Upload_Log rows need to be flagged so admins can re-attribute them to a
 * real club.  Additionally, Users sheet rows written before the 9-column schema
 * (which added LAST_LOGIN_AT at col 8) may be missing that trailing column.
 *
 * This service is idempotent: running it multiple times is safe — rows already
 * flagged or already 9-column are left untouched.
 *
 * Dry-run behaviour
 * -----------------
 * When dryRun=true (the default) the service scans and reports what it *would*
 * change but writes nothing to the sheet or audit log.  Pass dryRun=false only
 * when you are ready to commit the changes.
 *
 * Usage (from GAS console or a one-time trigger)
 * -----------------------------------------------
 *   // Preview:
 *   const preview = migrateFromLegacy({ dryRun: true });
 *   Logger.log(JSON.stringify(preview));
 *
 *   // Commit:
 *   const result = migrateFromLegacy({ dryRun: false });
 *   Logger.log(JSON.stringify(result));
 */

import { AuditAction, UserRole, UserStatus } from '../types/enums';
import { COLUMNS, ADMIN_CLUB_ID, getConfig, USERS_HEADERS } from '../config/constants';
import { getAllRows, updateRow, ensureHeaders } from './sheetService';
import { toUserRecord, fromUserRecord } from '../utils/sheetMapper';
import { appendAuditLog } from './auditLogService';

/* global Logger */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MigrationOptions {
  /**
   * When true (default), the migration only reports what it would change.
   * No writes are made to any sheet or audit log.
   */
  dryRun?: boolean;
}

export interface MigrationResult {
  /** Whether this was a dry-run (no writes were made). */
  dryRun: boolean;

  /** Upload_Log rows whose clubName === ADMIN_CLUB_ID. */
  uploadLogAdminClubRows: number;

  /** Users rows that had an unrecognised role and were normalised. */
  usersRoleNormalised: number;

  /** Users rows that were missing the LAST_LOGIN_AT column and were padded. */
  usersPadded: number;

  /** Total rows inspected across all sheets. */
  rowsInspected: number;

  /** Human-readable summary of every change made (or that would be made). */
  changes: string[];
}

// ─── Legacy role map ──────────────────────────────────────────────────────────

/**
 * Maps old role strings (used before the UserRole enum was introduced) to their
 * current equivalents.  Strings already matching a valid UserRole are left alone.
 */
const LEGACY_ROLE_MAP: Record<string, UserRole> = {
  admin:       UserRole.SUPER_ADMIN,
  super_admin: UserRole.SUPER_ADMIN, // already canonical — included for completeness
  club_admin:  UserRole.CLUB_ADMIN,  // already canonical
  user:        UserRole.CLUB_ADMIN,  // legacy name for scoped admin
  manager:     UserRole.CLUB_ADMIN,  // historical alias used in early prototypes
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs the legacy data migration.
 *
 * Pass `{ dryRun: false }` to commit.  Dry-run is the default so an accidental
 * call in the GAS console doesn't mutate live data.
 */
export function migrateFromLegacy(
  options: MigrationOptions = {}
): MigrationResult {
  const { dryRun = true } = options;
  const config = getConfig();

  const result: MigrationResult = {
    dryRun,
    uploadLogAdminClubRows: 0,
    usersRoleNormalised: 0,
    usersPadded: 0,
    rowsInspected: 0,
    changes: [],
  };

  Logger.log(`[MigrationService] Starting legacy migration. dryRun=${dryRun}`);

  _migrateUploadLog(config, result, dryRun);
  _migrateUsers(config, result, dryRun);

  if (!dryRun && (result.uploadLogAdminClubRows + result.usersRoleNormalised + result.usersPadded) > 0) {
    appendAuditLog({
      actorEmail:   'system',
      action:       AuditAction.DATA_MIGRATED,
      resourceType: 'migration',
      resourceId:   'legacy_phase7',
      details: {
        uploadLogAdminClubRows: result.uploadLogAdminClubRows,
        usersRoleNormalised:    result.usersRoleNormalised,
        usersPadded:            result.usersPadded,
        rowsInspected:          result.rowsInspected,
      },
    });
  }

  Logger.log(
    `[MigrationService] Done. ` +
    `uploadLogAdminClubRows=${result.uploadLogAdminClubRows} ` +
    `usersRoleNormalised=${result.usersRoleNormalised} ` +
    `usersPadded=${result.usersPadded} ` +
    `rowsInspected=${result.rowsInspected}`
  );

  return result;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Scans Upload_Log for rows where clubName === ADMIN_CLUB_ID ('__admin__').
 *
 * In dry-run mode: counts and reports them.
 * In commit mode:  rewrites the clubName to the sentinel value
 *                  '__admin__[NEEDS_REATTRIBUTION]' so admins can spot them in
 *                  the spreadsheet UI and reassign to a real club.
 *
 * We deliberately do NOT delete or blank these rows — they are audit evidence.
 */
function _migrateUploadLog(
  config: ReturnType<typeof getConfig>,
  result: MigrationResult,
  dryRun: boolean
): void {
  const sheetName = config.SHEET_NAMES.UPLOAD_LOG;
  const col = COLUMNS.UPLOAD_LOG;
  let rows: unknown[][];

  try {
    rows = getAllRows(sheetName);
  } catch (err) {
    Logger.log(`[MigrationService._migrateUploadLog] Skipping — sheet unreadable: ${String(err)}`);
    return;
  }

  result.rowsInspected += rows.length;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const clubName = String(row[col.CLUB_NAME] ?? '').trim();
    if (clubName !== ADMIN_CLUB_ID) continue;

    result.uploadLogAdminClubRows++;
    const msg =
      `Upload_Log row ${i + 2}: logId=${String(row[col.LOG_ID] ?? '')} ` +
      `clubName='${ADMIN_CLUB_ID}' → needs reattribution`;
    result.changes.push(dryRun ? `[DRY RUN] ${msg}` : msg);

    if (!dryRun) {
      const updatedRow = [...row];
      updatedRow[col.CLUB_NAME] = `${ADMIN_CLUB_ID}[NEEDS_REATTRIBUTION]`;
      try {
        updateRow(sheetName, i + 2, updatedRow); // i+2: 1-based + skip header
      } catch (err) {
        Logger.log(`[MigrationService._migrateUploadLog] Failed to update row ${i + 2}: ${String(err)}`);
        result.changes.push(`ERROR updating row ${i + 2}: ${String(err)}`);
      }
    }
  }
}

/**
 * Scans the Users sheet for two categories of legacy rows:
 *
 * 1. Rows with an unrecognised role string — normalises via LEGACY_ROLE_MAP.
 *    Rows whose role cannot be mapped are flagged but left unchanged.
 *
 * 2. Rows shorter than 9 columns (missing LAST_LOGIN_AT) — pads the row with
 *    an empty string so it passes the toUserRecord() mapper.
 */
function _migrateUsers(
  config: ReturnType<typeof getConfig>,
  result: MigrationResult,
  dryRun: boolean
): void {
  const sheetName = config.SHEET_NAMES.USERS;
  const col = COLUMNS.USERS;
  let rows: unknown[][];

  try {
    ensureHeaders(sheetName, USERS_HEADERS as string[]);
    rows = getAllRows(sheetName);
  } catch (err) {
    Logger.log(`[MigrationService._migrateUsers] Skipping — sheet unreadable: ${String(err)}`);
    return;
  }

  result.rowsInspected += rows.length;

  for (let i = 0; i < rows.length; i++) {
    const row = [...rows[i]]; // mutable copy
    let changed = false;

    // ── 1. Pad short rows (missing LAST_LOGIN_AT) ──────────────────────────
    const expectedCols = USERS_HEADERS.length; // 9
    if (row.length < expectedCols) {
      const padMsg =
        `Users row ${i + 2}: email=${String(row[col.EMAIL] ?? '')} — ` +
        `padded from ${row.length} to ${expectedCols} columns`;
      result.changes.push(dryRun ? `[DRY RUN] ${padMsg}` : padMsg);
      result.usersPadded++;
      while (row.length < expectedCols) row.push('');
      changed = true;
    }

    // ── 2. Normalise legacy role strings ──────────────────────────────────
    const rawRole = String(row[col.ROLE] ?? '').trim();
    const isValidRole = Object.values(UserRole).includes(rawRole as UserRole);

    if (!isValidRole) {
      const mapped = LEGACY_ROLE_MAP[rawRole];
      if (mapped) {
        const roleMsg =
          `Users row ${i + 2}: email=${String(row[col.EMAIL] ?? '')} — ` +
          `role '${rawRole}' → '${mapped}'`;
        result.changes.push(dryRun ? `[DRY RUN] ${roleMsg}` : roleMsg);
        result.usersRoleNormalised++;
        row[col.ROLE] = mapped;
        changed = true;
      } else {
        // Unrecognised role, not in our map — flag it but leave it alone.
        result.changes.push(
          `WARN: Users row ${i + 2}: email=${String(row[col.EMAIL] ?? '')} — ` +
          `unrecognised role '${rawRole}' (not in LEGACY_ROLE_MAP; manual review needed)`
        );
      }
    }

    // ── 3. Validate status; default to 'active' if unrecognised ───────────
    const rawStatus = String(row[col.STATUS] ?? '').trim();
    const isValidStatus = Object.values(UserStatus).includes(rawStatus as UserStatus);
    if (!isValidStatus && rawStatus !== '') {
      const statusMsg =
        `Users row ${i + 2}: email=${String(row[col.EMAIL] ?? '')} — ` +
        `status '${rawStatus}' → '${UserStatus.ACTIVE}' (defaulted)`;
      result.changes.push(dryRun ? `[DRY RUN] ${statusMsg}` : statusMsg);
      row[col.STATUS] = UserStatus.ACTIVE;
      changed = true;
    }

    // ── Commit row if modified ─────────────────────────────────────────────
    if (changed && !dryRun) {
      // Re-validate through the mapper before writing back
      const record = toUserRecord(row);
      if (record) {
        try {
          updateRow(sheetName, i + 2, fromUserRecord(record));
        } catch (err) {
          Logger.log(
            `[MigrationService._migrateUsers] Failed to update row ${i + 2}: ${String(err)}`
          );
          result.changes.push(`ERROR updating Users row ${i + 2}: ${String(err)}`);
        }
      } else {
        result.changes.push(
          `WARN: Users row ${i + 2} still fails toUserRecord() after migration; skipped write.`
        );
      }
    }
  }
}
