/**
 * userNameValidator.ts — single source of truth for character rules on
 * user-defined names that become Drive folder names (event names, tag names).
 *
 * Design goals:
 *   • Allow Unicode letters (CJK, Latin with diacritics, etc.) so members can
 *     name events in their own language.
 *   • Reject characters that are illegal in Google Drive folder names or that
 *     would break our folder-name parsers: / \ : * ? " < > | and control chars.
 *   • Keep the rules consistent across server-side validation, the folder-name
 *     builder, and the admin UI so users get the same error in every layer.
 *
 * Two flavours:
 *   • Event name  — free-form display string. Allows letters, digits, spaces.
 *                   Spaces are converted to underscores when building the folder
 *                   name (see folderNameValidator.buildLayer1FolderName).
 *   • Tag name    — already a folder segment label. Allows letters, digits,
 *                   underscore, hyphen — NO spaces (would create ambiguous
 *                   folder names). Used as a Drive subfolder name verbatim.
 *
 * NOTE: This module does NOT touch club normalizedName, Layer 3 batch folder
 * usernames, or photo file names. Those keep their existing ASCII-only rules
 * (see folderNameValidator.ts, inputValidator.isValidNormalizedName).
 */

/**
 * Characters that Google Drive disallows or that break our folder parsers.
 * Drive's documented illegal set: / \ : * ? " < > |
 * Plus control chars (\x00-\x1f and \x7f) which can render as broken names.
 */
export const DRIVE_ILLEGAL_CHARS_REGEX = /[/\\:*?"<>|\x00-\x1f\x7f]/;

/** Maximum length for an event name (after trim). Matches existing constant. */
export const MAX_EVENT_NAME_LENGTH = 100;

/** Maximum length for a tag name (after trim). Matches existing UI maxlength. */
export const MAX_TAG_NAME_LENGTH = 40;

/**
 * Allowed character set for event names:
 *   • Unicode letters (any script — English, Chinese, Japanese, Korean, etc.)
 *   • Unicode digits (any script)
 *   • Spaces (will be collapsed to underscores when building the folder name)
 *
 * The `u` flag enables \p{...} property escapes. Google Apps Script V8 runtime
 * supports these.
 */
const EVENT_NAME_ALLOWED_REGEX = /^[\p{L}\p{N} ]+$/u;

/**
 * Allowed character set for tag names:
 *   • Unicode letters
 *   • Unicode digits
 *   • Underscore and hyphen
 * NO spaces — tag is a folder segment, spaces would be confusing.
 */
const TAG_NAME_ALLOWED_REGEX = /^[\p{L}\p{N}_-]+$/u;

/** Result shape returned by every validator in this module. */
export interface NameValidationResult {
  isValid: boolean;
  /** Empty array on success; one or more human-readable error messages on failure. */
  errors: string[];
  /** The trimmed input — useful for callers that want to persist the cleaned-up value. */
  trimmed: string;
}

/**
 * Returns the unique, sorted set of disallowed characters present in the input.
 * Used to surface a specific, actionable error message ("invalid character: @").
 *
 * Drive-illegal chars are listed first; "other invalid" chars (anything not in
 * the allowed set, e.g. punctuation like ! or .) come second.
 */
function findDisallowedChars(input: string, allowedRegex: RegExp): string[] {
  const bad = new Set<string>();
  // Use Array.from to iterate by code point so surrogate pairs (e.g. some emoji)
  // are treated as a single character rather than two halves.
  for (const ch of Array.from(input)) {
    if (!allowedRegex.test(ch)) {
      bad.add(ch);
    }
  }
  return Array.from(bad).sort();
}

/**
 * Validates an event name.
 *
 * Rules:
 *   1. Required (non-empty after trim).
 *   2. ≤ MAX_EVENT_NAME_LENGTH characters after trim.
 *   3. May contain only Unicode letters, Unicode digits, and ASCII spaces.
 *   4. Disallowed characters are listed in the error message so the user knows
 *      exactly what to remove.
 *
 * @example
 *   validateEventName('NYC Marathon')      → { isValid: true, ... }
 *   validateEventName('湘舍动 公益跑')      → { isValid: true, ... }
 *   validateEventName('Half-Marathon')     → { isValid: false, errors: ['... "-" ...'] }
 *   validateEventName('NYC/Marathon')      → { isValid: false, errors: ['... "/" ...'] }
 *   validateEventName('')                  → { isValid: false, errors: ['Event name is required'] }
 */
export function validateEventName(raw: unknown): NameValidationResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const errors: string[] = [];

  if (!trimmed) {
    return { isValid: false, errors: ['Event name is required.'], trimmed: '' };
  }

  if (trimmed.length > MAX_EVENT_NAME_LENGTH) {
    errors.push(
      `Event name must be ${MAX_EVENT_NAME_LENGTH} characters or fewer ` +
      `(currently ${trimmed.length}).`
    );
  }

  // Single-character regex used per-codepoint
  const allowedSingleChar = /^[\p{L}\p{N} ]$/u;
  if (!EVENT_NAME_ALLOWED_REGEX.test(trimmed)) {
    const bad = findDisallowedChars(trimmed, allowedSingleChar);
    errors.push(
      `Event name may only contain letters (any language, e.g. English or Chinese), ` +
      `digits, and spaces. Disallowed character(s) found: ${bad.map((c) => `"${c}"`).join(' ')}. ` +
      `Please remove or replace ${bad.length === 1 ? 'it' : 'them'}.`
    );
  }

  return { isValid: errors.length === 0, errors, trimmed };
}

/**
 * Validates a tag name (used as a Drive subfolder segment under
 * Event / Club / <tag> / batch_folders / files).
 *
 * Rules:
 *   1. Required (non-empty after trim) — empty/undefined is handled by callers
 *      that substitute the DEFAULT_TAG ('ALL'), so this validator is only
 *      called when the user explicitly typed a tag.
 *   2. ≤ MAX_TAG_NAME_LENGTH characters after trim.
 *   3. May contain only Unicode letters, Unicode digits, underscore, hyphen.
 *      No spaces (would create ambiguous folder names like "finish line").
 *
 * @example
 *   validateTagName('finish_line')         → { isValid: true, ... }
 *   validateTagName('终点线')                → { isValid: true, ... }
 *   validateTagName('mile-10')             → { isValid: true, ... }
 *   validateTagName('finish line')         → { isValid: false, errors: ['... " " ...'] }
 *   validateTagName('finish/line')         → { isValid: false, errors: ['... "/" ...'] }
 */
export function validateTagName(raw: unknown): NameValidationResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const errors: string[] = [];

  if (!trimmed) {
    return { isValid: false, errors: ['Tag name is required.'], trimmed: '' };
  }

  if (trimmed.length > MAX_TAG_NAME_LENGTH) {
    errors.push(
      `Tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer ` +
      `(currently ${trimmed.length}).`
    );
  }

  const allowedSingleChar = /^[\p{L}\p{N}_-]$/u;
  if (!TAG_NAME_ALLOWED_REGEX.test(trimmed)) {
    const bad = findDisallowedChars(trimmed, allowedSingleChar);
    // Re-label the space character so the error is unambiguous in the UI.
    const labelled = bad.map((c) => (c === ' ' ? '" " (space)' : `"${c}"`));
    errors.push(
      `Tag name may only contain letters (any language, e.g. English or Chinese), ` +
      `digits, underscore (_), and hyphen (-). No spaces or other punctuation. ` +
      `Disallowed character(s) found: ${labelled.join(' ')}.`
    );
  }

  return { isValid: errors.length === 0, errors, trimmed };
}
