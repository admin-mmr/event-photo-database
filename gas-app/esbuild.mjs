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

// ── Inject build timestamp into src/buildInfo.ts before bundling ─────────────
function writeBuildInfo() {
  const now = new Date().toISOString(); // e.g. "2026-04-20T14:32:00.000Z"
  const content = `// AUTO-GENERATED — do not edit. Rewritten on every \`npm run build\`.\nexport const BUILD_TIME = '${now}';\n`;
  writeFileSync(join(SRC, 'buildInfo.ts'), content, 'utf-8');
}

// ── Copy non-TS assets (HTML templates, appsscript.json) to dist ────────────
function copyAssets() {
  execSync(`rm -rf "${DIST}" && mkdir -p "${DIST}"`);
  execSync(`cp "${join(SRC, 'appsscript.json')}" "${join(DIST, 'appsscript.json')}"`);
  execSync(`cp -r "${join(SRC, 'ui')}" "${join(DIST, 'ui')}"`);
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
  writeBuildInfo();
  copyAssets();
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
  writeBuildInfo();
  copyAssets();
  await esbuild.build(buildOptions);
  unwrapIIFE(outfile);
  console.log('Build complete → dist/');
}
