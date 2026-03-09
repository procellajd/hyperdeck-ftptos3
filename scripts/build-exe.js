#!/usr/bin/env node

/**
 * Build standalone record2s3.exe using Node.js Single Executable Application (SEA).
 *
 * Requires Node.js 20+ (SEA is unreliable on earlier versions, and Node 18 is EOL).
 *
 * Pipeline:
 *   1. esbuild bundles src/cli.ts → dist/bundle.cjs
 *   2. node --experimental-sea-config generates sea-prep.blob
 *   3. Copy node.exe → record2s3.exe
 *   4. postject injects blob into record2s3.exe
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// ── Version check ──────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Node.js v20+ is required for SEA builds. Current: v${process.versions.node}`);
  console.error('Node 18 is EOL and its SEA support is unreliable.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BUNDLE   = resolve(root, 'dist/bundle.cjs');
const SEA_CONF = resolve(root, 'sea-config.json');
const BLOB     = resolve(root, 'sea-prep.blob');
const EXE      = resolve(root, 'record2s3.exe');

// ── Step 1: esbuild bundle ──────────────────────────────────────────
// Target the Node version being used for the build, since the SEA binary
// bundles its own Node runtime.
const nodeTarget = `node${major}`;
console.log(`\n[1/4] Bundling with esbuild (target: ${nodeTarget})...`);
await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: nodeTarget,
  minify: true,
  treeShaking: true,
  outfile: BUNDLE,
});

if (!existsSync(BUNDLE)) {
  console.error('esbuild failed — dist/bundle.cjs not found');
  process.exit(1);
}
console.log(`  → ${BUNDLE}`);

// ── Step 2: Generate SEA blob ───────────────────────────────────────
// --experimental-sea-config is the required flag through Node 22/24.
// The newer --build-sea flag (which eliminates the postject step) requires Node 25.5+.
// When this project targets Node 25+, this entire script can be simplified to:
//   node --build-sea sea-config.json
//
// Note: sea-config.json has useCodeCache:true for faster startup.
// This makes the blob platform-specific (must build on the target OS).
console.log('\n[2/4] Generating SEA blob...');
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONF], {
  stdio: 'inherit',
  cwd: root,
});

if (!existsSync(BLOB)) {
  console.error('SEA blob generation failed — sea-prep.blob not found');
  process.exit(1);
}
console.log(`  → ${BLOB}`);

// ── Step 3: Copy node.exe → record2s3.exe ───────────────────────────
console.log('\n[3/4] Copying node.exe → record2s3.exe...');
copyFileSync(process.execPath, EXE);
console.log(`  Copied ${process.execPath} → ${EXE}`);

// ── Step 4: Inject blob with postject ───────────────────────────────
console.log('\n[4/4] Injecting SEA blob into record2s3.exe...');
const blobData = readFileSync(BLOB);
await inject(EXE, 'NODE_SEA_BLOB', blobData, {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true,
});

console.log('\nBuild complete: ' + EXE);
