#!/usr/bin/env node

/**
 * Build standalone hdfs.exe using Node.js Single Executable Application (SEA).
 *
 * Pipeline:
 *   1. esbuild bundles src/cli.ts → dist/bundle.cjs
 *   2. node --experimental-sea-config generates sea-prep.blob
 *   3. Copy node.exe → hdfs.exe
 *   4. postject injects blob into hdfs.exe
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BUNDLE   = resolve(root, 'dist/bundle.cjs');
const SEA_CONF = resolve(root, 'sea-config.json');
const BLOB     = resolve(root, 'sea-prep.blob');
const EXE      = resolve(root, 'hdfs.exe');

// ── Step 1: esbuild bundle ──────────────────────────────────────────
console.log('\n[1/4] Bundling with esbuild...');
await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
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

// ── Step 3: Copy node.exe → hdfs.exe ────────────────────────────────
console.log('\n[3/4] Copying node.exe → hdfs.exe...');
copyFileSync(process.execPath, EXE);
console.log(`  Copied ${process.execPath} → ${EXE}`);

// ── Step 4: Inject blob with postject ───────────────────────────────
console.log('\n[4/4] Injecting SEA blob into hdfs.exe...');
const blobData = readFileSync(BLOB);
await inject(EXE, 'NODE_SEA_BLOB', blobData, {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true,
});

console.log('\nBuild complete: ' + EXE);
