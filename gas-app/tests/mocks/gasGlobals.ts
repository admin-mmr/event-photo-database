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

export const TEST_ADMIN_EMAIL = 'admin@mmrunners.org';
export const TEST_USER_EMAIL  = 'user1@example.com';
export const TEST_INACTIVE_EMAIL = 'inactive@example.com';
export const TEST_SPREADSHEET_ID = 'mock-spreadsheet-id-12345';
export const TEST_ROOT_FOLDER_ID = 'mock-root-folder-id-67890';

/** Default Users sheet rows (header excluded) */
export const DEFAULT_USERS_ROWS: unknown[][] = [
  [TEST_ADMIN_EMAIL,    'Admin',      'admin', 'active',   '2025-01-01', 'system'],
  [TEST_USER_EMAIL,     'New_Bee',    'user',  'active',   '2025-02-01', TEST_ADMIN_EMAIL],
  [TEST_INACTIVE_EMAIL, 'Nankai',     'user',  'inactive', '2025-01-15', TEST_ADMIN_EMAIL],
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

/** Active mock sheet instances — tests can access these to verify calls */
export const mockSheets: Record<string, ReturnType<typeof createMockSheet>> = {
  Users:      createMockSheet(DEFAULT_USERS_ROWS),
  Events:     createMockSheet(DEFAULT_EVENTS_ROWS),
  Upload_Log: createMockSheet([]),
};

/** Resets all mock sheets to their default data */
export function resetMockSheets(): void {
  Object.assign(mockSheets, {
    Users:      createMockSheet(DEFAULT_USERS_ROWS),
    Events:     createMockSheet(DEFAULT_EVENTS_ROWS),
    Upload_Log: createMockSheet([]),
  });
}

// ─── Mock SpreadsheetApp ──────────────────────────────────────────────────────

const mockSpreadsheet = {
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
  getActiveUser: jest.fn().mockReturnValue(mockActiveUser),
};

/** Helper: set the "currently logged in" user for a test */
export function setMockUser(email: string): void {
  mockActiveUser.getEmail.mockReturnValue(email);
}

// ─── Mock PropertiesService ───────────────────────────────────────────────────

const mockProperties: Record<string, string> = {
  ROOT_FOLDER_ID: TEST_ROOT_FOLDER_ID,
  SPREADSHEET_ID: TEST_SPREADSHEET_ID,
};

const mockScriptProperties = {
  getProperty: jest.fn().mockImplementation((key: string) => mockProperties[key] ?? null),
  setProperty: jest.fn().mockImplementation((key: string, value: string) => {
    mockProperties[key] = value;
  }),
};

const mockPropertiesService = {
  getScriptProperties: jest.fn().mockReturnValue(mockScriptProperties),
};

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

const mockDriveApp = {
  getFolderById: jest.fn().mockReturnValue(mockFolder),
  getRootFolder: jest.fn().mockReturnValue(mockFolder),
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

const mockHtmlTemplate = {
  evaluate: jest.fn().mockReturnValue(mockHtmlOutput),
};

const mockHtmlService = {
  createTemplateFromFile: jest.fn().mockReturnValue(mockHtmlTemplate),
  XFrameOptionsMode: { DENY: 'DENY' },
};

// ─── Mock Logger ──────────────────────────────────────────────────────────────

const mockLogger = {
  log: jest.fn(),
};

// ─── Mock MailApp ─────────────────────────────────────────────────────────────

const mockMailApp = {
  sendEmail: jest.fn(),
};

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

// ─── Exports for use in test files ───────────────────────────────────────────

export {
  mockSession,
  mockActiveUser,
  mockSpreadsheet,
  mockSpreadsheetApp,
  mockScriptProperties,
  mockPropertiesService,
  mockDriveApp,
  mockUtilities,
  mockContentService,
  mockHtmlService,
  mockLogger,
  mockMailApp,
  // makeMockDriveFile is already a named export via the function declaration above
};
