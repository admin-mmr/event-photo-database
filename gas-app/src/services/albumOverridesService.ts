/**
 * albumOverridesService.ts — admin-managed override map for albums the
 * Photos Library API can't see.
 *
 * Why this exists
 * ---------------
 * Our OAuth scopes (`photoslibrary.appendonly` +
 * `photoslibrary.edit.appcreateddata`) only allow `albums.get` to succeed
 * for albums this exact app created. Albums that exist in the user's
 * Google Photos but were created by a different OAuth client (e.g. a
 * previous deployment, a manual `photos.google.com` create, an album
 * imported from another tool) come back 403/404 — even after the user
 * manually shares them.
 *
 * For those albums we can't programmatically detect whether sharing is
 * enabled or read the shareable URL, so we let the admin pin the values
 * by hand via a Script Property:
 *
 *   ALBUM_OVERRIDES = {
 *     "<albumId>": {
 *       "permission":   "Public" | "Private",
 *       "shareableUrl": "https://photos.app.goo.gl/..."   // optional
 *     },
 *     ...
 *   }
 *
 * The rebuild and reconciliation paths look up each album in the override
 * map; if a key is present, its values win over whatever the live API
 * returned. This is the smallest-change escape hatch for the
 * post-March-2025 API limitation — no schema migration required.
 *
 * Set up:
 *   1. GAS editor → Project Settings → Script Properties.
 *   2. Add property `ALBUM_OVERRIDES` with a JSON object value.
 *   3. Run rebuildPublicAlbumIndex() to apply.
 */

/* global PropertiesService, Logger */

/** Property name read from PropertiesService. */
const PROP_KEY = 'ALBUM_OVERRIDES';

/** Allowed values for the `permission` field. */
export type OverridePermission = 'Public' | 'Private';

/**
 * One entry in the override map. Both fields are optional so an admin can
 * pin only what they know — for example the permission label without a
 * shareable URL, or vice versa.
 */
export interface AlbumOverride {
  readonly permission?:   OverridePermission;
  readonly shareableUrl?: string;
}

/**
 * Reads and parses the ALBUM_OVERRIDES script property.
 *
 * Tolerant of missing / blank / malformed values — every failure path
 * returns an empty map and logs once. This means a typo in the JSON
 * never breaks the rebuild; the only consequence is the override won't
 * apply until it's fixed.
 */
export function loadAlbumOverrides(): Map<string, AlbumOverride> {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEY);
  if (!raw || !raw.trim()) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    Logger.log(
      `[albumOverrides] ${PROP_KEY} is not valid JSON; ignoring. Error: ${String(err)}`
    );
    return new Map();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    Logger.log(
      `[albumOverrides] ${PROP_KEY} must be a JSON object keyed by albumId; ignoring.`
    );
    return new Map();
  }

  const out = new Map<string, AlbumOverride>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const normalized = normalizeEntry(value);
    if (normalized) out.set(key, normalized);
  }
  return out;
}

/**
 * Validates one override entry. Returns null for malformed entries so
 * callers can silently skip without failing the whole rebuild.
 */
function normalizeEntry(value: unknown): AlbumOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  let permission: OverridePermission | undefined;
  if (typeof v.permission === 'string') {
    if (v.permission === 'Public' || v.permission === 'Private') {
      permission = v.permission;
    } else {
      Logger.log(
        `[albumOverrides] permission must be "Public" or "Private"; got "${v.permission}"`
      );
    }
  }

  let shareableUrl: string | undefined;
  if (typeof v.shareableUrl === 'string' && v.shareableUrl.trim()) {
    shareableUrl = v.shareableUrl.trim();
  }

  if (!permission && !shareableUrl) return null;
  return { permission, shareableUrl };
}
