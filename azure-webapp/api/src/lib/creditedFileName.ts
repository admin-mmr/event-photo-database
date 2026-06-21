/**
 * creditedFileName.ts — Builds a filename of the form
 *
 *     <ClubShortName>_<Photographer>_<originalFileName>
 *
 * Ported (pure TS, no GAS deps) from gas-app/src/utils/creditedFileName so the
 * cloud-webapp volunteer-upload handoff credits photos exactly like the legacy
 * Apps Script flow. In the GCS-first flow the uploaded bytes reach the server,
 * so the rename happens server-side in volunteerUploadService rather than in
 * the browser.
 *
 * Why this exists: Google Photos does not surface EXIF "Artist" / IPTC "By-line"
 * in album views, so the only viewer-visible per-photo credit we control is the
 * filename. See Photographer_Credit_Implementation_Plan.docx §3.
 *
 * Design rules:
 *   1. `clubShortName` and `photographerName` are sanitised to a safe character
 *      class: Unicode letters/digits kept (Drive accepts UTF-8), path-illegal
 *      characters / control chars / whitespace stripped (spaces collapse so
 *      "Jane Doe" -> "JaneDoe").
 *   2. Idempotent: if the original already begins with the assembled prefix we
 *      do NOT stack it again.
 *   3. Capped at `maxLength` (default 240) under Drive's 255 limit, preserving
 *      the extension when truncating.
 *   4. Blank photographer -> `fallbackName`; both blank -> `<Club>_` prefix only.
 *   5. Blank club -> no prefix, just a sanitised original filename.
 */

export interface CreditedFileNameInput {
  /** Short club identifier — e.g. "MMR", "湘舍动". May be empty. */
  clubShortName: string;
  /** Photographer's typed name. May be empty if `fallbackName` is provided. */
  photographerName: string;
  /** Original filename from the browser (file.name). Required. */
  originalFileName: string;
  /** Used in place of `photographerName` when that field is empty. */
  fallbackName?: string;
  /** Total length cap. Defaults to 240; values <= 0 fall back to 240. */
  maxLength?: number;
}

/** Characters Drive / Windows / POSIX disallow in filenames. */
const PATH_ILLEGAL = /[/\\:*?"<>|]/g;

/** ASCII control characters (U+0000–U+001F plus DEL U+007F). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Max length of either prefix component before it is truncated. */
const MAX_COMPONENT_LENGTH = 40;

/** Default cap on total filename length. Drive's hard limit is 255. */
const DEFAULT_MAX_LENGTH = 240;

/**
 * Builds a credited filename per the rules in the file header.
 *
 * @example buildCreditedFileName({ clubShortName: 'MMR', photographerName: 'Jane Doe',
 *   originalFileName: 'IMG_4231.JPG' }) === 'MMR_JaneDoe_IMG_4231.JPG'
 */
export function buildCreditedFileName(input: CreditedFileNameInput): string {
  const max = input.maxLength && input.maxLength > 0 ? input.maxLength : DEFAULT_MAX_LENGTH;

  const club = sanitiseComponent(input.clubShortName);
  const namePrimary = sanitiseComponent(input.photographerName);
  const nameFallback = sanitiseComponent(input.fallbackName ?? '');
  const name = namePrimary || nameFallback;

  let prefix = '';
  if (club && name) prefix = `${club}_${name}_`;
  else if (club) prefix = `${club}_`;
  else if (name) prefix = `${name}_`;

  const cleanOriginal = stripIllegal(input.originalFileName);

  // Idempotency: do not double-prefix an already-credited file.
  if (prefix && cleanOriginal.startsWith(prefix)) {
    return truncatePreservingExtension(cleanOriginal, max);
  }
  return truncatePreservingExtension(prefix + cleanOriginal, max);
}

/**
 * Cleans a single prefix component (club or photographer name): NFC-normalise,
 * strip control + path-illegal chars, collapse whitespace, cap length.
 */
export function sanitiseComponent(raw: string): string {
  if (!raw) return '';
  return raw
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(PATH_ILLEGAL, '')
    .replace(/\s+/g, '')
    .slice(0, MAX_COMPONENT_LENGTH);
}

/**
 * Replaces path-illegal characters in the original filename with underscores
 * (keeps the name recognisable); strips control chars; collapses whitespace
 * runs to a single underscore.
 */
export function stripIllegal(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(PATH_ILLEGAL, '_')
    .replace(/\s+/g, '_');
}

/**
 * Truncates `raw` to at most `max` characters, preserving the file extension
 * if one is present (the last `.xxx` segment of up to 8 characters).
 */
export function truncatePreservingExtension(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0 || raw.length - lastDot > 9) {
    return raw.slice(0, max);
  }
  const ext = raw.slice(lastDot);
  const stemBudget = max - ext.length;
  if (stemBudget <= 0) return raw.slice(0, max);
  return raw.slice(0, stemBudget) + ext;
}
