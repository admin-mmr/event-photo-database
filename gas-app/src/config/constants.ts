import { PhotoMimeType } from '../types/enums';
import { AppConfig, SheetColumnMap } from '../types/config';
import { ClubEntry } from '../types/models';

// ─── Event configuration ──────────────────────────────────────────────────────

/** Maximum characters for an event name before folder name generation */
export const MAX_EVENT_NAME_LENGTH = 100;

/** Characters allowed in event names (pre-underscore conversion) */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9\s]+$/;

/** Default page size for event listing */
export const DEFAULT_EVENT_PAGE_SIZE = 20;

/** Maximum page size to prevent abuse */
export const MAX_EVENT_PAGE_SIZE = 100;

// ─── Club configuration ───────────────────────────────────────────────────────

/**
 * Approved running clubs.
 * displayName is shown in the UI; normalizedName is used as the Drive folder name.
 * To add a new club: append here and update the Drive folder if it already exists.
 */
export const APPROVED_CLUBS: ReadonlyArray<ClubEntry> = [
  { displayName: 'New Bee',        normalizedName: 'New_Bee' },
  { displayName: 'Misty Mountain', normalizedName: 'Misty_Mountain' },
  { displayName: 'Nankai',         normalizedName: 'Nankai' },
  { displayName: 'Admin',          normalizedName: 'Admin' },
];

/**
 * Column indices (0-based) for every sheet.
 * These match the column order defined in the project plan.
 * Changing column order in a sheet requires updating only this constant.
 */
export const COLUMNS: SheetColumnMap = {
  USERS: {
    EMAIL: 0,
    RUNNING_CLUB: 1,
    ROLE: 2,
    STATUS: 3,
    ADDED_DATE: 4,
    ADDED_BY: 5,
  },
  EVENTS: {
    EVENT_ID: 0,
    EVENT_NAME: 1,
    EVENT_DATE: 2,
    FOLDER_NAME: 3,
    DRIVE_FOLDER_ID: 4,
    CREATED_BY: 5,
    CREATED_AT: 6,
  },
  UPLOAD_LOG: {
    LOG_ID: 0,
    EVENT_ID: 1,
    CLUB_NAME: 2,
    UPLOADED_BY: 3,
    BATCH_FOLDER_NAME: 4,
    BATCH_FOLDER_ID: 5,
    FILE_COUNT: 6,
    TOTAL_SIZE_MB: 7,
    SKIPPED_DUPLICATES: 8,
    SKIPPED_NON_PHOTO: 9,
    UPLOAD_TIMESTAMP: 10,
    SOURCE: 11,
  },
};

/**
 * Builds the runtime AppConfig by reading sensitive IDs from GAS Script Properties.
 *
 * HOW TO SET PROPERTIES:
 *   In the GAS editor: Extensions → Apps Script → Project Settings → Script Properties
 *   Add: ROOT_FOLDER_ID = <your Drive folder ID>
 *        SPREADSHEET_ID = <your Sheets ID>
 *
 * Call getConfig() at the start of any request handler — never at module load time,
 * since PropertiesService is unavailable during clasp type-checking.
 */
export function getConfig(): AppConfig {
  /* global PropertiesService */
  const props = PropertiesService.getScriptProperties();

  const rootFolderId = props.getProperty('ROOT_FOLDER_ID');
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');

  if (!rootFolderId || !spreadsheetId) {
    throw new Error(
      'Missing Script Properties: ROOT_FOLDER_ID and SPREADSHEET_ID must be set. ' +
      'Go to Extensions → Apps Script → Project Settings → Script Properties.'
    );
  }

  return {
    ROOT_FOLDER_ID: rootFolderId,
    SPREADSHEET_ID: spreadsheetId,
    SHEET_NAMES: {
      USERS: 'Users',
      EVENTS: 'Events',
      UPLOAD_LOG: 'Upload_Log',
    },
    APPROVED_CLUBS,
    PHOTO_MIME_TYPES: [PhotoMimeType.JPEG, PhotoMimeType.PNG, PhotoMimeType.HEIC],
    MAX_FILE_SIZE_MB: 50,   // GAS hard limit per UrlFetch payload
    MAX_BATCH_SIZE_MB: 200, // Soft limit per upload session to avoid timeouts
  };
}
