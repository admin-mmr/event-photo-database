# Phase 1 — Foundation: Detailed Development Plan

**Project**: 湘舍动公益文件系统 v1.0 (GAS)
**Phase**: 1 of 5 — Foundation
**Timeline**: Week 1–2
**Goal**: Skeleton GAS Web App running with auth, basic Drive/Sheets wiring, admin user management, and a fully typed codebase with comprehensive tests.

---

## 1. Local Development Setup

### 1.1 Clasp + TypeScript Workflow

All source code lives locally and syncs to Google Apps Script via `clasp`. The developer creates an empty Apps Script project in Google Drive, copies the Script ID, and initializes clasp locally.

```
project-root/
├── .clasp.json              # Script ID + root directory pointer
├── .claspignore              # Exclude tests, config, docs from push
├── tsconfig.json             # TypeScript compiler options
├── package.json              # Dev dependencies (clasp, jest, ts-jest, gas-types)
├── appsscript.json           # GAS manifest (scopes, webapp config)
├── src/                      # All source pushed to GAS
│   ├── types/                # Shared type definitions
│   ├── services/             # Business logic (Drive, Sheets, Auth)
│   ├── middleware/            # Request pipeline (auth check, role guard)
│   ├── routes/               # doGet/doPost dispatchers
│   ├── ui/                   # HTML templates served by HtmlService
│   ├── utils/                # Validators, formatters, helpers
│   └── config/               # Constants, environment references
├── tests/                    # Jest test suites (local only, not pushed)
│   ├── unit/
│   ├── integration/
│   └── mocks/
└── docs/                     # Design docs, ADRs
```

### 1.2 .clasp.json

```json
{
  "scriptId": "<YOUR_SCRIPT_ID>",
  "rootDir": "src"
}
```

### 1.3 .claspignore

```
tests/**
docs/**
node_modules/**
*.test.ts
*.spec.ts
jest.config.ts
tsconfig.json
package.json
README.md
```

### 1.4 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2019",
    "module": "None",
    "lib": ["ES2019"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": false,
    "skipLibCheck": true,
    "outDir": "build",
    "rootDir": "src",
    "typeRoots": ["node_modules/@types"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**Key decisions**: `"module": "None"` because GAS has no module system — all files are concatenated into a single global scope. Clasp transpiles TypeScript to JS before pushing. `strict: true` enables the full suite of type-safety checks.

### 1.5 package.json (dev dependencies)

```json
{
  "name": "xiangsheidong-file-system",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "push": "clasp push --watch",
    "pull": "clasp pull",
    "deploy": "clasp deploy",
    "test": "jest --verbose",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit --pretty"
  },
  "devDependencies": {
    "@google/clasp": "^2.4.2",
    "@types/google-apps-script": "^1.0.83",
    "@types/jest": "^29.5.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  }
}
```

### 1.6 appsscript.json

```json
{
  "timeZone": "America/New_York",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_ACCESSING",
    "access": "ANYONE_WITH_GOOGLE_ACCOUNT"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

---

## 2. Type Definitions

All types live in `src/types/` and are the single source of truth. Every function signature, every service method, every sheet row must reference these types. No `any` allowed anywhere.

### 2.1 src/types/enums.ts

```typescript
/**
 * User roles within the system.
 * - admin: full access to event management, user CRUD, reports
 * - user: can upload photos for their club
 * - api_client: machine-to-machine access for partner orgs (Phase 5)
 */
const enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
  API_CLIENT = 'api_client',
}

/**
 * Account status. Inactive users cannot log in or upload.
 */
const enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * How the upload was initiated.
 */
const enum UploadSource {
  WEB_APP = 'web_app',
  API = 'api',
}

/**
 * Allowed photo MIME types accepted by the upload pipeline.
 */
const enum PhotoMimeType {
  JPEG = 'image/jpeg',
  PNG = 'image/png',
  HEIC = 'image/heic',
}

/**
 * Route actions recognized by doGet and doPost dispatchers.
 */
const enum RouteAction {
  // Page routes (doGet)
  DASHBOARD = 'dashboard',
  LOGIN = 'login',
  ADMIN_USERS = 'admin_users',
  ADMIN_EVENTS = 'admin_events',
  UPLOAD = 'upload',

  // API actions (doPost / doGet with params)
  CREATE_USER = 'create_user',
  UPDATE_USER = 'update_user',
  DEACTIVATE_USER = 'deactivate_user',
  VALIDATE_FOLDER_NAME = 'validate_folder_name',
}

/**
 * Standardized result status for all service operations.
 */
const enum ResultStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  WARNING = 'warning',
}
```

### 2.2 src/types/models.ts

```typescript
/**
 * Row in the Users sheet.
 * Maps 1:1 to column order in the spreadsheet.
 */
interface UserRecord {
  readonly email: string;
  readonly runningClub: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly addedDate: string;       // ISO 8601 date string
  readonly addedBy: string;         // admin email
}

/**
 * Row in the Events sheet.
 */
interface EventRecord {
  readonly eventId: string;         // UUID
  readonly eventName: string;
  readonly eventDate: string;       // ISO 8601 date string
  readonly folderName: string;      // YYYY-MM-DD_EventName
  readonly driveFolderId: string;
  readonly createdBy: string;
  readonly createdAt: string;       // ISO 8601 timestamp
}

/**
 * Row in the Upload_Log sheet.
 */
interface UploadLogRecord {
  readonly logId: string;
  readonly eventId: string;
  readonly clubName: string;
  readonly uploadedBy: string;
  readonly batchFolderName: string;
  readonly batchFolderId: string;
  readonly fileCount: number;
  readonly totalSizeMb: number;
  readonly skippedDuplicates: number;
  readonly skippedNonPhoto: number;
  readonly uploadTimestamp: string;
  readonly source: UploadSource;
}

/**
 * Approved running club entry. Maintained as a validated
 * list (could be a 4th sheet or a config constant).
 */
interface ClubEntry {
  readonly name: string;            // Display name: "New Bee"
  readonly folderId: string;        // Normalized folder name: "New_Bee"
}
```

### 2.3 src/types/requests.ts

```typescript
/**
 * Shape of the GAS event parameter for doGet/doPost.
 * Extends the built-in GoogleAppsScript types with our
 * application-specific parameters.
 */
interface AppRequest {
  readonly action: RouteAction;
  readonly payload: Record<string, unknown>;
  readonly userEmail: string;
  readonly userRole: UserRole;
  readonly timestamp: string;
}

/**
 * Input for creating a new user (admin action).
 */
interface CreateUserInput {
  readonly email: string;
  readonly runningClub: string;
  readonly role: UserRole;
}

/**
 * Input for updating a user record.
 */
interface UpdateUserInput {
  readonly email: string;                 // lookup key
  readonly runningClub?: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

/**
 * Input for the folder name validator.
 */
interface ValidateFolderNameInput {
  readonly folderName: string;
  readonly layer: 1 | 2 | 3;
}
```

### 2.4 src/types/responses.ts

```typescript
/**
 * Standardized JSON response envelope.
 * Every service method and API endpoint returns this shape.
 */
interface ServiceResult<T = undefined> {
  readonly status: ResultStatus;
  readonly message: string;
  readonly data?: T;
  readonly errors?: ReadonlyArray<ValidationError>;
}

/**
 * Field-level validation error for form inputs.
 */
interface ValidationError {
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
}

/**
 * Response payload for folder name validation.
 */
interface FolderValidationResult {
  readonly isValid: boolean;
  readonly normalizedName: string;
  readonly violations: ReadonlyArray<string>;
}

/**
 * Paginated list response for admin views.
 */
interface PaginatedResult<T> {
  readonly items: ReadonlyArray<T>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
```

### 2.5 src/types/config.ts

```typescript
/**
 * Application configuration loaded from Script Properties
 * or hardcoded constants. Central place for all magic strings.
 */
interface AppConfig {
  readonly ROOT_FOLDER_ID: string;
  readonly SPREADSHEET_ID: string;
  readonly SHEET_NAMES: {
    readonly USERS: string;
    readonly EVENTS: string;
    readonly UPLOAD_LOG: string;
  };
  readonly APPROVED_CLUBS: ReadonlyArray<ClubEntry>;
  readonly PHOTO_MIME_TYPES: ReadonlyArray<PhotoMimeType>;
  readonly MAX_FILE_SIZE_MB: number;
  readonly MAX_BATCH_SIZE_MB: number;
}

/**
 * Column indices for each sheet (0-based).
 * Prevents magic numbers when reading/writing sheet data.
 */
interface SheetColumns {
  readonly USERS: {
    readonly EMAIL: 0;
    readonly RUNNING_CLUB: 1;
    readonly ROLE: 2;
    readonly STATUS: 3;
    readonly ADDED_DATE: 4;
    readonly ADDED_BY: 5;
  };
  readonly EVENTS: {
    readonly EVENT_ID: 0;
    readonly EVENT_NAME: 1;
    readonly EVENT_DATE: 2;
    readonly FOLDER_NAME: 3;
    readonly DRIVE_FOLDER_ID: 4;
    readonly CREATED_BY: 5;
    readonly CREATED_AT: 6;
  };
  readonly UPLOAD_LOG: {
    readonly LOG_ID: 0;
    readonly EVENT_ID: 1;
    readonly CLUB_NAME: 2;
    readonly UPLOADED_BY: 3;
    readonly BATCH_FOLDER_NAME: 4;
    readonly BATCH_FOLDER_ID: 5;
    readonly FILE_COUNT: 6;
    readonly TOTAL_SIZE_MB: 7;
    readonly SKIPPED_DUPLICATES: 8;
    readonly SKIPPED_NON_PHOTO: 9;
    readonly UPLOAD_TIMESTAMP: 10;
    readonly SOURCE: 11;
  };
}
```

### 2.6 Type Enforcement Rules

These rules apply throughout the entire codebase:

1. **No `any`**: Every variable, parameter, and return type must be explicitly typed. The `noImplicitAny` compiler flag enforces this.
2. **Readonly by default**: All interface properties use `readonly`. Mutations happen only through explicit service methods that return new objects.
3. **Const enums for string literals**: Never use raw string literals like `'admin'` — always use `UserRole.ADMIN`. This prevents typos and enables refactoring.
4. **ServiceResult wrapper**: Every function that can fail returns `ServiceResult<T>`. No throwing exceptions across service boundaries.
5. **Discriminated unions for complex state**: Where a value can be one of several shapes, use a `status` or `kind` discriminator field so TypeScript narrows the type automatically.
6. **Sheet data is typed at the boundary**: Raw `any[][]` from `getValues()` is immediately parsed into typed records via mapper functions (see Section 4.3). No untyped sheet data leaks into business logic.

---

## 3. Architecture

### 3.1 Layer Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    GAS Web App Entry                      │
│           doGet(e) / doPost(e)  [src/routes/]            │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│                   Middleware Pipeline                      │
│    AuthMiddleware → RoleGuard → InputValidator            │
│                  [src/middleware/]                         │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│                   Service Layer                           │
│    AuthService  │  UserService  │  DriveService           │
│    SheetService │  ValidatorService                       │
│                  [src/services/]                          │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│              Google APIs (GAS built-ins)                   │
│    DriveApp / SpreadsheetApp / Session / PropertiesService │
└──────────────────────────────────────────────────────────┘
```

### 3.2 File Inventory — Phase 1

```
src/
├── types/
│   ├── enums.ts              # All const enums
│   ├── models.ts             # Sheet row interfaces
│   ├── requests.ts           # Input DTOs
│   ├── responses.ts          # Output DTOs, ServiceResult
│   └── config.ts             # AppConfig, SheetColumns
│
├── config/
│   └── constants.ts          # Singleton AppConfig instance, column maps
│
├── utils/
│   ├── uuid.ts               # UUID v4 generator (GAS-compatible)
│   ├── dateFormatter.ts      # ISO date/timestamp helpers
│   ├── folderNameValidator.ts # Regex validators for Layer 1-3
│   └── sheetMapper.ts        # Raw row ↔ typed record converters
│
├── middleware/
│   ├── authMiddleware.ts     # Extract user email from Session
│   ├── roleGuard.ts          # Check role against required role for route
│   └── inputValidator.ts     # Validate & sanitize request payloads
│
├── services/
│   ├── authService.ts        # Login flow, session check
│   ├── userService.ts        # CRUD on Users sheet
│   ├── sheetService.ts       # Generic read/write/append for any sheet
│   └── driveService.ts       # Folder operations on Google Drive
│
├── routes/
│   ├── router.ts             # Maps action → handler, runs middleware
│   ├── pageRoutes.ts         # doGet handlers returning HtmlOutput
│   └── apiRoutes.ts          # doPost handlers returning JSON
│
├── ui/
│   ├── templates/
│   │   ├── layout.html       # Base HTML shell with nav, CSS, JS includes
│   │   ├── login.html        # Login prompt / access denied
│   │   ├── dashboard.html    # Role-based landing page
│   │   └── admin/
│   │       └── users.html    # User management table + forms
│   ├── css/
│   │   └── styles.html       # <style> block (inlined via HtmlService)
│   └── js/
│       ├── app.html          # Client-side routing, fetch helpers
│       └── admin.html        # Admin-specific UI logic
│
└── main.ts                   # doGet(e), doPost(e) — GAS entry points
```

### 3.3 GAS Global Scope Strategy

Since GAS concatenates all files into one global scope (no `import`/`export`), the project uses these conventions:

1. **Namespace objects**: Each service exposes a global object (e.g., `const UserService = { ... }`) rather than free functions, to avoid name collisions.
2. **Type files are declaration-only**: `types/*.ts` contain only `interface` and `const enum` declarations — no runtime code. TypeScript erases these at compile time.
3. **Load order**: Clasp pushes files alphabetically within directories. Prefix files with numbers if load order matters (e.g., `00_config.ts` before `01_services.ts`), or structure dependencies to avoid order sensitivity.
4. **No side effects at top level**: Every `.ts` file defines functions/objects but does not execute anything on load. Only `main.ts` wires things together in `doGet`/`doPost`.

---

## 4. Implementation Details

### 4.1 Entry Points — src/main.ts

```typescript
function doGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  const action = (e.parameter.action as RouteAction) || RouteAction.DASHBOARD;
  return Router.handleGet(e, action);
}

function doPost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  const action = e.parameter.action as RouteAction;
  return Router.handlePost(e, action);
}
```

### 4.2 Middleware Pipeline — src/middleware/authMiddleware.ts

```typescript
const AuthMiddleware = {
  /**
   * Extracts the current user's email from the GAS Session.
   * Returns a ServiceResult with the email or an error if
   * the user is not authenticated.
   */
  getCurrentUser(): ServiceResult<{ email: string }> {
    const email = Session.getActiveUser().getEmail();
    if (!email) {
      return {
        status: ResultStatus.ERROR,
        message: 'Not authenticated. Please log in with a Google account.',
      };
    }
    return {
      status: ResultStatus.SUCCESS,
      message: 'Authenticated',
      data: { email },
    };
  },

  /**
   * Looks up the user in the Users sheet and returns their
   * full record. Returns error if user is not registered
   * or is inactive.
   */
  resolveUser(email: string): ServiceResult<UserRecord> {
    const user = UserService.findByEmail(email);
    if (!user) {
      return {
        status: ResultStatus.ERROR,
        message: 'Access denied. Your account is not registered in the system.',
      };
    }
    if (user.status === UserStatus.INACTIVE) {
      return {
        status: ResultStatus.ERROR,
        message: 'Your account has been deactivated. Contact an admin.',
      };
    }
    return {
      status: ResultStatus.SUCCESS,
      message: 'User resolved',
      data: user,
    };
  },
};
```

### 4.3 Sheet Data Mapper — src/utils/sheetMapper.ts

This is the critical boundary where untyped sheet data becomes typed. Every sheet read goes through a mapper.

```typescript
const SheetMapper = {
  /**
   * Converts a raw row (any[]) from the Users sheet into a UserRecord.
   * Validates types at runtime and returns null for malformed rows.
   */
  toUserRecord(row: unknown[]): UserRecord | null {
    if (row.length < 6) return null;

    const email = String(row[0] || '').trim();
    const role = String(row[2] || '');

    if (!email) return null;
    if (!Object.values(UserRole).includes(role as UserRole)) return null;

    return {
      email,
      runningClub: String(row[1] || '').trim(),
      role: role as UserRole,
      status: (String(row[3] || '') as UserStatus) || UserStatus.INACTIVE,
      addedDate: String(row[4] || ''),
      addedBy: String(row[5] || ''),
    };
  },

  /**
   * Converts a UserRecord back into a row array for writing to Sheets.
   */
  fromUserRecord(record: UserRecord): unknown[] {
    return [
      record.email,
      record.runningClub,
      record.role,
      record.status,
      record.addedDate,
      record.addedBy,
    ];
  },

  // Similar mappers for EventRecord, UploadLogRecord...
};
```

### 4.4 Folder Name Validator — src/utils/folderNameValidator.ts

```typescript
const FolderNameValidator = {
  /** Layer 1: YYYY-MM-DD_Title_Case_Name */
  LAYER1_REGEX: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])_[A-Z][A-Za-z0-9]+(_[A-Z][A-Za-z0-9]+)*$/,

  /** Layer 2: Must match an approved club name exactly */
  LAYER2_REGEX: /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z][A-Za-z0-9]*)*$/,

  /** Layer 3: YYYYMMDD-HHMMSS_username (auto-generated) */
  LAYER3_REGEX: /^\d{8}-\d{6}_[a-z][a-z0-9._-]*$/,

  validate(input: ValidateFolderNameInput): FolderValidationResult {
    const { folderName, layer } = input;
    const violations: string[] = [];

    switch (layer) {
      case 1:
        if (!this.LAYER1_REGEX.test(folderName)) {
          violations.push(
            'Layer 1 folder must match YYYY-MM-DD_Title_Case_Name'
          );
        }
        // Also validate the date portion is a real date
        if (!this.isValidDatePrefix(folderName)) {
          violations.push('Date portion is not a valid calendar date');
        }
        break;
      case 2:
        if (!this.LAYER2_REGEX.test(folderName)) {
          violations.push(
            'Layer 2 folder must be a valid club name identifier'
          );
        }
        break;
      case 3:
        if (!this.LAYER3_REGEX.test(folderName)) {
          violations.push(
            'Layer 3 folder must match YYYYMMDD-HHMMSS_username'
          );
        }
        break;
    }

    return {
      isValid: violations.length === 0,
      normalizedName: folderName.trim(),
      violations,
    };
  },

  isValidDatePrefix(folderName: string): boolean {
    const match = folderName.match(/^(\d{4})-(\d{2})-(\d{2})_/);
    if (!match) return false;
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return (
      date.getFullYear() === Number(y) &&
      date.getMonth() === Number(m) - 1 &&
      date.getDate() === Number(d)
    );
  },
};
```

### 4.5 User Service — src/services/userService.ts

```typescript
const UserService = {
  findByEmail(email: string): UserRecord | null {
    const rows = SheetService.getAllRows(CONFIG.SHEET_NAMES.USERS);
    for (const row of rows) {
      const record = SheetMapper.toUserRecord(row);
      if (record && record.email === email) return record;
    }
    return null;
  },

  listAll(page: number = 1, pageSize: number = 50): PaginatedResult<UserRecord> {
    const allRows = SheetService.getAllRows(CONFIG.SHEET_NAMES.USERS);
    const records = allRows
      .map(SheetMapper.toUserRecord)
      .filter((r): r is UserRecord => r !== null);
    const start = (page - 1) * pageSize;
    return {
      items: records.slice(start, start + pageSize),
      total: records.length,
      page,
      pageSize,
    };
  },

  create(input: CreateUserInput, adminEmail: string): ServiceResult<UserRecord> {
    // Validate input
    const errors = this.validateCreateInput(input);
    if (errors.length > 0) {
      return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
    }
    // Check for duplicate
    if (this.findByEmail(input.email)) {
      return {
        status: ResultStatus.ERROR,
        message: `User ${input.email} already exists`,
      };
    }
    // Build record
    const record: UserRecord = {
      email: input.email.trim().toLowerCase(),
      runningClub: input.runningClub,
      role: input.role,
      status: UserStatus.ACTIVE,
      addedDate: new Date().toISOString().split('T')[0],
      addedBy: adminEmail,
    };
    // Write to sheet
    SheetService.appendRow(
      CONFIG.SHEET_NAMES.USERS,
      SheetMapper.fromUserRecord(record)
    );
    return { status: ResultStatus.SUCCESS, message: 'User created', data: record };
  },

  update(input: UpdateUserInput, adminEmail: string): ServiceResult<UserRecord> {
    const existing = this.findByEmail(input.email);
    if (!existing) {
      return { status: ResultStatus.ERROR, message: 'User not found' };
    }
    const updated: UserRecord = {
      ...existing,
      runningClub: input.runningClub ?? existing.runningClub,
      role: input.role ?? existing.role,
      status: input.status ?? existing.status,
    };
    const rowIndex = SheetService.findRowIndex(
      CONFIG.SHEET_NAMES.USERS,
      0,
      input.email
    );
    if (rowIndex < 0) {
      return { status: ResultStatus.ERROR, message: 'Row not found in sheet' };
    }
    SheetService.updateRow(
      CONFIG.SHEET_NAMES.USERS,
      rowIndex,
      SheetMapper.fromUserRecord(updated)
    );
    return { status: ResultStatus.SUCCESS, message: 'User updated', data: updated };
  },

  deactivate(email: string): ServiceResult<UserRecord> {
    return this.update(
      { email, status: UserStatus.INACTIVE },
      Session.getActiveUser().getEmail()
    );
  },

  validateCreateInput(input: CreateUserInput): ReadonlyArray<ValidationError> {
    const errors: ValidationError[] = [];
    if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      errors.push({ field: 'email', message: 'Invalid email format', value: input.email });
    }
    if (!input.runningClub) {
      errors.push({ field: 'runningClub', message: 'Running club is required' });
    }
    if (!Object.values(UserRole).includes(input.role)) {
      errors.push({ field: 'role', message: 'Invalid role', value: input.role });
    }
    return errors;
  },
};
```

### 4.6 Router — src/routes/router.ts

```typescript
interface RouteDefinition {
  readonly handler: (req: AppRequest) => GoogleAppsScript.HTML.HtmlOutput
    | GoogleAppsScript.Content.TextOutput;
  readonly requiredRole: UserRole | null;  // null = any authenticated user
}

const Router = {
  GET_ROUTES: new Map<RouteAction, RouteDefinition>([
    [RouteAction.DASHBOARD, { handler: PageRoutes.dashboard, requiredRole: null }],
    [RouteAction.ADMIN_USERS, { handler: PageRoutes.adminUsers, requiredRole: UserRole.ADMIN }],
    [RouteAction.LOGIN, { handler: PageRoutes.login, requiredRole: null }],
  ]),

  POST_ROUTES: new Map<RouteAction, RouteDefinition>([
    [RouteAction.CREATE_USER, { handler: ApiRoutes.createUser, requiredRole: UserRole.ADMIN }],
    [RouteAction.UPDATE_USER, { handler: ApiRoutes.updateUser, requiredRole: UserRole.ADMIN }],
    [RouteAction.DEACTIVATE_USER, { handler: ApiRoutes.deactivateUser, requiredRole: UserRole.ADMIN }],
  ]),

  handleGet(
    e: GoogleAppsScript.Events.DoGet,
    action: RouteAction
  ): GoogleAppsScript.HTML.HtmlOutput {
    // 1. Authenticate
    const authResult = AuthMiddleware.getCurrentUser();
    if (authResult.status !== ResultStatus.SUCCESS) {
      return PageRoutes.login({} as AppRequest);
    }

    // 2. Resolve user record
    const userResult = AuthMiddleware.resolveUser(authResult.data!.email);
    if (userResult.status !== ResultStatus.SUCCESS) {
      return PageRoutes.accessDenied(userResult.message);
    }

    // 3. Route lookup
    const route = this.GET_ROUTES.get(action);
    if (!route) {
      return PageRoutes.notFound();
    }

    // 4. Role check
    if (route.requiredRole && userResult.data!.role !== route.requiredRole) {
      return PageRoutes.accessDenied('Insufficient permissions');
    }

    // 5. Build request and dispatch
    const req: AppRequest = {
      action,
      payload: e.parameter as Record<string, unknown>,
      userEmail: userResult.data!.email,
      userRole: userResult.data!.role,
      timestamp: new Date().toISOString(),
    };

    return route.handler(req) as GoogleAppsScript.HTML.HtmlOutput;
  },

  handlePost(
    e: GoogleAppsScript.Events.DoPost,
    action: RouteAction
  ): GoogleAppsScript.Content.TextOutput {
    // Similar pattern: auth → resolve → route → role check → dispatch
    // Returns JSON via ContentService.createTextOutput()
    // ...
  },
};
```

### 4.7 UX — HTML Templates

The UI uses Google's Material Design Lite (CDL-hosted) for a clean, accessible look within the constraints of GAS HtmlService.

**Design principles for Phase 1 UI:**

1. **Progressive disclosure**: The dashboard shows only what the user's role allows. Admins see the management panel; regular users see their club view.
2. **Inline validation**: All form fields validate on blur with clear error messages below each field. No modal alerts.
3. **Loading states**: Every server call shows a spinner and disables the submit button to prevent double submission.
4. **Responsive layout**: CSS Grid with a single breakpoint (768px) for mobile/desktop. Event photos are commonly uploaded from phones.
5. **Accessible**: All form inputs have associated labels. Color is never the sole indicator of status (icons + text accompany colors). Focus outlines visible.
6. **Toast notifications**: Success/error messages appear as brief, dismissable toasts — not blocking modals.
7. **Confirmation for destructive actions**: Deactivating a user shows an inline confirmation prompt with the user's name, not a generic "Are you sure?" dialog.

**src/ui/templates/layout.html** (skeleton):

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>湘舍动公益文件系统</title>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/icon?family=Material+Icons">
  <link rel="stylesheet"
    href="https://code.getmdl.io/1.3.0/material.indigo-pink.min.css">
  <?!= include('css/styles') ?>
</head>
<body>
  <div class="mdl-layout mdl-js-layout mdl-layout--fixed-header">
    <header class="mdl-layout__header">
      <div class="mdl-layout__header-row">
        <span class="mdl-layout-title">湘舍动公益文件系统</span>
        <div class="mdl-layout-spacer"></div>
        <nav class="mdl-navigation" id="nav-links">
          <!-- Populated by role-based JS -->
        </nav>
        <span id="user-email" class="mdl-chip">
          <span class="mdl-chip__text"><?= userEmail ?></span>
        </span>
      </div>
    </header>
    <main class="mdl-layout__content">
      <div class="page-content" id="app-root">
        <?!= content ?>
      </div>
    </main>
    <!-- Toast container -->
    <div id="toast-container" aria-live="polite"></div>
  </div>
  <script defer src="https://code.getmdl.io/1.3.0/material.min.js"></script>
  <?!= include('js/app') ?>
</body>
</html>
```

**src/ui/templates/admin/users.html** — User management table with inline add/edit:

```html
<div class="admin-users-container">
  <h4>User Management</h4>

  <!-- Add user form (collapsed by default) -->
  <div id="add-user-form" class="card collapsed">
    <form onsubmit="handleCreateUser(event)">
      <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label">
        <input type="email" id="new-email" class="mdl-textfield__input" required>
        <label class="mdl-textfield__label" for="new-email">Email</label>
        <span class="field-error" id="error-email"></span>
      </div>
      <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label">
        <select id="new-club" class="mdl-textfield__input" required>
          <!-- Options populated from APPROVED_CLUBS -->
        </select>
        <label class="mdl-textfield__label" for="new-club">Running Club</label>
      </div>
      <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label">
        <select id="new-role" class="mdl-textfield__input">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <label class="mdl-textfield__label" for="new-role">Role</label>
      </div>
      <button type="submit" class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored"
              id="btn-create-user">
        Add User
      </button>
      <div class="spinner hidden" id="create-spinner"></div>
    </form>
  </div>

  <!-- User table -->
  <table class="mdl-data-table mdl-js-data-table mdl-shadow--2dp full-width">
    <thead>
      <tr>
        <th class="mdl-data-table__cell--non-numeric">Email</th>
        <th class="mdl-data-table__cell--non-numeric">Club</th>
        <th class="mdl-data-table__cell--non-numeric">Role</th>
        <th class="mdl-data-table__cell--non-numeric">Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="users-table-body">
      <!-- Rendered by JS -->
    </tbody>
  </table>
  <div class="pagination" id="users-pagination"></div>
</div>
```

---

## 5. Test Architecture

### 5.1 Strategy Overview

Since GAS code runs on Google's servers, direct integration tests against live Sheets/Drive are slow and flaky. The test strategy is:

| Layer | Tool | What It Tests | Runs Where |
|-------|------|---------------|------------|
| **Unit** | Jest + ts-jest | Pure logic: validators, mappers, service methods | Local (npm test) |
| **Integration** | Jest + GAS mocks | Service layer with mocked Sheet/Drive APIs | Local |
| **Contract** | Manual + clasp run | Actual GAS deployment against real Sheets/Drive | GAS runtime |
| **UI** | Manual checklist | HTML rendering, form behavior, role-based views | Browser |

### 5.2 Mock Strategy

All Google APIs are mocked at the boundary. Mocks live in `tests/mocks/` and implement the subset of GAS APIs used by the application.

**tests/mocks/gasGlobals.ts** — Sets up global GAS objects before each test suite:

```typescript
// Mock Session
const mockSession = {
  getActiveUser: jest.fn().mockReturnValue({
    getEmail: jest.fn().mockReturnValue('admin@mmrunners.org'),
  }),
};

// Mock SpreadsheetApp
const mockSheet = {
  getRange: jest.fn(),
  getLastRow: jest.fn().mockReturnValue(5),
  getDataRange: jest.fn(),
  appendRow: jest.fn(),
};

const mockSpreadsheet = {
  getSheetByName: jest.fn().mockReturnValue(mockSheet),
};

const mockSpreadsheetApp = {
  openById: jest.fn().mockReturnValue(mockSpreadsheet),
};

// Mock DriveApp
const mockFolder = {
  getId: jest.fn().mockReturnValue('mock-folder-id'),
  getName: jest.fn().mockReturnValue('Test_Folder'),
  createFolder: jest.fn(),
  getFolders: jest.fn(),
  getFoldersByName: jest.fn(),
};

const mockDriveApp = {
  getFolderById: jest.fn().mockReturnValue(mockFolder),
  getRootFolder: jest.fn().mockReturnValue(mockFolder),
};

// Install globals
(global as any).Session = mockSession;
(global as any).SpreadsheetApp = mockSpreadsheetApp;
(global as any).DriveApp = mockDriveApp;
(global as any).ContentService = {
  createTextOutput: jest.fn().mockReturnValue({
    setMimeType: jest.fn().mockReturnThis(),
  }),
  MimeType: { JSON: 'application/json' },
};
(global as any).HtmlService = {
  createTemplateFromFile: jest.fn().mockReturnValue({
    evaluate: jest.fn().mockReturnValue({
      setTitle: jest.fn().mockReturnThis(),
      setXFrameOptionsMode: jest.fn().mockReturnThis(),
    }),
  }),
};

export {
  mockSession,
  mockSpreadsheetApp,
  mockSpreadsheet,
  mockSheet,
  mockDriveApp,
  mockFolder,
};
```

### 5.3 jest.config.ts

```typescript
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  setupFilesAfterSetup: ['<rootDir>/tests/mocks/gasGlobals.ts'],
  moduleNameMapper: {
    // Map src/ imports since GAS has no modules
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/types/**',       // Type-only files
    '!src/ui/**',          // HTML templates
    '!src/main.ts',        // Entry point (thin wrapper)
  ],
  coverageThresholds: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
  },
};

export default config;
```

### 5.4 Unit Test Examples

**tests/unit/folderNameValidator.test.ts**

```typescript
describe('FolderNameValidator', () => {
  describe('Layer 1 — Master Event Folder', () => {
    it('accepts valid format: YYYY-MM-DD_Title_Case', () => {
      const result = FolderNameValidator.validate({
        folderName: '2025-11-03_NYC_Marathon',
        layer: 1,
      });
      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('rejects missing date prefix', () => {
      const result = FolderNameValidator.validate({
        folderName: 'NYC_Marathon',
        layer: 1,
      });
      expect(result.isValid).toBe(false);
      expect(result.violations[0]).toContain('YYYY-MM-DD');
    });

    it('rejects invalid date (Feb 30)', () => {
      const result = FolderNameValidator.validate({
        folderName: '2025-02-30_Some_Event',
        layer: 1,
      });
      expect(result.isValid).toBe(false);
      expect(result.violations).toContain(
        'Date portion is not a valid calendar date'
      );
    });

    it('rejects lowercase event name', () => {
      const result = FolderNameValidator.validate({
        folderName: '2025-11-03_nyc_marathon',
        layer: 1,
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects spaces in folder name', () => {
      const result = FolderNameValidator.validate({
        folderName: '2025-11-03_NYC Marathon',
        layer: 1,
      });
      expect(result.isValid).toBe(false);
    });

    it('accepts single-word event name', () => {
      const result = FolderNameValidator.validate({
        folderName: '2025-12-25_Christmas',
        layer: 1,
      });
      expect(result.isValid).toBe(true);
    });
  });

  describe('Layer 2 — Club Folder', () => {
    it('accepts valid club name format', () => {
      const result = FolderNameValidator.validate({
        folderName: 'New_Bee',
        layer: 2,
      });
      expect(result.isValid).toBe(true);
    });

    it('rejects names starting with underscore', () => {
      const result = FolderNameValidator.validate({
        folderName: '_Invalid',
        layer: 2,
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects names with special characters', () => {
      const result = FolderNameValidator.validate({
        folderName: 'Club@123',
        layer: 2,
      });
      expect(result.isValid).toBe(false);
    });
  });

  describe('Layer 3 — Upload Batch Folder', () => {
    it('accepts valid format: YYYYMMDD-HHMMSS_username', () => {
      const result = FolderNameValidator.validate({
        folderName: '20251103-093500_cathylin',
        layer: 3,
      });
      expect(result.isValid).toBe(true);
    });

    it('rejects uppercase username', () => {
      const result = FolderNameValidator.validate({
        folderName: '20251103-093500_CathyLin',
        layer: 3,
      });
      expect(result.isValid).toBe(false);
    });
  });

  describe('isValidDatePrefix', () => {
    it('validates real dates', () => {
      expect(FolderNameValidator.isValidDatePrefix('2025-01-31_X')).toBe(true);
      expect(FolderNameValidator.isValidDatePrefix('2025-02-28_X')).toBe(true);
    });

    it('rejects impossible dates', () => {
      expect(FolderNameValidator.isValidDatePrefix('2025-13-01_X')).toBe(false);
      expect(FolderNameValidator.isValidDatePrefix('2025-00-15_X')).toBe(false);
      expect(FolderNameValidator.isValidDatePrefix('2025-04-31_X')).toBe(false);
    });
  });
});
```

**tests/unit/sheetMapper.test.ts**

```typescript
describe('SheetMapper', () => {
  describe('toUserRecord', () => {
    it('maps a complete row to UserRecord', () => {
      const row = [
        'alice@example.com', 'New_Bee', 'admin', 'active',
        '2025-01-15', 'admin@mmrunners.org',
      ];
      const record = SheetMapper.toUserRecord(row);
      expect(record).not.toBeNull();
      expect(record!.email).toBe('alice@example.com');
      expect(record!.role).toBe(UserRole.ADMIN);
      expect(record!.status).toBe(UserStatus.ACTIVE);
    });

    it('returns null for row with fewer than 6 columns', () => {
      expect(SheetMapper.toUserRecord(['a', 'b'])).toBeNull();
    });

    it('returns null for empty email', () => {
      expect(SheetMapper.toUserRecord(['', 'club', 'admin', 'active', '', ''])).toBeNull();
    });

    it('returns null for invalid role', () => {
      expect(SheetMapper.toUserRecord([
        'a@b.com', 'club', 'superadmin', 'active', '', '',
      ])).toBeNull();
    });

    it('trims whitespace from email', () => {
      const row = [
        '  alice@example.com  ', 'New_Bee', 'user', 'active', '', '',
      ];
      const record = SheetMapper.toUserRecord(row);
      expect(record!.email).toBe('alice@example.com');
    });

    it('roundtrips through fromUserRecord', () => {
      const original: UserRecord = {
        email: 'test@example.com',
        runningClub: 'Misty_Mountain',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        addedDate: '2025-03-01',
        addedBy: 'admin@mmrunners.org',
      };
      const row = SheetMapper.fromUserRecord(original);
      const restored = SheetMapper.toUserRecord(row);
      expect(restored).toEqual(original);
    });
  });
});
```

**tests/unit/userService.test.ts**

```typescript
import {
  mockSheet,
  mockSpreadsheet,
} from '../mocks/gasGlobals';

describe('UserService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default sheet data
    mockSheet.getDataRange.mockReturnValue({
      getValues: jest.fn().mockReturnValue([
        ['admin@mmrunners.org', 'Admin', 'admin', 'active', '2025-01-01', 'system'],
        ['user1@example.com', 'New_Bee', 'user', 'active', '2025-02-01', 'admin@mmrunners.org'],
        ['inactive@example.com', 'Nankai', 'user', 'inactive', '2025-01-15', 'admin@mmrunners.org'],
      ]),
    });
  });

  describe('findByEmail', () => {
    it('returns the user record for a known email', () => {
      const user = UserService.findByEmail('admin@mmrunners.org');
      expect(user).not.toBeNull();
      expect(user!.role).toBe(UserRole.ADMIN);
    });

    it('returns null for an unknown email', () => {
      expect(UserService.findByEmail('nobody@example.com')).toBeNull();
    });

    it('is case-sensitive on email lookup', () => {
      expect(UserService.findByEmail('Admin@mmrunners.org')).toBeNull();
    });
  });

  describe('create', () => {
    it('returns SUCCESS and appends row for valid input', () => {
      const result = UserService.create(
        { email: 'new@example.com', runningClub: 'New_Bee', role: UserRole.USER },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.email).toBe('new@example.com');
      expect(mockSheet.appendRow).toHaveBeenCalledTimes(1);
    });

    it('returns ERROR for duplicate email', () => {
      const result = UserService.create(
        { email: 'admin@mmrunners.org', runningClub: 'New_Bee', role: UserRole.USER },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
      expect(mockSheet.appendRow).not.toHaveBeenCalled();
    });

    it('returns validation errors for invalid email format', () => {
      const result = UserService.create(
        { email: 'not-an-email', runningClub: 'New_Bee', role: UserRole.USER },
        'admin@mmrunners.org'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].field).toBe('email');
    });

    it('normalizes email to lowercase', () => {
      const result = UserService.create(
        { email: 'John@Example.COM', runningClub: 'New_Bee', role: UserRole.USER },
        'admin@mmrunners.org'
      );
      expect(result.data!.email).toBe('john@example.com');
    });
  });

  describe('deactivate', () => {
    it('sets status to inactive for existing user', () => {
      // Mock findRowIndex to return valid index
      jest.spyOn(SheetService, 'findRowIndex').mockReturnValue(2);
      const result = UserService.deactivate('user1@example.com');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.status).toBe(UserStatus.INACTIVE);
    });

    it('returns ERROR for non-existent user', () => {
      const result = UserService.deactivate('ghost@example.com');
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });
});
```

**tests/integration/authMiddleware.test.ts**

```typescript
import { mockSession } from '../mocks/gasGlobals';

describe('AuthMiddleware (integration)', () => {
  describe('getCurrentUser → resolveUser pipeline', () => {
    it('returns full user record for authenticated, registered user', () => {
      mockSession.getActiveUser().getEmail.mockReturnValue('admin@mmrunners.org');

      const authResult = AuthMiddleware.getCurrentUser();
      expect(authResult.status).toBe(ResultStatus.SUCCESS);

      const userResult = AuthMiddleware.resolveUser(authResult.data!.email);
      expect(userResult.status).toBe(ResultStatus.SUCCESS);
      expect(userResult.data!.role).toBe(UserRole.ADMIN);
    });

    it('blocks unauthenticated user at step 1', () => {
      mockSession.getActiveUser().getEmail.mockReturnValue('');
      const result = AuthMiddleware.getCurrentUser();
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('blocks unregistered user at step 2', () => {
      mockSession.getActiveUser().getEmail.mockReturnValue('stranger@gmail.com');
      const authResult = AuthMiddleware.getCurrentUser();
      expect(authResult.status).toBe(ResultStatus.SUCCESS);

      const userResult = AuthMiddleware.resolveUser(authResult.data!.email);
      expect(userResult.status).toBe(ResultStatus.ERROR);
      expect(userResult.message).toContain('not registered');
    });

    it('blocks inactive user at step 2', () => {
      mockSession.getActiveUser().getEmail.mockReturnValue('inactive@example.com');
      const authResult = AuthMiddleware.getCurrentUser();
      const userResult = AuthMiddleware.resolveUser(authResult.data!.email);
      expect(userResult.status).toBe(ResultStatus.ERROR);
      expect(userResult.message).toContain('deactivated');
    });
  });
});
```

### 5.5 Test Coverage Targets

| Module | Min Branch % | Min Line % | Key Test Scenarios |
|--------|-------------|------------|---------------------|
| folderNameValidator | 100% | 100% | All 3 layers, boundary dates, special chars, edge cases |
| sheetMapper | 95% | 100% | Roundtrip, malformed rows, empty fields, type coercion |
| userService | 90% | 95% | CRUD happy paths, duplicates, validation errors, edge cases |
| authMiddleware | 100% | 100% | Auth/unauth/inactive/unregistered |
| roleGuard | 100% | 100% | Admin-only routes, user-only routes, mixed |
| inputValidator | 90% | 95% | XSS payloads, SQL-like injections, empty/null/undefined |
| router | 85% | 90% | Route dispatch, unknown actions, role enforcement |
| sheetService | 80% | 85% | Read/write/append/findRow, empty sheets, large datasets |
| driveService | 80% | 85% | Create folder, check existence, ID retrieval |

### 5.6 Contract Tests (Run in GAS)

These are small GAS functions you run via `clasp run` to verify real API behavior. They are not automated — they serve as a smoke test after deployment.

```typescript
/**
 * Contract test: verify SheetService can read the Users sheet.
 * Run via: clasp run contractTestReadUsers
 */
function contractTestReadUsers(): void {
  const rows = SheetService.getAllRows('Users');
  Logger.log(`Users sheet has ${rows.length} rows`);
  if (rows.length === 0) {
    throw new Error('CONTRACT FAIL: Users sheet is empty');
  }
  const firstRecord = SheetMapper.toUserRecord(rows[0]);
  if (!firstRecord) {
    throw new Error('CONTRACT FAIL: First row failed to map');
  }
  Logger.log(`First user: ${firstRecord.email} (${firstRecord.role})`);
  Logger.log('CONTRACT PASS: SheetService.getAllRows + SheetMapper');
}

/**
 * Contract test: verify DriveService can access root folder.
 */
function contractTestDriveRoot(): void {
  const rootFolder = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const name = rootFolder.getName();
  Logger.log(`Root folder: ${name}`);
  if (!name) {
    throw new Error('CONTRACT FAIL: Could not read root folder name');
  }
  Logger.log('CONTRACT PASS: DriveApp.getFolderById');
}
```

---

## 6. Phase 1 Task Breakdown

### Sprint 1 (Week 1): Skeleton + Types + Auth

| # | Task | Outputs | Tests Required |
|---|------|---------|----------------|
| 1.1 | Create empty Apps Script project in Drive, note Script ID | .clasp.json | — |
| 1.2 | Initialize local project: npm init, install deps, configure tsconfig/jest/clasp | package.json, tsconfig.json, jest.config.ts | npm test runs green |
| 1.3 | Write all type definitions (enums, models, requests, responses, config) | src/types/*.ts | TypeScript compiles with no errors |
| 1.4 | Implement uuid.ts and dateFormatter.ts utilities | src/utils/ | Unit tests for UUID format, date edge cases |
| 1.5 | Implement folderNameValidator.ts | src/utils/ | Full unit test suite (see 5.4) |
| 1.6 | Implement sheetMapper.ts (all 3 record types) | src/utils/ | Roundtrip tests, malformed data tests |
| 1.7 | Implement sheetService.ts (generic CRUD) | src/services/ | Unit tests with mocked SpreadsheetApp |
| 1.8 | Implement authService.ts + authMiddleware.ts | src/middleware/ | Integration tests (auth pipeline) |
| 1.9 | Implement roleGuard.ts | src/middleware/ | Unit tests for each role/route combo |
| 1.10 | First clasp push — verify deployment, doGet returns "Hello" | Deployed Web App URL | Manual: open URL, see output |

### Sprint 2 (Week 2): User CRUD + UI + Drive Wiring

| # | Task | Outputs | Tests Required |
|---|------|---------|----------------|
| 2.1 | Implement userService.ts (full CRUD) | src/services/ | Unit test suite (see 5.4) |
| 2.2 | Implement inputValidator.ts (sanitize all inputs) | src/middleware/ | XSS strings, empty fields, type mismatches |
| 2.3 | Implement router.ts (doGet + doPost dispatch) | src/routes/ | Route dispatch tests, unknown action handling |
| 2.4 | Implement driveService.ts (folder ops: create, check existence, list) | src/services/ | Unit tests with mocked DriveApp |
| 2.5 | Build layout.html + styles.html + app.html (client-side shell) | src/ui/ | Manual: renders correctly, responsive |
| 2.6 | Build login.html + access denied view | src/ui/ | Manual: unauthenticated user sees login |
| 2.7 | Build dashboard.html (role-based landing) | src/ui/ | Manual: admin vs user view |
| 2.8 | Build admin/users.html (table + add/edit forms) | src/ui/ | Manual: CRUD operations work end-to-end |
| 2.9 | Write constants.ts with real Sheet/Drive IDs (from Script Properties) | src/config/ | Contract test: read from real sheet |
| 2.10 | Run contract tests against live environment | — | All contract tests pass |
| 2.11 | Run full local test suite, verify coverage thresholds | Coverage report | All thresholds met |

---

## 7. Definition of Done — Phase 1

Phase 1 is complete when all of the following are true:

1. **Local dev environment** works: `clasp push` syncs code to GAS without errors.
2. **TypeScript compiles clean**: `npm run typecheck` reports zero errors. No `any` in codebase.
3. **All unit + integration tests pass**: `npm test` green, coverage meets thresholds.
4. **Contract tests pass**: `clasp run contractTest*` all succeed against live Sheets/Drive.
5. **Web App deploys**: Opening the deployment URL shows the login screen.
6. **Auth flow works**: A registered Google user sees the dashboard; an unregistered user sees "Access Denied."
7. **Role routing works**: Admin sees admin panel; regular user sees their club view.
8. **User CRUD works**: Admin can add, edit, and deactivate users through the UI.
9. **Folder validator works**: Invalid folder names are caught and displayed in the UI.
10. **Google Sheets database** has 3 sheets with correct column headers and at least one seed admin row.
11. **Root Drive folder** exists with correct name and the app can access it.

---

## 8. Risk Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| GAS global scope name collisions | Runtime errors, silent bugs | Namespace objects (e.g., `UserService.create` not `createUser`); strict naming convention |
| Sheet data type drift | Mapper returns null, data loss | Defensive mappers with runtime type checks; contract tests catch schema drift |
| Clasp push overwrites manual edits in GAS | Lost work | Never edit in the GAS IDE; .clasp.json points to src/ only |
| OAuth scope creep | Permission prompts scare users | Declare minimum scopes in appsscript.json; document why each scope is needed |
| 6-minute GAS timeout on large sheets | Operation fails mid-write | Cache sheet reads; batch writes; paginate heavy operations |
| No module system makes testing hard | Can't import files individually | ts-jest + moduleNameMapper; test files source the compiled globals |
