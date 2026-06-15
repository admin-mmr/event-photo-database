/**
 * superAdmins.ts — Upload Prep feature configuration.
 *
 * getSuperAdmins(): reads active super_admin users directly from the Users sheet.
 *   No Script Property or hardcoded list needed — managing users in the sheet
 *   is the single source of truth.
 *
 * CLOUD_RUN_URL: set this after deploying the image-convert Cloud Run service
 *   (see UPLOAD_PREP_FEATURE_SPEC.md §5.3 for deploy instructions).
 *
 * All other constants here are derived from decisions in the spec §2.
 */

import { getConfig } from './constants';
import { getAllRows } from '../services/sheetService';
import { toUserRecord } from '../utils/sheetMapper';
import { UserRole, UserStatus } from '../types/enums';

// ─── Super-admin allowlist ────────────────────────────────────────────────────

/**
 * Fallback used only when the Users sheet cannot be read (e.g. during unit
 * tests or early bootstrap before the spreadsheet is bound).
 */
const FALLBACK_SUPER_ADMINS: readonly string[] = [
  'admin@mmrunners.org',
] as const;

/**
 * Returns the current super-admin email list by reading active super_admin
 * rows from the Users sheet. This means adding or removing a super_admin in
 * the sheet takes effect immediately — no Script Property or redeploy needed.
 *
 * Falls back to FALLBACK_SUPER_ADMINS only if the sheet cannot be read.
 * Emails are always lowercased and trimmed.
 */
export function getSuperAdmins(): readonly string[] {
  try {
    const config = getConfig();
    const rows = getAllRows(config.SHEET_NAMES.USERS);
    const emails = rows
      .map(toUserRecord)
      .filter(
        (u): u is NonNullable<typeof u> =>
          u !== null &&
          u.role === UserRole.SUPER_ADMIN &&
          u.status === UserStatus.ACTIVE,
      )
      .map((u) => u.email); // toUserRecord already lowercases email
    return emails.length > 0 ? emails : FALLBACK_SUPER_ADMINS;
  } catch {
    return FALLBACK_SUPER_ADMINS;
  }
}

/**
 * Back-compat export so existing `SUPER_ADMINS.includes(email)` call sites keep
 * working. New code should prefer `getSuperAdmins()`.
 *
 * This is a Proxy so every access re-reads from the Users sheet.
 */
export const SUPER_ADMINS: readonly string[] = new Proxy([] as string[], {
  get(_target, prop, receiver) {
    const current = getSuperAdmins();
    return Reflect.get(current, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getSuperAdmins(), prop);
  },
}) as readonly string[];

// ─── Cloud Run endpoint ───────────────────────────────────────────────────────

/**
 * Default Cloud Run URL placeholder. Deployments MUST override this by setting
 * the `CLOUD_RUN_URL` Script Property.
 */
const CLOUD_RUN_URL_PLACEHOLDER = 'https://image-convert-REPLACE_ME.a.run.app';

/**
 * Returns the Cloud Run image-convert service URL.
 *
 * Reads `CLOUD_RUN_URL` from Script Properties; falls back to the placeholder
 * if unset so code still compiles/loads, but `convertImage()` will refuse to
 * call the placeholder URL (see cloudRunClient.ts).
 */
export function getCloudRunUrl(): string {
  try {
    const v = PropertiesService.getScriptProperties().getProperty('CLOUD_RUN_URL');
    if (v && v.trim().length > 0) return v.trim();
  } catch {
    // fall through to placeholder
  }
  return CLOUD_RUN_URL_PLACEHOLDER;
}

/**
 * True when `CLOUD_RUN_URL` has been configured to a real, non-placeholder URL.
 * Callers should refuse to issue requests when this is false.
 */
export function isCloudRunConfigured(): boolean {
  const url = getCloudRunUrl();
  return url !== CLOUD_RUN_URL_PLACEHOLDER && !/REPLACE_ME/i.test(url);
}

/**
 * @deprecated Prefer `getCloudRunUrl()` so Script Property changes take effect
 * without a redeploy. Kept as an export for backward compatibility.
 */
export const CLOUD_RUN_URL = CLOUD_RUN_URL_PLACEHOLDER;

// ─── Find Me indexing trigger (automated no-touch indexing) ───────────────────

/**
 * Base URL of the cloud-webapp api (event-photo-api Cloud Run service), e.g.
 * https://event-photo-api-XXXX.a.run.app. Set the `FINDME_API_URL` Script
 * Property after deploying the api. Used to fire POST /api/events/:id/index at
 * the end of an upload batch so photos are indexed on arrival.
 */
export function getFindMeApiUrl(): string {
  try {
    const v = PropertiesService.getScriptProperties().getProperty('FINDME_API_URL');
    if (v && v.trim().length > 0) return v.trim().replace(/\/$/, '');
  } catch {
    // fall through
  }
  return '';
}

/**
 * Shared machine-caller secret that authorizes POST /api/events/:id/index and
 * /api/admin/index-scan via the `X-Sync-Token` header (matches the api's
 * SYNC_TRIGGER_TOKEN env var). Set the `INDEX_TRIGGER_TOKEN` Script Property.
 * Keep it in sync with the value deployed on the api.
 */
export function getIndexTriggerToken(): string {
  try {
    const v = PropertiesService.getScriptProperties().getProperty('INDEX_TRIGGER_TOKEN');
    if (v && v.trim().length > 0) return v.trim();
  } catch {
    // fall through
  }
  return '';
}

/** True only when both the api URL and the shared token are configured, so the
 *  end-of-batch index trigger can actually authenticate. */
export function isIndexTriggerConfigured(): boolean {
  return getFindMeApiUrl().length > 0 && getIndexTriggerToken().length > 0;
}

// ─── Drive folder names ───────────────────────────────────────────────────────

/** Name of the upload-prep root folder created at the SSOT root. */
export const UPLOAD_PREP_ROOT_NAME = '_UploadPrep';

/** Filename of the per-event manifest CSV inside each prep subfolder. */
export const MANIFEST_FILENAME = '_manifest.csv';

/** Filename of the global index CSV inside the _UploadPrep root folder. */
export const INDEX_FILENAME = '_index.csv';

// ─── Processing defaults ──────────────────────────────────────────────────────

/** Default JPEG quality for conversions (decision D4). */
export const JPG_QUALITY_DEFAULT = 92;

/**
 * Maximum files processed per Apps Script execution.
 * Keeps each `uploadPrep_runBatch` call well under the 6-minute GAS limit.
 * The sidebar loops this function until the batch is complete.
 */
export const BATCH_SIZE = 50;

// ─── Format policy (decision D12 / D13) ──────────────────────────────────────

/**
 * FORMAT_POLICY classifies every source file into one of three buckets:
 *   copy        — JPEGs: copy as-is via Drive files.copy (no re-encode)
 *   convert     — Raster images: send to Cloud Run for conversion
 *   convertByExt— RAW files (Drive often reports these as application/octet-stream)
 *   skip        — Videos, audio, docs, archives, Google-native files
 */
export const FORMAT_POLICY = {
  /** MIME types to copy directly (no conversion). */
  copy: new Set<string>(['image/jpeg']),

  /** MIME types to convert via Cloud Run. */
  convert: new Set<string>([
    'image/png',
    'image/heic',
    'image/heif',
    'image/tiff',
    'image/webp',
    'image/bmp',
    'image/avif',
    'image/gif',
  ]),

  /**
   * File extensions (lowercase, no dot prefix) that trigger Cloud Run conversion
   * even when Drive reports the MIME as 'application/octet-stream'.
   * Covers all RAW camera formats per decision D12.
   */
  convertByExt: new Set<string>([
    'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
  ]),

  /**
   * MIME type prefixes that always skip (video and audio files, decision D13).
   * Checked via String.startsWith before the per-extension list.
   */
  skipByPrefix: ['video/', 'audio/'] as const,

  /**
   * File extensions (lowercase, no dot prefix) that always skip, regardless of
   * MIME type.  Catches video containers Drive may mislabel as octet-stream.
   */
  skipByExt: new Set<string>([
    'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', '3gp', 'm4v',
    'mp3', 'wav', 'flac',
    'pdf', 'doc', 'docx', 'zip', 'rar', '7z',
  ]),
} as const;
