import { FolderLayer } from '../types/enums';
import { FolderValidationResult } from '../types/responses';
import { ValidateFolderNameInput } from '../types/requests';

/**
 * Folder name validator — enforces Drive naming conventions for Layers 1–3.
 *
 * Layer 1: YYYY-MM-DD_Title_Case_Name
 *   - Date prefix must be a real calendar date
 *   - Each word after the date must start with an uppercase letter
 *   - Words separated by underscores only (no spaces, no special chars)
 *
 * Layer 2: ClubName
 *   - Must start with a letter (uppercase or lowercase)
 *   - Words separated by underscores
 *   - Must match an approved club normalizedName (enforced separately by caller)
 *
 * Layer 3: YYYYMMDD-HHMMSS_username  (auto-generated — included for completeness)
 *   - Compact date-time prefix
 *   - Username must start with a letter, all lowercase
 */

/** Layer 1: YYYY-MM-DD_TitleCase_Words */
const LAYER1_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(_[A-Z][A-Za-z0-9]+)+$/;

/** Layer 2: Words_Separated_By_Underscores, starting with letter */
const LAYER2_REGEX = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z][A-Za-z0-9]*)*$/;

/** Layer 3: YYYYMMDD-HHMMSS_lowercase_username */
const LAYER3_REGEX = /^\d{8}-\d{6}_[a-z][a-z0-9._-]*$/;

/**
 * Validates whether a date portion of a Layer 1 folder name is a real calendar date.
 * Catches impossible dates like Feb 30 or month 13.
 */
function isRealDate(folderName: string): boolean {
  const match = folderName.match(/^(\d{4})-(\d{2})-(\d{2})_/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1; // 0-based for Date constructor
  const day = Number(match[3]);
  const d = new Date(year, month, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month &&
    d.getDate() === day
  );
}

/**
 * Validates a folder name against the rules for the specified layer.
 * Returns a FolderValidationResult with isValid, normalizedName, and any violations.
 *
 * @example
 *   validateFolderName({ folderName: '2025-11-03_NYC_Marathon', layer: 1 })
 *   // → { isValid: true, normalizedName: '2025-11-03_NYC_Marathon', violations: [] }
 *
 *   validateFolderName({ folderName: 'nyc marathon', layer: 1 })
 *   // → { isValid: false, violations: ['Layer 1 folder must match YYYY-MM-DD_Title_Case_Name'] }
 */
export function validateFolderName(input: ValidateFolderNameInput): FolderValidationResult {
  const folderName = input.folderName.trim();
  const violations: string[] = [];

  switch (input.layer as FolderLayer) {
    case 1:
      if (!LAYER1_REGEX.test(folderName)) {
        violations.push(
          'Layer 1 folder must match YYYY-MM-DD_Title_Case_Name ' +
          '(e.g. 2025-11-03_NYC_Marathon). ' +
          'Words must start with uppercase and be separated by underscores.'
        );
      } else if (!isRealDate(folderName)) {
        violations.push('The date portion is not a valid calendar date.');
      }
      break;

    case 2:
      if (!LAYER2_REGEX.test(folderName)) {
        violations.push(
          'Layer 2 folder must be a valid club name identifier ' +
          '(e.g. New_Bee). ' +
          'Must start with a letter; words separated by underscores.'
        );
      }
      break;

    case 3:
      if (!LAYER3_REGEX.test(folderName)) {
        violations.push(
          'Layer 3 folder must match YYYYMMDD-HHMMSS_username ' +
          '(e.g. 20251103-093500_cathylin). ' +
          'Username must be all lowercase and start with a letter.'
        );
      }
      break;

    default: {
      const _exhaustiveCheck: never = input.layer as never;
      violations.push(`Unknown folder layer: ${String(_exhaustiveCheck)}`);
    }
  }

  return {
    isValid: violations.length === 0,
    normalizedName: folderName,
    violations,
  };
}

/**
 * Builds a valid Layer 1 folder name from components, or returns null if inputs are invalid.
 *
 * @param isoDate   "YYYY-MM-DD"
 * @param eventName User-provided event name (will be Title_Cased and sanitized)
 */
export function buildLayer1FolderName(isoDate: string, eventName: string): string | null {
  // Sanitize: trim, replace spaces/dashes/special chars with underscores, Title_Case each word
  const words = eventName
    .trim()
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  if (words.length === 0) return null;

  const candidate = `${isoDate}_${words.join('_')}`;
  const result = validateFolderName({ folderName: candidate, layer: 1 });
  return result.isValid ? candidate : null;
}

/**
 * Builds a valid Layer 3 batch folder name.
 *
 * @param batchTimestamp  "YYYYMMDD-HHMMSS" (from dateFormatter.toBatchTimestamp)
 * @param username        User's email local part, lowercased
 */
export function buildLayer3FolderName(batchTimestamp: string, username: string): string {
  const safeUsername = username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${batchTimestamp}_${safeUsername}`;
}
