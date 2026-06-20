/**
 * Unit tests for the shortcut-target sharing fix.
 *
 * Background: a native Drive shortcut inherits the TARGET file's permissions,
 * not the containing folder's. Sharing the Album/Videos/Photos_NNN folder is
 * therefore NOT enough for anyone-with-link viewers to download — the target
 * must be shared too. These tests pin that behaviour for both edited paths:
 *
 *   1. linkTargetsIntoShortcutFolder() — Album/Videos: grant EVERY target
 *      (new and already-linked, so old shortcuts self-heal) and only create a
 *      shortcut for not-yet-linked targets.
 *   2. materializePhotoIntoBucket() — Photos_NNN fallback: when a photo falls
 *      back to a shortcut, its target gets granted too.
 *
 * Strategy:
 *   - Path 1 is dependency-injected, so it needs no module mocks — we pass
 *     jest.fn() collaborators directly.
 *   - Path 2 calls module-level collaborators, so we mock driveShortcutClient
 *     (createDriveShortcut) and drivePermissionsService (tryGrantAnyoneRead),
 *     keeping the rest of each module real via requireActual.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks for materializePhotoIntoBucket (path 2) ────────────────────────────

const mockCreateDriveShortcut = jest.fn();
jest.mock('../../src/services/driveShortcutClient', () => ({
  ...jest.requireActual('../../src/services/driveShortcutClient'),
  createDriveShortcut: (...args: unknown[]) => mockCreateDriveShortcut(...args),
}));

const mockTryGrantAnyoneRead = jest.fn();
jest.mock('../../src/services/drivePermissionsService', () => ({
  ...jest.requireActual('../../src/services/drivePermissionsService'),
  tryGrantAnyoneRead: (...args: unknown[]) => mockTryGrantAnyoneRead(...args),
}));

import {
  linkTargetsIntoShortcutFolder,
  materializePhotoIntoBucket,
  LinkTargetsDeps,
} from '../../src/services/specialFoldersService';

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Path 1: linkTargetsIntoShortcutFolder ────────────────────────────────────

describe('linkTargetsIntoShortcutFolder()', () => {
  const target = (id: string) => ({ id, name: `${id}.jpg` });

  function deps(overrides: Partial<LinkTargetsDeps> = {}): {
    deps: LinkTargetsDeps;
    granted: string[];
    created: Array<[string, string, string]>;
  } {
    const granted: string[] = [];
    const created: Array<[string, string, string]> = [];
    const base: LinkTargetsDeps = {
      grantTarget: (id) => { granted.push(id); },
      createShortcut: (folderId, targetId, name) => {
        created.push([folderId, targetId, name]);
        return { ok: true };
      },
    };
    return { deps: { ...base, ...overrides }, granted, created };
  }

  it('grants Anyone-read on EVERY target, including already-linked ones', () => {
    const { deps: d, granted } = deps();
    const targets = [target('a'), target('b'), target('c')];
    const existing = new Set(['b']); // b already has a shortcut

    linkTargetsIntoShortcutFolder('folder1', 'Album', targets, existing, d);

    expect(granted.sort()).toEqual(['a', 'b', 'c']); // self-heals 'b' too
  });

  it('creates a shortcut only for targets that are not yet linked', () => {
    const { deps: d, created } = deps();
    const targets = [target('a'), target('b'), target('c')];
    const existing = new Set(['b']);

    const res = linkTargetsIntoShortcutFolder('folder1', 'Album', targets, existing, d);

    expect(created.map(([, t]) => t).sort()).toEqual(['a', 'c']);
    expect(res.shortcutsCreated).toBe(2);
    expect(res.shortcutsExisting).toBe(1);
    expect(res.warnings).toEqual([]);
  });

  it('still grants the target when shortcut creation fails, and records a warning', () => {
    const { deps: base, granted } = deps();
    const d: LinkTargetsDeps = {
      ...base,
      createShortcut: () => ({ ok: false, error: 'HTTP 500' }),
    };

    const res = linkTargetsIntoShortcutFolder('folder1', 'Album', [target('a')], new Set(), d);

    expect(granted).toEqual(['a']);            // permission still attempted
    expect(res.shortcutsCreated).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('a.jpg');
    expect(res.warnings[0]).toContain('Album');
  });

  it('grants every target exactly once', () => {
    const grant = jest.fn();
    const d: LinkTargetsDeps = { grantTarget: grant, createShortcut: () => ({ ok: true }) };

    linkTargetsIntoShortcutFolder('f', 'Videos', [target('x'), target('y')], new Set(), d);

    expect(grant).toHaveBeenCalledTimes(2);
    expect(grant).toHaveBeenCalledWith('x');
    expect(grant).toHaveBeenCalledWith('y');
  });
});

// ── Path 2: materializePhotoIntoBucket fallback ──────────────────────────────

describe('materializePhotoIntoBucket() shortcut fallback', () => {
  const photo = { id: 'photo123', name: 'shot.png', mimeType: 'image/png' };
  const ctx = () => ({
    index: 1,
    folderName: 'Photos_001',
    folderId: 'bucketFolder',
    usedNames: new Set<string>(),
    placed: 0,
  });

  it('grants Anyone-read on the target after a successful fallback shortcut', () => {
    mockCreateDriveShortcut.mockReturnValue({ ok: true, shortcutId: 'sc1', status: 200 });
    const warnings: string[] = [];

    const outcome = materializePhotoIntoBucket(
      photo as any,
      ctx() as any,
      /* cloudRunReady */ false,
      warnings,
      /* allowShortcutFallback */ true
    );

    expect(outcome).toBe('shortcut');
    expect(mockCreateDriveShortcut).toHaveBeenCalledWith('bucketFolder', 'photo123', 'shot.png');
    expect(mockTryGrantAnyoneRead).toHaveBeenCalledWith('photo123');
    expect(warnings).toEqual([]);
  });

  it('does NOT grant when the fallback shortcut creation fails', () => {
    mockCreateDriveShortcut.mockReturnValue({ ok: false, error: 'HTTP 500', status: 500 });
    const warnings: string[] = [];

    const outcome = materializePhotoIntoBucket(
      photo as any,
      ctx() as any,
      false,
      warnings,
      true
    );

    expect(outcome).toBe('failed');
    expect(mockTryGrantAnyoneRead).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
  });

  it('creates no shortcut and grants nothing when fallback is disallowed (migration mode)', () => {
    const warnings: string[] = [];

    const outcome = materializePhotoIntoBucket(
      photo as any,
      ctx() as any,
      false,
      warnings,
      /* allowShortcutFallback */ false
    );

    expect(outcome).toBe('skipped');
    expect(mockCreateDriveShortcut).not.toHaveBeenCalled();
    expect(mockTryGrantAnyoneRead).not.toHaveBeenCalled();
  });
});
