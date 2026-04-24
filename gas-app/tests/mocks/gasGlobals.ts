/**
 * GAS Global Mocks — loaded before every test suite via jest.config setupFiles.
 *
 * Establishes all Google Apps Script global APIs used by the application
 * as Jest mock functions. Tests can override individual mocks using
 * jest.spyOn() or mockReturnValue() for specific scenarios.
 *
 * Architecture:
 *   - Each GAS service is a jest.fn() object with mocked methods
 *   - Default mock data represents a minimal valid database state:
 *       Users sheet: 1 admin + 1 active user + 1 inactive user
 *   - Tests that need different data call setupSheetData() helper
 */

// ─── Default test data ────────────────────────────────────────────────────────

export const TEST_ADMIN_EMAIL      = 'admin@mmrunners.org';
export const TEST_CLUB_ADMIN_EMAIL = 'club-admin@example.com';
export const TEST_USER_EMAIL       = 'user1@example.com'; // kept for backward compat (same as club admin)
export const TEST_INACTIVE_EMAIL   = 'inactive@example.com';
export const TEST_SPREADSHEET_ID   = 'mock-spreadsheet-id-12345';
export const TEST_ROOT_FOLDER_ID   = 'mock-root-folder-id-67890';

/**
 * Default Users sheet rows (header excluded).
 * New 9-column schema: email | firstName | lastName | role | status | clubId | addedDate | addedBy | lastLoginAt
 */
// Schema: email(0) firstName(1) lastName(2) role(3) clubId(4)
//         notify_new_events(5) notify_daily_digest(6) status(7)
//         added_date(8) added_by(9) last_login_at(10)
export const DEFAULT_USERS_ROWS: unknown[][] = [
  // super admin — no clubId
  [TEST_ADMIN_EMAIL,      'Test', 'Admin',    'super_admin', '',        '', '', 'active',   '2025-01-01', 'system',         ''],
  // club admin — scoped to New_Bee
  [TEST_USER_EMAIL,       'Test', 'User',     'club_admin',  'New_Bee', '', '', 'active',   '2025-02-01', TEST_ADMIN_EMAIL, ''],
  // inactive club admin
  [TEST_INACTIVE_EMAIL,   'Test', 'Inactive', 'club_admin',  'Nankai',  '', '', 'inactive', '2025-01-15', TEST_ADMIN_EMAIL, ''],
];

/** Default Events sheet rows — 3 events for sort/pagination/duplicate testing */
export const DEFAULT_EVENTS_ROWS: unknown[][] = [
  [
    'evt-uuid-001', 'NYC Marathon', '2025-11-03',
    '2025-11-03_NYC_Marathon', 'drive-folder-id-001',
    TEST_ADMIN_EMAIL, '2025-10-01T09:00:00.000Z',
  ],
  [
    'evt-uuid-002', 'Boston Marathon', '2025-04-21',
    '2025-04-21_Boston_Marathon', 'drive-folder-id-002',
    TEST_ADMIN_EMAIL, '2025-03-01T09:00:00.000Z',
  ],
  [
    'evt-uuid-003', 'Christmas Fun Run', '2025-12-25',
    '2025-12-25_Christmas_Fun_Run', 'drive-folder-id-003',
    TEST_ADMIN_EMAIL, '2025-12-01T14:00:00.000Z',
  ],
];

// ─── Mock factories ───────────────────────────────────────────────────────────

/** Creates a fresh mock sheet with configurable row data */
export function createMockSheet(rows: unknown[][] = []): jest.Mocked<{
  getLastRow: () => number;
  getLastColumn: () => number;
  getRange: (r: number, c: number, nr?: number, nc?: number) => { getValues: () => unknown[][]; setValues: (v: unknown[][]) => void };
  appendRow: (row: unknown[]) => void;
}> {
  const mockSetValues = jest.fn();
  return {
    getLastRow: jest.fn().mockReturnValue(rows.length + 1), // +1 for header
    getLastColumn: jest.fn().mockReturnValue(rows[0]?.length ?? 6),
    getRange: jest.fn().mockImplementation(
      (_r: number, _c: number, numRows?: number, numCols?: number) => ({
        getValues: jest.fn().mockReturnValue(
          numRows ? rows.slice(0, numRows) : [[...Array(numCols ?? 1).fill('')]]
        ),
        setValues: mockSetValues,
      })
    ),
    appendRow: jest.fn(),
  };
}

/** Default Audit_Log sheet rows for tests that need pre-existing audit entries */
export const DEFAULT_AUDIT_ROWS: unknown[][] = [
  [
    'audit-uuid-001', '2026-04-18T10:00:00.000Z', TEST_ADMIN_EMAIL,
    'USER_CREATED', 'user', 'newuser@example.com',
    '{"email":"newuser@example.com","clubId":"New_Bee","role":"club_admin"}',
  ],
  [
    'audit-uuid-002', '2026-04-17T08:30:00.000Z', TEST_ADMIN_EMAIL,
    'EVENT_CREATED', 'event', 'evt-uuid-999',
    '{"eventName":"Spring Race","eventDate":"2026-05-01"}',
  ],
  [
    'audit-uuid-003', '2026-04-16T14:00:00.000Z', TEST_ADMIN_EMAIL,
    'CLUB_DEACTIVATED', 'club', 'Old_Club',
    '{"normalizedName":"Old_Club"}',
  ],
];

/** Default Email_Preferences sheet rows for tests that need pre-existing preferences */
export const DEFAULT_EMAIL_PREFERENCES_ROWS: unknown[][] = [
  [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
];

/** Active mock sheet instances — tests can access these to verify calls */
export const mockSheets: Record<string, ReturnType<typeof createMockSheet>> = {
  Users:              createMockSheet(DEFAULT_USERS_ROWS),
  Events:             createMockSheet(DEFAULT_EVENTS_ROWS),
  Upload_Log:         createMockSheet([]),
  Upload_Links:       createMockSheet([]),
  Rate_Limit:         createMockSheet([]),
  Audit_Log:          createMockSheet([]),
  Email_Preferences:  createMockSheet(DEFAULT_EMAIL_PREFERENCES_ROWS),
  Deleted_Files:      createMockSheet([]),
};

/** Resets all mock sheets to their default data */
export function resetMockSheets(): void {
  Object.assign(mockSheets, {
    Users:              createMockSheet(DEFAULT_USERS_ROWS),
    Events:             createMockSheet(DEFAULT_EVENTS_ROWS),
    Upload_Log:         createMockSheet([]),
    Upload_Links:       createMockSheet([]),
    Rate_Limit:         createMockSheet([]),
    Audit_Log:          createMockSheet([]),
    Email_Preferences:  createMockSheet(DEFAULT_EMAIL_PREFERENCES_ROWS),
    Deleted_Files:      createMockSheet([]),
  });
  resetMockMailApp();
  resetMockScriptApp();
}

// ─── Mock SpreadsheetApp ──────────────────────────────────────────────────────

export const mockSpreadsheet = {
  getSheetByName: jest.fn().mockImplementation((name: string) => {
    return mockSheets[name] ?? null;
  }),
};

const mockSpreadsheetApp = {
  openById: jest.fn().mockReturnValue(mockSpreadsheet),
};

// ─── Mock Session ─────────────────────────────────────────────────────────────

const mockActiveUser = {
  getEmail: jest.fn().mockReturnValue(TEST_ADMIN_EMAIL),
};

const mockSession = {
  getActiveUser:      jest.fn().mockReturnValue(mockActiveUser),
  getEffectiveUser:   jest.fn().mockReturnValue(mockActiveUser),
};

/** Helper: set the "currently logged in" user for a test (affects both getActiveUser and getEffectiveUser). */
export function setMockUser(email: string): void {
  mockActiveUser.getEmail.mockReturnValue(email);
}

// ─── Mock PropertiesService ───────────────────────────────────────────────────

const mockProperties: Record<string, string> = {
  ROOT_FOLDER_ID: TEST_ROOT_FOLDER_ID,
  SPREADSHEET_ID: TEST_SPREADSHEET_ID,
};

/** Initial (seed) values for mockProperties — used by resetMockScriptProperties(). */
const INITIAL_MOCK_PROPERTIES: Record<string, string> = {
  ROOT_FOLDER_ID: TEST_ROOT_FOLDER_ID,
  SPREADSHEET_ID: TEST_SPREADSHEET_ID,
};

const mockScriptProperties = {
  getProperty: jest.fn().mockImplementation((key: string) => mockProperties[key] ?? null),
  setProperty: jest.fn().mockImplementation((key: string, value: string) => {
    mockProperties[key] = value;
  }),
  deleteProperty: jest.fn().mockImplementation((key: string) => {
    delete mockProperties[key];
  }),
};

const mockPropertiesService = {
  getScriptProperties: jest.fn().mockReturnValue(mockScriptProperties),
};

/**
 * Resets mockProperties to its initial seed values, clearing any keys added
 * during a test (e.g. Drive tree cache entries written by getEventDriveTree).
 * Call in beforeEach for tests that write to ScriptProperties.
 */
export function resetMockScriptProperties(): void {
  for (const key of Object.keys(mockProperties)) {
    delete mockProperties[key];
  }
  Object.assign(mockProperties, INITIAL_MOCK_PROPERTIES);
}

// ─── Mock DriveApp ────────────────────────────────────────────────────────────

/** Mock file object returned by folder.createFile() */
export function makeMockDriveFile(name: string, id: string, size = 1024) {
  return {
    getId: jest.fn().mockReturnValue(id),
    getName: jest.fn().mockReturnValue(name),
    getSize: jest.fn().mockReturnValue(size),
    getLastUpdated: jest.fn().mockReturnValue(new Date('2025-11-03T10:00:00Z')),
  };
}

export const mockFolder = {
  getId: jest.fn().mockReturnValue('mock-folder-id'),
  getName: jest.fn().mockReturnValue('Test_Folder'),
  createFolder: jest.fn().mockImplementation((name: string) => ({
    getId: jest.fn().mockReturnValue(`new-folder-${name}`),
    getName: jest.fn().mockReturnValue(name),
  })),
  createFile: jest.fn().mockImplementation((blob: { getName?: () => string }) => {
    const name = blob && typeof blob.getName === 'function' ? blob.getName() : 'uploaded-file';
    return makeMockDriveFile(name, `file-${name}-id`);
  }),
  getFolders: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
  getFoldersByName: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
  getFiles: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
};

/** Reusable mock file returned by DriveApp.getFileById(). Supports setTrashed(). */
export const mockDriveFile = {
  getId:      jest.fn().mockReturnValue('mock-file-id'),
  getName:    jest.fn().mockReturnValue('mock-file.jpg'),
  getSize:    jest.fn().mockReturnValue(204800),
  setTrashed: jest.fn(),
};

const mockDriveApp = {
  getFolderById: jest.fn().mockReturnValue(mockFolder),
  getRootFolder: jest.fn().mockReturnValue(mockFolder),
  getFileById:   jest.fn().mockReturnValue(mockDriveFile),
};

// ─── Mock Utilities ───────────────────────────────────────────────────────────

let _uuidCounter = 0;
const mockUtilities = {
  getUuid: jest.fn().mockImplementation(
    () => `00000000-0000-4000-8000-${String(_uuidCounter++).padStart(12, '0')}`
  ),
  /**
   * base64Decode mock — returns a minimal byte array.
   * Tests that exercise actual content should provide their own mock value.
   */
  base64Decode: jest.fn().mockReturnValue(new Uint8Array([0x00])),
  /**
   * base64EncodeWebSafe mock — returns a fixed short token string.
   * Used by uploadLinkService.generateToken().
   */
  base64EncodeWebSafe: jest.fn().mockReturnValue('mock-token-base64url'),
  /**
   * newBlob mock — returns a minimal object shaped like a GAS Blob.
   * The createFile mock on mockFolder reads `.getName()` from this.
   */
  newBlob: jest.fn().mockImplementation(
    (_bytes: unknown, mimeType: string, name: string) => ({
      getName: jest.fn().mockReturnValue(name),
      getContentType: jest.fn().mockReturnValue(mimeType),
      getBytes: jest.fn().mockReturnValue([]),
    })
  ),
};

/** Resets UUID counter for deterministic testing */
export function resetUuidCounter(): void {
  _uuidCounter = 0;
}

// ─── Mock ContentService ──────────────────────────────────────────────────────

const mockTextOutput = {
  setMimeType: jest.fn().mockReturnThis(),
};

const mockContentService = {
  createTextOutput: jest.fn().mockReturnValue(mockTextOutput),
  MimeType: { JSON: 'application/json' },
};

// ─── Mock HtmlService ─────────────────────────────────────────────────────────

const mockHtmlOutput = {
  setTitle: jest.fn().mockReturnThis(),
  setXFrameOptionsMode: jest.fn().mockReturnThis(),
};

export const mockHtmlTemplate = {
  evaluate: jest.fn().mockReturnValue(mockHtmlOutput),
};

const mockHtmlService = {
  createTemplateFromFile: jest.fn().mockReturnValue(mockHtmlTemplate),
  createHtmlOutput: jest.fn().mockReturnValue(mockHtmlOutput),
  XFrameOptionsMode: { DENY: 'DENY', ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
};

// ─── Mock Logger ──────────────────────────────────────────────────────────────

const mockLogger = {
  log: jest.fn(),
};

// ─── Mock MailApp ─────────────────────────────────────────────────────────────

let _mockRemainingQuota = 100;

const mockMailApp = {
  sendEmail: jest.fn(),
  getRemainingDailyQuota: jest.fn().mockImplementation(() => _mockRemainingQuota),
};

/** Helper: reset MailApp mocks and restore quota to 100 */
export function resetMockMailApp(): void {
  mockMailApp.sendEmail.mockClear();
  mockMailApp.getRemainingDailyQuota.mockClear();
  _mockRemainingQuota = 100;
}

/** Helper: set the mock daily quota (for testing quota exhaustion) */
export function setMockMailAppQuota(quota: number): void {
  _mockRemainingQuota = quota;
}

// ─── Mock CacheService ────────────────────────────────────────────────────────

/** In-memory store backing the script cache mock */
const _cacheStore: Record<string, string> = {};

export const mockScriptCache = {
  put:    jest.fn().mockImplementation((key: string, value: string) => { _cacheStore[key] = value; }),
  get:    jest.fn().mockImplementation((key: string) => _cacheStore[key] ?? null),
  remove: jest.fn().mockImplementation((key: string) => { delete _cacheStore[key]; }),
};

export const mockCacheService = {
  getScriptCache: jest.fn().mockReturnValue(mockScriptCache),
};

/** Clears all cached entries between tests */
export function resetMockCache(): void {
  Object.keys(_cacheStore).forEach(k => delete _cacheStore[k]);
  mockScriptCache.put.mockClear();
  mockScriptCache.get.mockClear();
  mockScriptCache.remove.mockClear();
}

// ─── Mock ScriptApp ───────────────────────────────────────────────────────────

/** Module-level storage for installed triggers (populated by newTrigger builder) */
export const mockInstalledTriggers: Array<{
  handlerName: string;
  schedule: string;
}> = [];

/**
 * Mock trigger builder — chainable interface for defining schedules.
 * Returns a builder that records the handler name and schedule on create().
 */
function makeMockTriggerBuilder(handlerName: string) {
  return {
    timeBased: jest.fn().mockReturnThis(),
    everyDays: jest.fn().mockImplementation((n: number) => ({
      atHour: jest.fn().mockReturnValue({
        create: jest.fn().mockImplementation(() => {
          mockInstalledTriggers.push({ handlerName, schedule: `everyDays(${n})@hour(7)` });
          return { getHandlerFunction: jest.fn().mockReturnValue(handlerName) };
        }),
      }),
    })),
    onWeekDay: jest.fn().mockImplementation((day: string) => ({
      atHour: jest.fn().mockReturnValue({
        create: jest.fn().mockImplementation(() => {
          mockInstalledTriggers.push({ handlerName, schedule: `onWeekDay(${day})@hour(7)` });
          return { getHandlerFunction: jest.fn().mockReturnValue(handlerName) };
        }),
      }),
    })),
  };
}

const mockScriptApp = {
  getOAuthToken: jest.fn().mockReturnValue('mock-oauth-access-token'),
  newTrigger: jest.fn().mockImplementation((name: string) => makeMockTriggerBuilder(name)),
  getProjectTriggers: jest.fn().mockImplementation(() =>
    mockInstalledTriggers.map(t => ({
      getHandlerFunction: jest.fn().mockReturnValue(t.handlerName),
      getEventType: jest.fn().mockReturnValue('ON_TIME_INTERVAL'),
    }))
  ),
  deleteTrigger: jest.fn().mockImplementation((_trigger: unknown) => {
    // Just clear the installed triggers for simplicity in tests
    mockInstalledTriggers.length = 0;
  }),
  getService: jest.fn().mockReturnValue({
    getUrl: jest.fn().mockReturnValue('https://script.google.com/macros/s/mock-deploy-id/exec'),
  }),
  WeekDay: {
    MONDAY: 'MONDAY',
    TUESDAY: 'TUESDAY',
    WEDNESDAY: 'WEDNESDAY',
    THURSDAY: 'THURSDAY',
    FRIDAY: 'FRIDAY',
    SATURDAY: 'SATURDAY',
    SUNDAY: 'SUNDAY',
  },
};

/** Helper: reset ScriptApp mocks */
export function resetMockScriptApp(): void {
  mockInstalledTriggers.length = 0;
  mockScriptApp.newTrigger.mockClear();
  mockScriptApp.getProjectTriggers.mockClear();
  mockScriptApp.deleteTrigger.mockClear();
}

// ─── Email Preferences sheet fixture ───────────────────────────────────────────

/** Helper: install a mock Email_Preferences sheet */
export function setupEmailPreferencesSheet(rows: unknown[][] = DEFAULT_EMAIL_PREFERENCES_ROWS): void {
  mockSheets.Email_Preferences = createMockSheet(rows);
}

// ─── Install globals ──────────────────────────────────────────────────────────

const g = global as Record<string, unknown>;
g['Session']             = mockSession;
g['SpreadsheetApp']      = mockSpreadsheetApp;
g['PropertiesService']   = mockPropertiesService;
g['DriveApp']            = mockDriveApp;
g['Utilities']           = mockUtilities;
g['ContentService']      = mockContentService;
g['HtmlService']         = mockHtmlService;
g['Logger']              = mockLogger;
g['MailApp']             = mockMailApp;
g['CacheService']        = mockCacheService;
g['ScriptApp']           = mockScriptApp;

// ─── Exports for use in test files ───────────────────────────────────────────

export {
  mockSession,
  mockActiveUser,
  mockSpreadsheetApp,
  mockScriptProperties,
  mockPropertiesService,
  // resetMockScriptProperties is exported as a named export (see declaration above)
  mockDriveApp,
  mockUtilities,
  mockContentService,
  mockHtmlService,
  mockLogger,
  mockMailApp,
  mockScriptApp,
  // The following are exported as named exports (see declarations above):
  // - makeMockDriveFile
  // - mockSpreadsheet
  // - mockCacheService, mockScriptCache, resetMockCache
  // - mockScriptApp, resetMockScriptApp, mockInstalledTriggers
  // - DEFAULT_EMAIL_PREFERENCES_ROWS, setupEmailPreferencesSheet
  // - setMockMailAppQuota, resetMockMailApp
};
