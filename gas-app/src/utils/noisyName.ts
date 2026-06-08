/**
 * noisyName.ts — shared filename canonicalization.
 *
 * Drive decorates filenames when the same item is duplicated:
 *   - "Make a copy"      → "Copy of X"          (prefix, can stack)
 *   - re-upload same name → "X (1)", "X (2)", … (counter suffix)
 *
 * Both the post-upload duplicate scan (duplicateCleanupService) and the
 * special-folder shortcut dedupe (specialFoldersService) need to recognise
 * these decorations, so the logic lives here to keep the two callers in
 * lock-step and to avoid a circular import between those services.
 *
 * Pure — no GAS globals — so it runs in unit tests without mocks.
 */

/**
 * Strips Drive's duplicate-noise decorations from a filename:
 *   - one or more leading "Copy of " prefixes (any case), and
 *   - a single trailing " (N)" counter before the extension.
 *
 * Returns the canonical base name plus whether anything was stripped.
 *
 *   "Copy of a.jpeg"        → { base: "a.jpeg",  noisy: true }
 *   "a (1).jpeg"            → { base: "a.jpeg",  noisy: true }
 *   "Copy of a (2).jpeg"    → { base: "a.jpeg",  noisy: true }
 *   "a.jpeg"                → { base: "a.jpeg",  noisy: false }
 */
export function parseNoisyName(name: string): { base: string; noisy: boolean } {
  let base = name;
  let noisy = false;

  // Leading "Copy of " (possibly stacked: "Copy of Copy of x").
  const copyPrefix = /^copy of /i;
  while (copyPrefix.test(base)) {
    base = base.replace(copyPrefix, '');
    noisy = true;
  }

  // Trailing " (N)" before the extension ("a (1).jpeg") or at the very end
  // for extension-less names ("a (1)").
  const withExt = base.match(/^(.*) \(\d+\)(\.[^.]*)$/);
  if (withExt) {
    base = `${withExt[1]}${withExt[2]}`;
    noisy = true;
  } else {
    const noExt = base.match(/^(.*) \(\d+\)$/);
    if (noExt) {
      base = noExt[1];
      noisy = true;
    }
  }

  return { base, noisy };
}
