/**
 * linkStore.ts — volunteer upload links, Google Sheet as SSOT (dev plan G3.2).
 * Writes go to the `Upload_Links` tab; a best-effort Firestore mirror
 * (`uploadLinks`) backs admin reads. Mirrors gas-app uploadLinkService semantics:
 *
 *  - generate: one active link per (eventId, clubName, tag); re-requesting the
 *    same triple returns the existing active link (no duplicate).
 *  - revoke: stamps revokedAt/By/Reason; the token is immediately invalid.
 *  - rotate: revoke the current link, then issue a NEW link (new linkId + token)
 *    for the same triple with version = old.version + 1 (audit continuity).
 *
 * Column layout mirrors gas-app COLUMNS.UPLOAD_LINKS. The empty/legacy tag is
 * substituted with DEFAULT_TAG so the Drive hierarchy stays uniform.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { UserStatus, type UserStatus as Status } from '../lib/roles.js';
import { appendSheetValues, updateSheetValues } from './sheetsService.js';
import { cell, readTab, rowRange, withTabLock } from './sheetTable.js';

const TAB = 'Upload_Links';
const LAST_COL = 'K';
const COL = {
  LINK_ID: 0,
  EVENT_ID: 1,
  CLUB_NAME: 2,
  TOKEN: 3,
  VERSION: 4,
  GENERATED_BY: 5,
  GENERATED_AT: 6,
  REVOKED_AT: 7,
  REVOKED_BY: 8,
  REVOKED_REASON: 9,
  TAG: 10,
} as const;
const WIDTH = 11; // A..K

export const DEFAULT_TAG = 'ALL';
/** Tag chars allowed when an admin supplies one (Unicode letters/digits/_/-). */
export const TAG_RE = /^[\p{L}\p{N}_-]+$/u;

export interface Link {
  linkId: string;
  eventId: string;
  clubName: string;
  token: string;
  version: number;
  generatedBy: string;
  generatedAt: string;
  revokedAt: string;
  revokedBy: string;
  revokedReason: string;
  tag: string;
  /** Derived: 'active' when not revoked, else 'inactive'. */
  status: Status;
}

export class LinkStoreError extends Error {
  constructor(
    public code: 'invalid' | 'not_found' | 'already_revoked',
    message: string,
  ) {
    super(message);
    this.name = 'LinkStoreError';
  }
}

/** URL-safe 256-bit token (gas-app used two concatenated UUIDs, base64-web-safe). */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function rowToLink(cells: string[]): Link {
  const revokedAt = cell(cells, COL.REVOKED_AT);
  return {
    linkId: cell(cells, COL.LINK_ID),
    eventId: cell(cells, COL.EVENT_ID),
    clubName: cell(cells, COL.CLUB_NAME),
    token: cell(cells, COL.TOKEN),
    version: Number(cell(cells, COL.VERSION)) || 1,
    generatedBy: cell(cells, COL.GENERATED_BY),
    generatedAt: cell(cells, COL.GENERATED_AT),
    revokedAt,
    revokedBy: cell(cells, COL.REVOKED_BY),
    revokedReason: cell(cells, COL.REVOKED_REASON),
    tag: cell(cells, COL.TAG),
    status: (revokedAt ? UserStatus.INACTIVE : UserStatus.ACTIVE) as Status,
  };
}

function linkToRow(l: Link): string[] {
  const row = new Array(WIDTH).fill('');
  row[COL.LINK_ID] = l.linkId;
  row[COL.EVENT_ID] = l.eventId;
  row[COL.CLUB_NAME] = l.clubName;
  row[COL.TOKEN] = l.token;
  row[COL.VERSION] = String(l.version);
  row[COL.GENERATED_BY] = l.generatedBy;
  row[COL.GENERATED_AT] = l.generatedAt;
  row[COL.REVOKED_AT] = l.revokedAt;
  row[COL.REVOKED_BY] = l.revokedBy;
  row[COL.REVOKED_REASON] = l.revokedReason;
  row[COL.TAG] = l.tag;
  return row;
}

async function mirror(link: Link): Promise<void> {
  try {
    await firestore()
      .collection('uploadLinks')
      .doc(link.linkId)
      .set({ ...link, source: 'sheet-write', updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    logger.warn({ err, linkId: link.linkId }, 'link cache mirror failed (non-fatal)');
  }
}

export async function listLinks(
  spreadsheetId: string,
  filter?: { eventId?: string; clubName?: string; status?: Status },
): Promise<Link[]> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.LINK_ID, 'linkid');
  let links = rows.map((r) => rowToLink(r.cells));
  if (filter?.eventId !== undefined) links = links.filter((l) => l.eventId === filter.eventId);
  if (filter?.clubName !== undefined) links = links.filter((l) => l.clubName === filter.clubName);
  if (filter?.status !== undefined) links = links.filter((l) => l.status === filter.status);
  return links;
}

/** Active link for a (eventId, clubName, tag) triple, or null. */
export async function findActiveLink(
  spreadsheetId: string,
  eventId: string,
  clubName: string,
  tag: string,
): Promise<Link | null> {
  const links = await listLinks(spreadsheetId, { eventId, clubName, status: UserStatus.ACTIVE });
  return links.find((l) => l.tag === tag) ?? null;
}

/** Resolve a token to its active link (volunteer-upload validation helper). */
export async function findByToken(spreadsheetId: string, token: string): Promise<Link | null> {
  if (!token.trim()) return null;
  const links = await listLinks(spreadsheetId);
  return links.find((l) => l.token === token && l.status === UserStatus.ACTIVE) ?? null;
}

export async function generateLink(
  spreadsheetId: string,
  input: { eventId: string; clubName: string; tag?: string | undefined },
  actorEmail: string,
): Promise<Link> {
  const eventId = input.eventId.trim();
  const clubName = input.clubName.trim();
  if (!eventId || !clubName) throw new LinkStoreError('invalid', 'eventId and clubName are required');
  const rawTag = (input.tag ?? '').trim();
  if (rawTag && !TAG_RE.test(rawTag)) {
    throw new LinkStoreError('invalid', `Invalid tag: "${rawTag}"`);
  }
  const tag = rawTag || DEFAULT_TAG;

  return withTabLock(TAB, async () => {
    const existing = await findActiveLink(spreadsheetId, eventId, clubName, tag);
    if (existing) return existing; // idempotent: don't create a duplicate active link

    const link: Link = {
      linkId: randomUUID(),
      eventId,
      clubName,
      token: generateToken(),
      version: 1,
      generatedBy: actorEmail.trim().toLowerCase(),
      generatedAt: new Date().toISOString(),
      revokedAt: '',
      revokedBy: '',
      revokedReason: '',
      tag,
      status: UserStatus.ACTIVE,
    };
    await appendSheetValues(spreadsheetId, `${TAB}!A1`, [linkToRow(link)]);
    await mirror(link);
    return link;
  });
}

export async function revokeLink(
  spreadsheetId: string,
  linkId: string,
  reason: string,
  actorEmail: string,
): Promise<Link> {
  return withTabLock(TAB, async () => {
    const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.LINK_ID, 'linkid');
    const hit = rows.find((r) => cell(r.cells, COL.LINK_ID) === linkId);
    if (!hit) throw new LinkStoreError('not_found', `Link not found: ${linkId}`);
    const link = rowToLink(hit.cells);
    if (link.status === UserStatus.INACTIVE) {
      throw new LinkStoreError('already_revoked', `Link already revoked: ${linkId}`);
    }
    const updated: Link = {
      ...link,
      revokedAt: new Date().toISOString(),
      revokedBy: actorEmail.trim().toLowerCase(),
      revokedReason: reason.trim(),
      status: UserStatus.INACTIVE,
    };
    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [linkToRow(updated)]);
    await mirror(updated);
    return updated;
  });
}

/** Revoke the current link and issue a fresh one for the same triple (v+1). */
export async function rotateLink(
  spreadsheetId: string,
  linkId: string,
  actorEmail: string,
  reason = 'Rotated',
): Promise<Link> {
  const revoked = await revokeLink(spreadsheetId, linkId, reason, actorEmail);
  return withTabLock(TAB, async () => {
    const link: Link = {
      linkId: randomUUID(),
      eventId: revoked.eventId,
      clubName: revoked.clubName,
      token: generateToken(),
      version: revoked.version + 1,
      generatedBy: actorEmail.trim().toLowerCase(),
      generatedAt: new Date().toISOString(),
      revokedAt: '',
      revokedBy: '',
      revokedReason: '',
      tag: revoked.tag,
      status: UserStatus.ACTIVE,
    };
    await appendSheetValues(spreadsheetId, `${TAB}!A1`, [linkToRow(link)]);
    await mirror(link);
    return link;
  });
}
