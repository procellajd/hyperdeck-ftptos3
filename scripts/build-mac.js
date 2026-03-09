#!/usr/bin/env node

/**
 * Build standalone record2s3 macOS binary using Node.js Single Executable Application (SEA).
 *
 * Requires Node.js 20+ on macOS.
 *
 * Pipeline:
 *   1. esbuild bundles src/cli.ts → dist/bundle.cjs
 *   2. node --experimental-sea-config generates sea-prep.blob
 *   3. Copy node binary → record2s3
 *   4. codesign --remove-signature (required on macOS before injection)
 *   5. postject injects blob into record2s3
 *   6. codesign --sign - (ad-hoc re-sign so macOS allows execution)
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// ── Platform check ──────────────────────────────────────────────────
if (process.platform !== 'darwin') {
  console.error('This script builds a macOS binary. Use build-exe.js for Windows.');
  process.exit(1);
}

// ── Version check ──────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Node.js v20+ is required for SEA builds. Current: v${process.versions.node}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BUNDLE   = resolve(root, 'dist/bundle.cjs');
const SEA_CONF = resolve(root, 'sea-config.json');
const BLOB     = resolve(root, 'sea-prep.blob');
const BIN      = resolve(root, 'record2s3');

// ── Step 1: esbuild bundle ──────────────────────────────────────────
const nodeTarget = `node${major}`;
console.log(`\n[1/6] Bundling with esbuild (target: ${nodeTarget})...`);
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
console.log('\n[2/6] Generating SEA blob...');
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONF], {
  stdio: 'inherit',
  cwd: root,
});

if (!existsSync(BLOB)) {
  console.error('SEA blob generation failed — sea-prep.blob not found');
  process.exit(1);
}
console.log(`  → ${BLOB}`);

// ── Step 3: Copy node binary → record2s3 ────────────────────────────
console.log('\n[3/6] Copying node binary → record2s3...');
copyFileSync(process.execPath, BIN);
chmodSync(BIN, 0o755);
console.log(`  Copied ${process.execPath} → ${BIN}`);

// ── Step 4: Remove existing code signature ──────────────────────────
console.log('\n[4/6] Removing code signature...');
execFileSync('codesign', ['--remove-signature', BIN], { stdio: 'inherit' });
console.log('  Signature removed');

// ── Step 5: Inject blob with postject ───────────────────────────────
console.log('\n[5/6] Injecting SEA blob...');
const blobData = readFileSync(BLOB);
await inject(BIN, 'NODE_SEA_BLOB', blobData, {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true,
  machoSegmentName: 'NODE_SEA',
});

// ── Step 6: Ad-hoc re-sign ──────────────────────────────────────────
console.log('\n[6/6] Re-signing binary (ad-hoc)...');
execFileSync('codesign', ['--sign', '-', BIN], { stdio: 'inherit' });

console.log('\nBuild complete: ' + BIN);
console.log(`Size: ${(readFileSync(BIN).length / 1024 / 1024).toFixed(1)} MB`);
