/**
 * esbuild.mjs — Bundles all TypeScript into a single GAS-compatible .js file.
 *
 * Why: clasp's built-in transpiler emits CommonJS require() calls that GAS
 *      cannot resolve (the "router_1 is not defined" error). Bundling with
 *      esbuild resolves all imports at build time and produces a single file
 *      with every function in the global scope — exactly what GAS expects.
 *
 * Usage:
 *   node esbuild.mjs                → one-shot full build
 *   node esbuild.mjs --watch        → rebuild on change
 *   node esbuild.mjs --stamp-only   → refresh BUILD_TIME / BUILD_COMMIT on
 *                                    already-bundled artifacts (fast path —
 *                                    runs right before `clasp push` so the
 *                                    displayed build time reflects deploy
 *                                    moment, not the start of the bundle).
 */

import esbuild from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const SRC  = join(__dirname, 'src');

// ── Capture the current build metadata (timestamp + git sha) ─────────────────
function captureBuildMetadata() {
  const buildTime = new Date().toISOString(); // e.g. "2026-04-29T22:32:00.000Z"

  // Best-effort git metadata — never fail the build if git is missing or the
  // workspace isn't a repo.
  let sha = 'unknown';
  let dirty = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname })
      .toString().trim();
    const status = execSync('git status --porcelain', { cwd: __dirname })
      .toString().trim();
    if (status.length > 0) dirty = '-dirty';
  } catch {
    // git not available or not a repo — leave sha = 'unknown'
  }

  return { buildTime, buildCommit: `${sha}${dirty}` };
}

// ── Inject build metadata into src/buildInfo.ts before bundling ──────────────
function writeBuildInfo({ buildTime, buildCommit }) {
  const content =
`// AUTO-GENERATED — do not edit. Rewritten on every \`npm run build\`.
export const BUILD_TIME   = '${buildTime}';
export const BUILD_COMMIT = '${buildCommit}';
`;
  writeFileSync(join(SRC, 'buildInfo.ts'), content, 'utf-8');
}

// ── Copy non-TS assets (HTML templates, appsscript.json) to dist ────────────
function copyAssets() {
  execSync(`rm -rf "${DIST}" && mkdir -p "${DIST}"`);
  execSync(`cp "${join(SRC, 'appsscript.json')}" "${join(DIST, 'appsscript.json')}"`);
  execSync(`cp -r "${join(SRC, 'ui')}" "${join(DIST, 'ui')}"`);
}

// ── Stamp build time + commit into dist/ui/js/app.html ──────────────────────
//
// app.html is a plain HTML file served via HtmlService.createHtmlOutputFromFile
// (not a GAS template), so it can't use <?= buildTime ?> scriptlets. Instead
// the build script substitutes the values directly into the copied dist file.
//
// The replacement is regex-based on the variable assignment so this function
// works both for the first stamp (replacing the __BUILD_TIME__ placeholders
// after copyAssets) and for re-stamping (replacing a previous timestamp during
// the --stamp-only fast path before clasp push).
//
function stampAppHtml({ buildTime, buildCommit }) {
  const path = join(DIST, 'ui', 'js', 'app.html');
  if (!existsSync(path)) return;
  let content = readFileSync(path, 'utf-8');
  content = content.replace(
    /var buildTime\s+=\s+'[^']*';/,
    `var buildTime   = '${buildTime}';`,
  );
  content = content.replace(
    /var buildCommit\s+=\s+'[^']*';/,
    `var buildCommit = '${buildCommit}';`,
  );
  writeFileSync(path, content, 'utf-8');
}

// ── Stamp build time + commit into dist/Code.js ─────────────────────────────
//
// BUILD_TIME / BUILD_COMMIT are imported from src/buildInfo.ts and end up
// emitted by esbuild as plain `var BUILD_TIME = "..."` / `var BUILD_COMMIT = "..."`
// declarations in dist/Code.js. The --stamp-only fast path patches those lines
// in place so we can refresh the displayed build time without paying for a
// full re-bundle. (No-op if dist/Code.js doesn't exist yet, e.g. on a fresh
// clone where someone runs `npm run stamp` before `npm run build`.)
//
function stampCodeJs({ buildTime, buildCommit }) {
  const path = join(DIST, 'Code.js');
  if (!existsSync(path)) return;
  let content = readFileSync(path, 'utf-8');
  content = content.replace(
    /var BUILD_TIME\s+=\s+"[^"]*";/,
    `var BUILD_TIME = "${buildTime}";`,
  );
  content = content.replace(
    /var BUILD_COMMIT\s+=\s+"[^"]*";/,
    `var BUILD_COMMIT = "${buildCommit}";`,
  );
  writeFileSync(path, content, 'utf-8');
}

// ── Post-process: unwrap IIFE so functions land in global scope ─────────────
//
// esbuild with format:'iife' emits:  (() => { ...code... })();
// GAS needs all functions at the top level. We strip the IIFE wrapper.
//
function unwrapIIFE(filePath) {
  let code = readFileSync(filePath, 'utf-8');

  // Remove opening  (() => {\n  and closing  })();\n
  // The IIFE starts after "use strict";
  code = code.replace(/^\(\(\) => \{\n/m, '');
  code = code.replace(/\}\)\(\);\s*$/, '');

  // Un-indent one level (esbuild indents IIFE body by 2 spaces)
  code = code.replace(/^  /gm, '');

  writeFileSync(filePath, code);
}

// ── esbuild config ──────────────────────────────────────────────────────────
const outfile = join(DIST, 'Code.js');

const buildOptions = {
  entryPoints: [join(SRC, 'main.ts')],
  bundle: true,
  treeShaking: false,           // GAS needs all top-level functions preserved
  format: 'iife',
  outfile,
  target: 'es2019',
  charset: 'utf8',
  logLevel: 'info',
};

// ── Run ─────────────────────────────────────────────────────────────────────
const isWatch     = process.argv.includes('--watch');
const isStampOnly = process.argv.includes('--stamp-only');

if (isStampOnly) {
  // Fast path: refresh BUILD_TIME / BUILD_COMMIT on the existing dist artifacts
  // and resync src/buildInfo.ts. Used by `npm run push` immediately before
  // `clasp push` so the timestamp the user sees on the deployed app is the
  // moment of deploy, not the moment the (slower) bundle step started.
  const meta = captureBuildMetadata();
  writeBuildInfo(meta);
  stampAppHtml(meta);
  stampCodeJs(meta);
  console.log(`Stamp refreshed → ${meta.buildTime} (${meta.buildCommit})`);
} else if (isWatch) {
  const meta = captureBuildMetadata();
  writeBuildInfo(meta);
  copyAssets();
  stampAppHtml(meta);
  const ctx = await esbuild.context({
    ...buildOptions,
    plugins: [{
      name: 'unwrap-iife',
      setup(build) {
        build.onEnd(() => { unwrapIIFE(outfile); });
      },
    }],
  });
  await ctx.watch();
  console.log('Watching for changes…');
} else {
  const meta = captureBuildMetadata();
  writeBuildInfo(meta);
  copyAssets();
  stampAppHtml(meta);
  await esbuild.build(buildOptions);
  unwrapIIFE(outfile);
  console.log('Build complete → dist/');
}
