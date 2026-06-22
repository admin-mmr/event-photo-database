/**
 * userStore.ts — control-plane Users, with the Google Sheet as SSOT (dev plan
 * D2/G1.1). Writes go to the `Users` tab via the Sheets API; a best-effort
 * Firestore mirror (`users` collection) keeps fast/filtered reads for the admin
 * UI (G2) and cross-cloud parity. Role resolution for RBAC (middleware/rbac.ts)
 * reads through a short in-memory TTL cache of the tab so we don't re-read the
 * whole sheet on every request.
 *
 * Column layout mirrors gas-app COLUMNS.USERS (gas-app/src/config/constants.ts)
 * — keep in sync if the Sheet schema changes. Columns 5/6 are reserved/unused.
 */

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { UserRole, UserStatus, isUserRole, type UserRole as Role, type UserStatus as Status } from '../lib/roles.js';
import { appendSheetValues, updateSheetValues } from './sheetsService.js';
import { cell, readTab, rowRange, withTabLock } from './sheetTable.js';

const TAB = 'Users';
const LAST_COL = 'K'; // through LAST_LOGIN_AT (index 10)
const COL = {
  EMAIL: 0,
  FIRST_NAME: 1,
  LAST_NAME: 2,
  ROLE: 3,
  CLUB_ID: 4,
  STATUS: 7,
  ADDED_DATE: 8,
  ADDED_BY: 9,
  LAST_LOGIN_AT: 10,
} as const;
const WIDTH = 11; // A..K

export interface User {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  /** Club normalizedName for club_admin; '' for super_admin. */
  clubId: string;
  status: Status;
  addedAt: string;
  addedBy: string;
  lastLoginAt: string;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  clubId?: string;
}

export interface UpdateUserPatch {
  firstName?: string;
  lastName?: string;
  role?: Role;
  clubId?: string;
}

export class UserStoreError extends Error {
  constructor(public code: 'invalid' | 'duplicate' | 'not_found', message: string) {
    super(message);
    this.name = 'UserStoreError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e: string): string => e.trim().toLowerCase();

function rowToUser(cells: string[]): User {
  const role = cell(cells, COL.ROLE);
  const status = cell(cells, COL.STATUS);
  return {
    email: normEmail(cell(cells, COL.EMAIL)),
    firstName: cell(cells, COL.FIRST_NAME),
    lastName: cell(cells, COL.LAST_NAME),
    role: (isUserRole(role) ? role : UserRole.CLUB_ADMIN) as Role,
    clubId: cell(cells, COL.CLUB_ID),
    status: (status === UserStatus.INACTIVE ? UserStatus.INACTIVE : UserStatus.ACTIVE) as Status,
    addedAt: cell(cells, COL.ADDED_DATE),
    addedBy: cell(cells, COL.ADDED_BY),
    lastLoginAt: cell(cells, COL.LAST_LOGIN_AT),
  };
}

// ── RBAC hot-path cache ──────────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000;
let tableCache: { at: number; rows: { rowNumber: number; cells: string[] }[] } | null = null;

function invalidate(): void {
  tableCache = null;
}

async function loadRows(spreadsheetId: string): Promise<{ rowNumber: number; cells: string[] }[]> {
  if (tableCache && Date.now() - tableCache.at < CACHE_TTL_MS) return tableCache.rows;
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EMAIL, 'email');
  tableCache = { at: Date.now(), rows };
  return rows;
}

/** Best-effort Firestore mirror; never blocks or fails the Sheet write. */
async function mirror(user: User): Promise<void> {
  try {
    await firestore()
      .collection('users')
      .doc(user.email)
      .set({ ...user, source: 'sheet-write', updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    logger.warn({ err, email: user.email }, 'user cache mirror failed (non-fatal)');
  }
}

export async function listUsers(
  spreadsheetId: string,
  filter?: { clubId?: string; status?: Status },
): Promise<User[]> {
  const rows = await loadRows(spreadsheetId);
  let users = rows.map((r) => rowToUser(r.cells));
  if (filter?.clubId !== undefined) users = users.filter((u) => u.clubId === filter.clubId);
  if (filter?.status !== undefined) users = users.filter((u) => u.status === filter.status);
  return users;
}

export async function getUserByEmail(spreadsheetId: string, email: string): Promise<User | null> {
  const target = normEmail(email);
  const rows = await loadRows(spreadsheetId);
  const hit = rows.find((r) => normEmail(cell(r.cells, COL.EMAIL)) === target);
  return hit ? rowToUser(hit.cells) : null;
}

export async function createUser(
  spreadsheetId: string,
  input: CreateUserInput,
  actorEmail: string,
): Promise<User> {
  const email = normEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new UserStoreError('invalid', `Invalid email: ${input.email}`);
  if (!isUserRole(input.role)) throw new UserStoreError('invalid', `Invalid role: ${input.role}`);
  if (input.role === UserRole.CLUB_ADMIN && !(input.clubId ?? '').trim()) {
    throw new UserStoreError('invalid', 'club_admin requires a clubId');
  }
  if (!input.firstName.trim() || !input.lastName.trim()) {
    throw new UserStoreError('invalid', 'firstName and lastName are required');
  }

  return withTabLock(TAB, async () => {
    invalidate();
    if (await getUserByEmail(spreadsheetId, email)) {
      throw new UserStoreError('duplicate', `User already exists: ${email}`);
    }
    const now = new Date().toISOString();
    const user: User = {
      email,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      role: input.role,
      clubId: input.role === UserRole.SUPER_ADMIN ? '' : (input.clubId ?? '').trim(),
      status: UserStatus.ACTIVE,
      addedAt: now,
      addedBy: actorEmail,
      lastLoginAt: '',
    };
    const row = new Array(WIDTH).fill('');
    row[COL.EMAIL] = user.email;
    row[COL.FIRST_NAME] = user.firstName;
    row[COL.LAST_NAME] = user.lastName;
    row[COL.ROLE] = user.role;
    row[COL.CLUB_ID] = user.clubId;
    row[COL.STATUS] = user.status;
    row[COL.ADDED_DATE] = user.addedAt;
    row[COL.ADDED_BY] = user.addedBy;
    await appendSheetValues(spreadsheetId, `${TAB}!A1`, [row]);
    invalidate();
    await mirror(user);
    return user;
  });
}

export async function updateUser(
  spreadsheetId: string,
  email: string,
  patch: UpdateUserPatch,
): Promise<User> {
  const target = normEmail(email);
  if (patch.role !== undefined && !isUserRole(patch.role)) {
    throw new UserStoreError('invalid', `Invalid role: ${patch.role}`);
  }
  return withTabLock(TAB, async () => {
    invalidate();
    const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EMAIL, 'email');
    const hit = rows.find((r) => normEmail(cell(r.cells, COL.EMAIL)) === target);
    if (!hit) throw new UserStoreError('not_found', `User not found: ${email}`);

    const cells = [...hit.cells];
    while (cells.length < WIDTH) cells.push('');
    if (patch.firstName !== undefined) cells[COL.FIRST_NAME] = patch.firstName.trim();
    if (patch.lastName !== undefined) cells[COL.LAST_NAME] = patch.lastName.trim();
    if (patch.role !== undefined) cells[COL.ROLE] = patch.role;
    if (patch.clubId !== undefined) cells[COL.CLUB_ID] = patch.clubId.trim();
    // super_admin never carries a clubId.
    if (cells[COL.ROLE] === UserRole.SUPER_ADMIN) cells[COL.CLUB_ID] = '';

    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [cells.slice(0, WIDTH)]);
    invalidate();
    const user = rowToUser(cells);
    await mirror(user);
    return user;
  });
}

export async function setUserStatus(
  spreadsheetId: string,
  email: string,
  status: Status,
): Promise<User> {
  const target = normEmail(email);
  return withTabLock(TAB, async () => {
    invalidate();
    const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EMAIL, 'email');
    const hit = rows.find((r) => normEmail(cell(r.cells, COL.EMAIL)) === target);
    if (!hit) throw new UserStoreError('not_found', `User not found: ${email}`);
    const cells = [...hit.cells];
    while (cells.length < WIDTH) cells.push('');
    cells[COL.STATUS] = status;
    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [cells.slice(0, WIDTH)]);
    invalidate();
    const user = rowToUser(cells);
    await mirror(user);
    return user;
  });
}

/** Test-only: clear the in-memory TTL cache. */
export function __clearUserCache(): void {
  invalidate();
}
