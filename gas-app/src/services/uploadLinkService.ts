import { ResultStatus } from '../types/enums';
import { UploadLinkRecord } from '../types/models';
import { GenerateLinkInput, RevokeLinkInput, ValidateLinkInput } from '../types/requests';
import { ServiceResult } from '../types/responses';
import { getConfig, DEFAULT_TAG } from '../config/constants';
import { getAllRows, appendRow, findRowIndex, updateRow } from './sheetService';
import { toUploadLinkRecord, fromUploadLinkRecord } from '../utils/sheetMapper';
import { generateUuid } from '../utils/uuid';

/* global Utilities */

/**
 * UploadLinkService — CRUD for per-(event, club, tag) upload links.
 *
 * Design rules from DESIGN_DECISIONS.md §4:
 *   - One unique active link per (event, club, tag) triple. Permanent (no expiration).
 *   - `tag` is an optional photographer/location label (e.g. "finish_line").
 *     An empty tag means "all" — uploads go into the club folder directly.
 *     A non-empty tag routes uploads into a subfolder named after the tag.
 *   - Bearer-token semantics: anyone with the URL + a Google account can upload.
 *   - Revocable and rotatable by club admins (own club) or super admins (any).
 *   - Audit trail records the link version for forensic integrity after rotation.
 *
 * The URL structure is:
 *   <app_url>?action=upload_link&token=<TOKEN>
 *
 * Token generation uses a cryptographically random 32-byte value encoded as
 * URL-safe base64 (no padding). GAS Utilities.computeDigest / getUuid are used
 * since crypto.getRandomValues is unavailable in GAS.
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

function loadAllLinks(): UploadLinkRecord[] {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.UPLOAD_LINKS);
  return rows
    .map(toUploadLinkRecord)
    .filter((r): r is UploadLinkRecord => r !== null);
}

/**
 * Generates a URL-safe random token.
 * Uses Utilities.getUuid() (GAS built-in) as a source of entropy; two UUIDs
 * concatenated and encoded give sufficient token space (64 hex chars, ~256 bits).
 */
function generateToken(): string {
  const raw = generateUuid().replace(/-/g, '') + generateUuid().replace(/-/g, '');
  // Convert to URL-safe base64-like string without padding
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes())
    .replace(/=/g, '');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Looks up an upload link by its token.
 *
 * Used on the link landing page to show confirmation info before Google login.
 * Returns the full UploadLinkRecord including revocation state.
 * Returns null if no record matches the token.
 */
export function findByToken(token: string): UploadLinkRecord | null {
  if (!token || !token.trim()) return null;
  const normalized = token.trim();
  return loadAllLinks().find((r) => r.token === normalized) ?? null;
}

/**
 * Looks up the single active (non-revoked) link for a given (eventId, clubName, tag) triple.
 * `tag` defaults to '' (no tag / "all") when not supplied.
 * Returns null if no active link exists for the triple.
 */
export function findActiveLink(eventId: string, clubName: string, tag = DEFAULT_TAG): UploadLinkRecord | null {
  const normalizedTag = tag.trim();
  return loadAllLinks().find(
    (r) =>
      r.eventId === eventId &&
      r.clubName === clubName &&
      (r.tag ?? '') === normalizedTag &&
      !r.revokedAt
  ) ?? null;
}

/**
 * Returns all links (active and revoked) for a given eventId.
 * Used by the admin links management page.
 */
export function findByEvent(eventId: string): UploadLinkRecord[] {
  return loadAllLinks().filter((r) => r.eventId === eventId);
}

/**
 * Returns all links (active and revoked) for a given club.
 * Used by club admin's link management view.
 */
export function findByClub(clubName: string): UploadLinkRecord[] {
  return loadAllLinks().filter((r) => r.clubName === clubName);
}

/**
 * Validates an upload link token for use in the upload flow.
 *
 * Returns SUCCESS with the link record if the token is valid and not revoked.
 * Returns ERROR if the token is unknown or the link has been revoked.
 */
export function validateLink(input: ValidateLinkInput): ServiceResult<UploadLinkRecord> {
  if (!input.token || !input.token.trim()) {
    return { status: ResultStatus.ERROR, message: 'No link token provided.' };
  }

  const link = findByToken(input.token.trim());
  if (!link) {
    return {
      status: ResultStatus.ERROR,
      message: 'This link is not recognized. It may have been deleted or never existed.',
    };
  }

  if (link.revokedAt) {
    return {
      status: ResultStatus.ERROR,
      message:
        'This link has been revoked. Please contact your club administrator for a new link.',
    };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Link is valid',
    data: link,
  };
}

/**
 * Generates a new upload link for a (event, club, tag) triple.
 *
 * If an active link already exists for this triple, returns it without creating
 * a duplicate. If only revoked links exist, creates a fresh record.
 *
 * `tag` (from input) is optional. Empty / omitted → defaults to DEFAULT_TAG ('ALL'),
 * which creates an ALL/ subfolder inside the club folder, keeping the Drive
 * hierarchy uniform: Event / Club / Tag / batch_folders / files.
 * Non-empty tag → uploads go into a tag-named subfolder inside the club folder.
 *
 * Returns the UploadLinkRecord on success.
 */
export function generateLink(
  input: GenerateLinkInput,
  adminEmail: string
): ServiceResult<UploadLinkRecord> {
  const { eventId, clubName } = input;
  const tag = (input.tag ?? '').trim() || DEFAULT_TAG;

  if (!eventId || !clubName) {
    return { status: ResultStatus.ERROR, message: 'eventId and clubName are required.' };
  }

  // Return existing active link rather than creating a duplicate
  const existing = findActiveLink(eventId, clubName, tag);
  if (existing) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'An active link already exists for this event, club, and tag.',
      data: existing,
    };
  }

  const now = new Date().toISOString();
  const record: UploadLinkRecord = {
    linkId:        generateUuid(),
    eventId,
    clubName,
    token:         generateToken(),
    version:       1,
    generatedBy:   adminEmail.trim().toLowerCase(),
    generatedAt:   now,
    revokedAt:     '',
    revokedBy:     '',
    revokedReason: '',
    tag,
  };

  const config = getConfig();
  appendRow(config.SHEET_NAMES.UPLOAD_LINKS, fromUploadLinkRecord(record));

  const tagLabel = tag ? ` [${tag}]` : '';
  return {
    status: ResultStatus.SUCCESS,
    message: `Upload link generated for ${clubName}${tagLabel} / event ${eventId}`,
    data: record,
  };
}

/**
 * Revokes an existing upload link.
 *
 * Sets revokedAt, revokedBy, and revokedReason on the record.
 * The token becomes immediately invalid — holders of the old URL receive a
 * "link revoked" message when they next try to use it.
 *
 * To rotate a link: call revokeLink, then generateLink for the same pair.
 *
 * Returns ERROR if the link is not found or is already revoked.
 */
export function revokeLink(
  input: RevokeLinkInput,
  adminEmail: string
): ServiceResult<UploadLinkRecord> {
  const all = loadAllLinks();
  const existing = all.find((r) => r.linkId === input.linkId);

  if (!existing) {
    return { status: ResultStatus.ERROR, message: `Link "${input.linkId}" not found.` };
  }
  if (existing.revokedAt) {
    return {
      status: ResultStatus.ERROR,
      message: `Link "${input.linkId}" is already revoked.`,
    };
  }

  const now = new Date().toISOString();
  const updated: UploadLinkRecord = {
    ...existing,
    revokedAt:     now,
    revokedBy:     adminEmail.trim().toLowerCase(),
    revokedReason: input.reason?.trim() ?? '',
  };

  const config = getConfig();
  const rowIndex = findRowIndex(config.SHEET_NAMES.UPLOAD_LINKS, 0, existing.linkId);
  if (rowIndex < 0) {
    return {
      status: ResultStatus.ERROR,
      message: `Could not locate row for link "${existing.linkId}" in Upload_Links sheet.`,
    };
  }

  updateRow(config.SHEET_NAMES.UPLOAD_LINKS, rowIndex, fromUploadLinkRecord(updated));

  return {
    status: ResultStatus.SUCCESS,
    message: `Link "${input.linkId}" revoked.`,
    data: updated,
  };
}

/**
 * Rotates an upload link: revokes the current active link and immediately
 * issues a new one for the same (event, club, tag) triple.
 *
 * The new record gets version = existing.version + 1.
 * Returns the newly-generated link record on success.
 */
export function rotateLink(
  linkId: string,
  adminEmail: string,
  reason?: string
): ServiceResult<UploadLinkRecord> {
  const all = loadAllLinks();
  const existing = all.find((r) => r.linkId === linkId);

  if (!existing) {
    return { status: ResultStatus.ERROR, message: `Link "${linkId}" not found.` };
  }
  if (existing.revokedAt) {
    return {
      status: ResultStatus.ERROR,
      message: `Link "${linkId}" is already revoked. Use generateLink to create a new one.`,
    };
  }

  // Step 1: revoke current link
  const revokeResult = revokeLink(
    { linkId, reason: reason ?? 'Rotated' },
    adminEmail
  );
  if (revokeResult.status !== ResultStatus.SUCCESS) return revokeResult;

  // Step 2: issue new link — increment version so audit trail shows continuity
  // Preserve the tag from the existing link so the rotation stays in the same triple.
  const now = new Date().toISOString();
  const newRecord: UploadLinkRecord = {
    linkId:        generateUuid(),
    eventId:       existing.eventId,
    clubName:      existing.clubName,
    token:         generateToken(),
    version:       existing.version + 1,
    generatedBy:   adminEmail.trim().toLowerCase(),
    generatedAt:   now,
    revokedAt:     '',
    revokedBy:     '',
    revokedReason: '',
    tag:           existing.tag ?? '',
  };

  const config = getConfig();
  appendRow(config.SHEET_NAMES.UPLOAD_LINKS, fromUploadLinkRecord(newRecord));

  return {
    status: ResultStatus.SUCCESS,
    message: `Link rotated. Old token invalidated; new link issued (version ${newRecord.version}).`,
    data: newRecord,
  };
}

/**
 * Returns all upload link records (active and revoked).
 * Used by the super admin's full link management view.
 */
export function listAll(): UploadLinkRecord[] {
  return loadAllLinks();
}
