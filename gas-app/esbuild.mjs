/**
 * esbuild.mjs — Bundles all TypeScript into a single GAS-compatible .js file.
 *
 * Why: clasp's built-in transpiler emits CommonJS require() calls that GAS
 *      cannot resolve (the "router_1 is not defined" error). Bundling with
 *      esbuild resolves all imports at build time and produces a single file
 *      with every function in the global scope — exactly what GAS expects.
 *
 * Usage:
 *   node esbuild.mjs            → one-shot build
 *   node esbuild.mjs --watch    → rebuild on change
 */

import esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const SRC  = join(__dirname, 'src');

// ── Inject build timestamp + git SHA into src/buildInfo.ts before bundling ──
function writeBuildInfo() {
  const now = new Date().toISOString(); // e.g. "2026-04-20T14:32:00.000Z"

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

  const buildCommit = `${sha}${dirty}`;
  const content =
`// AUTO-GENERATED — do not edit. Rewritten on every \`npm run build\`.
export const BUILD_TIME   = '${now}';
export const BUILD_COMMIT = '${buildCommit}';
`;
  writeFileSync(join(SRC, 'buildInfo.ts'), content, 'utf-8');
  return { buildTime: now, buildCommit };
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
// the build script substitutes __BUILD_TIME__ and __BUILD_COMMIT__ literals
// directly into the copied dist file so the client-side JS can render a
// build badge in the header without any server-side template changes.
//
function stampAppHtml(buildTime, buildCommit) {
  const path = join(DIST, 'ui', 'js', 'app.html');
  let content = readFileSync(path, 'utf-8');
  content = content.replaceAll('__BUILD_TIME__', buildTime);
  content = content.replaceAll('__BUILD_COMMIT__', buildCommit);
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
const isWatch = process.argv.includes('--watch');

if (isWatch) {
  const { buildTime, buildCommit } = writeBuildInfo();
  copyAssets();
  stampAppHtml(buildTime, buildCommit);
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
  const { buildTime, buildCommit } = writeBuildInfo();
  copyAssets();
  stampAppHtml(buildTime, buildCommit);
  await esbuild.build(buildOptions);
  unwrapIIFE(outfile);
  console.log('Build complete → dist/');
}
