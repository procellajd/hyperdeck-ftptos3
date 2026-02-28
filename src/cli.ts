#!/usr/bin/env node
import { Command } from 'commander';
import * as readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { TransferManager } from './transfer-manager.js';
import { HyperDeckClient, type SlotStats } from './hyperdeck-client.js';
import { FtpClient } from './ftp-client.js';
import { StateManager } from './state-manager.js';
import { discoverFiles } from './file-browser.js';
import { interactiveSelect } from './interactive-select.js';
import { executeTransferQueue } from './transfer-queue.js';
import { log, logToFile } from './logger.js';
import type { BrowseEntry } from './file-browser.js';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { DestinationType } from './types.js';

/**
 * Wait for user to press any key, then exit.
 * Prevents the console window from closing before the user can read error messages
 * (common issue when running as a Windows .exe).
 */
function fatalExit(code = 1): never {
  if (process.stdin.isTTY) {
    console.error('\nPress any key to exit...');
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(code));
    } catch {
      process.exit(code);
    }
  } else {
    process.exit(code);
  }
  // Keep the process alive until the keypress handler fires
  // (the 'never' return type is satisfied by process.exit above for non-TTY)
  return undefined as never;
}

// Safety net: catch any truly unhandled errors so the process never silently exits
process.on('uncaughtException', (err) => {
  logToFile('FATAL', `Uncaught exception: ${err.message}`, err.stack);
  console.error(`[FATAL] Uncaught exception: ${err.message}`);
  if (err.stack) console.error(err.stack);
  fatalExit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logToFile('FATAL', `Unhandled rejection: ${msg}`, stack);
  console.error(`[FATAL] Unhandled rejection: ${msg}`);
  if (stack) console.error(stack);
  fatalExit(1);
});

process.on('exit', (code) => {
  logToFile('INFO', `Process exiting with code ${code}`);
});

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askQuestionMasked(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const buf: string[] = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (key: string) => {
      if (key === '\r' || key === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf.join('').trim());
      } else if (key === '\u0003') {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.exit(0);
      } else if (key === '\u007f' || key === '\b') {
        // Backspace
        if (buf.length > 0) {
          buf.pop();
          process.stdout.write('\b \b');
        }
      } else if (key >= ' ') {
        buf.push(key);
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

const envChanges = new Map<string, string>();

async function promptWithDefault(label: string, envKey: string, mask?: boolean): Promise<string> {
  const existing = process.env[envKey] || '';
  let display = existing;
  if (mask && existing.length > 4) {
    display = '*'.repeat(existing.length - 4) + existing.slice(-4);
  }
  const prompt = display
    ? `${label} [${display}]: `
    : `${label}: `;
  const answer = mask ? await askQuestionMasked(prompt) : await askQuestion(prompt);
  const value = answer || existing;
  if (value) process.env[envKey] = value;
  if (answer && answer !== existing) {
    envChanges.set(envKey, value);
  }
  return value;
}

/**
 * Arrow-key selector for a small list of options.
 * Renders options vertically with `>` cursor, user presses Up/Down to move, Enter to confirm.
 * Pre-selects the option matching the current env value (or first option).
 */
function arrowSelect(label: string, options: { label: string; value: string }[], envKey: string): Promise<string> {
  return new Promise((resolveValue) => {
    const current = process.env[envKey] || '';
    let selected = options.findIndex(o => o.value === current);
    if (selected < 0) selected = 0;

    const render = () => {
      // Move cursor up to overwrite previous render (except first render)
      if (rendered) {
        process.stdout.write(`\x1b[${options.length}A`);
      }
      for (let i = 0; i < options.length; i++) {
        const prefix = i === selected ? '  > ' : '    ';
        process.stdout.write(`\x1b[2K${prefix}${options[i].label}\n`);
      }
    };

    let rendered = false;
    console.log(`${label}:`);
    render();
    rendered = true;

    if (!process.stdin.isTTY) {
      // Non-interactive: use default
      resolveValue(options[selected].value);
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();

      // Up arrow: \x1b[A
      if (key === '\x1b[A' || key === 'k') {
        selected = (selected - 1 + options.length) % options.length;
        render();
        return;
      }
      // Down arrow: \x1b[B
      if (key === '\x1b[B' || key === 'j') {
        selected = (selected + 1) % options.length;
        render();
        return;
      }
      // Enter
      if (key === '\r' || key === '\n') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolveValue(options[selected].value);
        return;
      }
      // Ctrl+C — exit
      if (key === '\x03') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      }
    };

    process.stdin.on('data', onData);
  });
}

function saveEnvChanges(): void {
  if (envChanges.size === 0) return;

  const envPath = resolve(process.cwd(), '.env');
  let content = '';
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch {
    // No .env yet — will create one
  }

  for (const [key, value] of envChanges) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  writeFileSync(envPath, content, 'utf-8');
  console.log(`.env updated (${envChanges.size} value${envChanges.size > 1 ? 's' : ''} saved)`);
  envChanges.clear();
}

interface ClipMeta {
  codec: string;
  videoFormat: string;
  startTimecode: string;
  duration: string;
}

/** REST API response types for HyperDeck HTTP interface */
interface RestClip {
  codecName: string;
  frameRate: string;
  videoFormat: string;
  startTimecode: string;
  duration: string;
  name: string;
  fileSize?: number;
}

interface RestDeviceClipsResponse {
  clips: RestClip[];
}

interface RestWorkingSetDevice {
  name: string;
  clipCount: number;
}

interface RestWorkingSetResponse {
  devices: RestWorkingSetDevice[];
}

/**
 * Fetch clip metadata from HyperDeck REST API (HTTP port 80).
 * Uses GET /media/workingset to discover device names, then
 * GET /clips/devices/{deviceName} for per-clip structured JSON.
 * Best-effort with 5s timeout — returns empty map on any error.
 */
async function fetchClipMetadata(host: string): Promise<Map<string, ClipMeta>> {
  const result = new Map<string, ClipMeta>();
  const baseUrl = `http://${host}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    // Discover device names (one per slot with media)
    const wsResp = await fetch(`${baseUrl}/media/workingset`, { signal: controller.signal });
    if (!wsResp.ok) {
      log(`fetchClipMetadata: /media/workingset returned ${wsResp.status}`);
      return result;
    }

    const workingSet: RestWorkingSetResponse = await wsResp.json() as RestWorkingSetResponse;
    const devices = (workingSet.devices ?? []).filter(d => d.clipCount > 0);

    if (devices.length === 0) {
      log('fetchClipMetadata: no devices with clips in working set');
      return result;
    }

    log(`fetchClipMetadata: found ${devices.length} device(s): [${devices.map(d => d.name).join(', ')}]`);

    // Fetch clips for each device
    for (const device of devices) {
      try {
        const clipsResp = await fetch(
          `${baseUrl}/clips/devices/${encodeURIComponent(device.name)}`,
          { signal: controller.signal },
        );
        if (!clipsResp.ok) {
          log(`fetchClipMetadata: /clips/devices/${device.name} returned ${clipsResp.status}`);
          continue;
        }

        const body: RestDeviceClipsResponse = await clipsResp.json() as RestDeviceClipsResponse;

        for (const clip of body.clips ?? []) {
          result.set(clip.name, {
            codec: clip.codecName ?? '',
            videoFormat: clip.videoFormat ?? '',
            startTimecode: clip.startTimecode ?? '',
            duration: clip.duration ?? '',
          });
        }
      } catch (err) {
        log(`fetchClipMetadata: error fetching clips for ${device.name}: ${(err as Error).message}`);
      }
    }

    log(`fetchClipMetadata: collected metadata for ${result.size} clips`);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log('fetchClipMetadata: 5s timeout reached');
    } else {
      log(`fetchClipMetadata: error: ${(err as Error).message}`);
    }
  } finally {
    clearTimeout(timer);
  }

  return result;
}

/**
 * Fetch clip metadata via HyperDeck TCP protocol (port 9993).
 * Used as fallback when REST API returns no results.
 * Groups entries by slot, connects once, fetches disk list + clip info + slot stats.
 */
async function fetchClipMetadataTcp(
  host: string,
  entries: BrowseEntry[],
): Promise<{ metadata: Map<string, ClipMeta>; slotStats: Map<string, SlotStats> }> {
  const metadata = new Map<string, ClipMeta>();
  const slotStats = new Map<string, SlotStats>();

  const client = new HyperDeckClient(host);

  try {
    await client.connect();
    const deviceInfo = await client.getDeviceInfo();

    // FTP directories are named "ssd1", "ssd2", etc. — extract slot ID directly.
    // Also build volume-name map as fallback for non-ssd naming.
    const volumeToSlotId = new Map<string, number>();
    for (const slot of deviceInfo.slots) {
      if (slot.volumeName) {
        volumeToSlotId.set(slot.volumeName, slot.slotId);
      }
    }

    // Group entries by slot name
    const slotGroups = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (!slotGroups.has(entry.slot)) slotGroups.set(entry.slot, new Set());
      slotGroups.get(entry.slot)!.add(entry.name);
    }

    for (const [slotName, clipNames] of slotGroups) {
      // "ssd1" → 1, "ssd2" → 2, etc.
      const ssdMatch = slotName.match(/^ssd(\d+)$/i);
      const slotId = ssdMatch ? parseInt(ssdMatch[1], 10) : volumeToSlotId.get(slotName);
      if (slotId === undefined) {
        log(`fetchClipMetadataTcp: no slot id for "${slotName}"`);
        continue;
      }

      // Get clip metadata
      try {
        const clipMeta = await client.getClipMeta(slotId, clipNames);
        for (const [name, meta] of clipMeta) {
          metadata.set(name, meta);
        }
        log(`fetchClipMetadataTcp: slot ${slotId} (${slotName}) → ${clipMeta.size} clips`);
      } catch (err) {
        log(`fetchClipMetadataTcp: getClipMeta failed for slot ${slotId}: ${(err as Error).message}`);
      }

      // Get slot stats
      try {
        const stats = await client.getSlotStats(slotId);
        if (stats) {
          slotStats.set(slotName, stats);
          log(`fetchClipMetadataTcp: slot ${slotId} stats — ${stats.remainingSize} remaining`);
        }
      } catch (err) {
        log(`fetchClipMetadataTcp: getSlotStats failed for slot ${slotId}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log(`fetchClipMetadataTcp: connection error: ${(err as Error).message}`);
  } finally {
    await client.close();
  }

  return { metadata, slotStats };
}

async function runBrowse(ftpHost?: string): Promise<void> {
  console.log('--- Connection Setup ---\n');

  // HyperDeck IP
  if (ftpHost) {
    process.env['HDFS_FTP_HOST'] = ftpHost;
  } else {
    const host = await promptWithDefault('HyperDeck IP address', 'HDFS_FTP_HOST');
    if (!host) {
      console.error('No IP address provided');
      fatalExit(1);
    }
  }

  // Transfer destination
  const destination = await arrowSelect('Transfer destination', [
    { label: 'S3', value: 's3' },
    { label: 'Local / UNC path', value: 'local' },
  ], 'HDFS_DESTINATION') as DestinationType;

  process.env['HDFS_DESTINATION'] = destination;
  envChanges.set('HDFS_DESTINATION', destination);

  if (destination === 's3') {
    // S3/R2 settings
    const bucket = await promptWithDefault('S3/R2 Bucket', 'HDFS_S3_BUCKET');
    if (!bucket) {
      console.error('No bucket provided');
      fatalExit(1);
    }
    await promptWithDefault('S3/R2 Endpoint', 'HDFS_S3_ENDPOINT');
    await promptWithDefault('S3/R2 Access Key ID', 'HDFS_S3_ACCESS_KEY_ID', true);
    await promptWithDefault('S3/R2 Secret Access Key', 'HDFS_S3_SECRET_ACCESS_KEY', true);
  } else {
    // Local/UNC settings
    const outputDir = await promptWithDefault('Output directory', 'HDFS_FS_OUTPUT_DIR');
    if (!outputDir) {
      console.error('No output directory provided');
      fatalExit(1);
    }
  }

  saveEnvChanges();
  console.log('');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    fatalExit(1);
  }

  // Verify S3/R2 credentials before entering browse
  if (config.destination === 's3') {
    console.log(`Verifying access to s3://${config.s3.bucket}...`);
    let s3: S3Client | undefined;
    try {
      s3 = new S3Client({
        region: config.s3.region,
        ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
        forcePathStyle: config.s3.forcePathStyle,
        ...(config.s3.accessKeyId && config.s3.secretAccessKey
          ? { credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } }
          : {}),
      });
      await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
      s3.destroy();
      console.log('S3 credentials verified.\n');
    } catch (err) {
      s3?.destroy();
      console.error(`\nS3 credential check failed: ${(err as Error).message}`);
      console.error('Check your bucket name, endpoint, and access keys.');
      fatalExit(1);
    }
  }

  let entries;
  let skipDestinationCheck = false;
  while (true) {
    const ftpClient = new FtpClient(config.ftp);
    const stateManager = new StateManager(config.stateDir);

    try {
      console.log(`Connecting to FTP ${config.ftp.host}...`);
      await ftpClient.connect();
      entries = await discoverFiles(ftpClient, stateManager, config.s3, config.fs, config.destination, skipDestinationCheck);
      skipDestinationCheck = false;
      ftpClient.close();
    } catch (err) {
      console.error('Failed to list files:', (err as Error).message);
      fatalExit(1);
    }

    if (entries.length === 0) {
      console.log('No files found on HyperDeck');
      return;
    }

    // Enrich entries with clip metadata from HyperDeck REST API (best-effort)
    let metadata = new Map<string, ClipMeta>();
    let slotStats = new Map<string, SlotStats>();
    try {
      metadata = await fetchClipMetadata(config.ftp.host);
      log(`fetchClipMetadata returned ${metadata.size} clips: [${[...metadata.keys()].join(', ')}]`);
    } catch (err) {
      log(`fetchClipMetadata threw unexpectedly: ${(err as Error).message}`);
    }

    // TCP fallback when REST returns no results (e.g. /media/workingset 404)
    if (metadata.size === 0) {
      log('REST metadata empty — falling back to TCP protocol');
      try {
        const tcp = await fetchClipMetadataTcp(config.ftp.host, entries);
        metadata = tcp.metadata;
        slotStats = tcp.slotStats;
        log(`TCP fallback returned ${metadata.size} clips, ${slotStats.size} slot stats`);
      } catch (err) {
        log(`TCP fallback failed: ${(err as Error).message}`);
      }
    }

    for (const entry of entries) {
      const nameNoExt = entry.name.replace(/\.[^.]+$/, '');
      const meta = metadata.get(entry.name) ?? metadata.get(nameNoExt);
      if (meta) {
        entry.codec = meta.codec;
        entry.videoFormat = meta.videoFormat;
        entry.startTimecode = meta.startTimecode;
        entry.duration = meta.duration;
      }
    }

    log(`Entering interactiveSelect with ${entries.length} entries, stdin.isTTY=${process.stdin.isTTY}`);
    let result;
    try {
      result = await interactiveSelect(entries, slotStats);
    } catch (err) {
      logToFile('ERROR', `interactiveSelect threw: ${(err as Error).message}`, (err as Error).stack);
      console.error(`Browse UI error: ${(err as Error).message}`);
      fatalExit(1);
    }
    log(`interactiveSelect returned action=${result.action}, selected=${result.selected.length}`);

    if (result.action === 'quit') {
      return;
    }

    if (result.action === 'refresh') {
      continue;
    }

    if (result.action === 'clear') {
      const stateManager = new StateManager(config.stateDir);
      let cleared = 0;
      for (const entry of entries) {
        if (entry.uploadStatus && entry.transferId) {
          stateManager.deleteState(entry.transferId);
          cleared++;
        }
      }
      console.log(`Cleared ${cleared} upload status record${cleared !== 1 ? 's' : ''}`);
      skipDestinationCheck = true;
      continue; // re-discover files
    }

    // action === 'confirm'
    if (result.selected.length === 0) {
      console.log('No files selected');
      return;
    }

    console.log(`\nQueuing ${result.selected.length} file(s) for transfer...`);
    await executeTransferQueue(result.selected, config);
    continue;
  }
}

const program = new Command();

program
  .name('record2s3')
  .description('Stream files from HyperDeck FTP directly to S3-compatible or local storage')
  .version('1.0.0')
  .action(async () => {
    await runBrowse();
  });

program
  .command('transfer')
  .description('Transfer a single file from FTP to configured destination')
  .argument('<ftpPath>', 'Remote FTP path to transfer')
  .argument('[outputKey]', 'Output key/filename (default: filename from FTP path)')
  .action(async (ftpPath: string, outputKey?: string) => {
    const config = loadConfig();
    let resumeId: string | undefined;

    while (true) {
      const manager = new TransferManager(config);
      const cleanup = setupInteractiveControls(manager);

      try {
        const state = resumeId
          ? await manager.resume(resumeId)
          : await manager.transfer(ftpPath, outputKey);

        if (state.status !== 'completed') {
          cleanup();
          const action = await waitForResumeOrQuit();
          if (action === 'resume') {
            resumeId = state.transferId;
            continue;
          }
        }
        return;
      } catch (err) {
        console.error('Transfer failed:', (err as Error).message);
        fatalExit(1);
      } finally {
        cleanup();
      }
    }
  });

program
  .command('transfer-all')
  .description('Transfer all clips from HyperDeck')
  .option('--slot <id>', 'Slot number to transfer from', '1')
  .action(async (opts: { slot: string }) => {
    const config = loadConfig();

    if (!config.hyperdeckHost) {
      console.error('HDFS_HYPERDECK_HOST is required for clip discovery');
      fatalExit(1);
    }

    const hdClient = new HyperDeckClient(config.hyperdeckHost);
    const manager = new TransferManager(config);
    const cleanup = setupInteractiveControls(manager);

    try {
      await hdClient.connect();
      const slotId = parseInt(opts.slot, 10);
      const deviceInfo = await hdClient.getDeviceInfo();
      const clips = await hdClient.getClips(slotId);
      await hdClient.close();

      if (clips.length === 0) {
        console.log('No clips found');
        return;
      }

      // Get volume name for the slot to build correct FTP path (/ssd1/file.mxf)
      const slotInfo = deviceInfo.slots.find(s => s.slotId === slotId);
      const volumeName = slotInfo?.volumeName || `slot${slotId}`;

      console.log(`Found ${clips.length} clips to transfer from ${volumeName}`);

      for (const clip of clips) {
        const ftpPath = `/${volumeName}/${clip.name}`;
        console.log(`\nTransferring: ${clip.name}`);
        try {
          await manager.transfer(ftpPath);
        } catch (err) {
          console.error(`Failed to transfer ${clip.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error('Transfer-all failed:', (err as Error).message);
      fatalExit(1);
    } finally {
      cleanup();
    }
  });

program
  .command('resume')
  .description('Resume an interrupted transfer')
  .argument('[transferId]', 'Transfer ID to resume (auto-selects if only one)')
  .action(async (transferId?: string) => {
    const config = loadConfig();
    let resumeId = transferId;

    while (true) {
      const manager = new TransferManager(config);
      const cleanup = setupInteractiveControls(manager);

      try {
        const state = await manager.resume(resumeId);

        if (state.status !== 'completed') {
          cleanup();
          const action = await waitForResumeOrQuit();
          if (action === 'resume') {
            resumeId = state.transferId;
            continue;
          }
        }
        return;
      } catch (err) {
        console.error('Resume failed:', (err as Error).message);
        fatalExit(1);
      } finally {
        cleanup();
      }
    }
  });

program
  .command('list')
  .description('List all transfers and their status')
  .action(() => {
    const config = loadConfig();
    const manager = new TransferManager(config);
    const transfers = manager.listTransfers();

    if (transfers.length === 0) {
      console.log('No transfers found');
      return;
    }

    console.log(`${'ID'.padEnd(38)} ${'Dest'.padEnd(6)} ${'Status'.padEnd(12)} ${'Progress'.padEnd(10)} ${'FTP Path'.padEnd(30)} Key`);
    console.log('-'.repeat(116));

    for (const t of transfers) {
      const pct = t.totalFileSize > 0
        ? ((t.totalBytesTransferred / t.totalFileSize) * 100).toFixed(1) + '%'
        : 'N/A';
      const dest = (t.destination ?? 's3').toUpperCase().padEnd(6);
      console.log(
        `${t.transferId.padEnd(38)} ${dest}${t.status.padEnd(12)} ${pct.padEnd(10)} ${t.ftpPath.padEnd(30)} ${t.key}`,
      );
    }
  });

program
  .command('abort')
  .description('Abort a transfer and clean up resources')
  .argument('<transferId>', 'Transfer ID to abort')
  .action(async (transferId: string) => {
    const config = loadConfig();
    const manager = new TransferManager(config);

    try {
      await manager.abort(transferId);
    } catch (err) {
      console.error('Abort failed:', (err as Error).message);
      fatalExit(1);
    }
  });

program
  .command('clips')
  .description('List clips on HyperDeck')
  .option('--slot <id>', 'Slot number', '1')
  .action(async (opts: { slot: string }) => {
    const config = loadConfig();

    if (!config.hyperdeckHost) {
      console.error('HDFS_HYPERDECK_HOST is required for clip discovery');
      fatalExit(1);
    }

    const hdClient = new HyperDeckClient(config.hyperdeckHost);

    try {
      await hdClient.connect();
      const clips = await hdClient.getClips(parseInt(opts.slot, 10));
      await hdClient.close();

      if (clips.length === 0) {
        console.log('No clips found');
        return;
      }

      console.log(`${'ID'.padEnd(6)} ${'Name'.padEnd(40)} ${'Codec'.padEnd(12)} ${'Duration'.padEnd(15)} Format`);
      console.log('-'.repeat(90));
      for (const clip of clips) {
        console.log(
          `${String(clip.id).padEnd(6)} ${clip.name.padEnd(40)} ${clip.codec.padEnd(12)} ${clip.duration.padEnd(15)} ${clip.format}`,
        );
      }
    } catch (err) {
      console.error('Failed to list clips:', (err as Error).message);
      fatalExit(1);
    }
  });

program
  .command('info')
  .description('Show HyperDeck device info')
  .action(async () => {
    const config = loadConfig();

    if (!config.hyperdeckHost) {
      console.error('HDFS_HYPERDECK_HOST is required');
      fatalExit(1);
    }

    const hdClient = new HyperDeckClient(config.hyperdeckHost);

    try {
      await hdClient.connect();
      const info = await hdClient.getDeviceInfo();
      await hdClient.close();

      console.log(`Model:            ${info.model}`);
      console.log(`Protocol Version: ${info.protocolVersion}`);
      console.log(`Unique ID:        ${info.uniqueId}`);
      console.log(`Slot Count:       ${info.slotCount}`);
      for (const slot of info.slots) {
        console.log(`\n  Slot ${slot.slotId}:`);
        console.log(`    Status:         ${slot.status}`);
        console.log(`    Volume:         ${slot.volumeName}`);
        console.log(`    Recording Time: ${slot.recordingTime}`);
        console.log(`    Video Format:   ${slot.videoFormat}`);
      }
    } catch (err) {
      console.error('Failed to get device info:', (err as Error).message);
      fatalExit(1);
    }
  });

program
  .command('browse')
  .description('Interactive file browser — discover, select, and queue transfers')
  .action(async () => {
    await runBrowse();
  });

function waitForResumeOrQuit(): Promise<'resume' | 'quit'> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve('quit');
      return;
    }

    console.log('\nPress r to resume, q to quit.');

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === 'r' || key === 'R') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve('resume');
      } else if (key === 'q' || key === 'Q' || key === '\x03') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve('quit');
      }
    };

    process.stdin.on('data', onData);
  });
}

export function setupInteractiveControls(manager: TransferManager, keepStdinAlive = false): () => void {
  let ctrlCPressed = false;
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  const onData = (data: Buffer) => {
    const key = data.toString();

    if (key === '\x03') {
      // Ctrl+C
      if (ctrlCPressed) {
        // Second Ctrl+C within 3s — force quit
        console.log('\nForce quit!');
        process.exit(1);
      }
      ctrlCPressed = true;
      ctrlCTimer = setTimeout(() => { ctrlCPressed = false; }, 3000);
      console.log('\nPausing after current part... (press Ctrl+C again to force quit)');
      manager.requestAbort('pause');
      return;
    }

    if (key === 'q' || key === 'Q') {
      console.log('\nPausing after current part...');
      manager.requestAbort('pause');
      return;
    }

    if (key === 'a' || key === 'A') {
      console.log('\nAborting after current part (will delete uploaded parts)...');
      manager.requestAbort('cancel');
      return;
    }
  };

  // Enter raw mode to capture individual keypresses
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  }

  // Keep SIGTERM as a fallback for non-TTY environments
  const onSigterm = () => {
    console.log('\nSIGTERM received, pausing...');
    manager.requestAbort('pause');
  };
  process.on('SIGTERM', onSigterm);

  // Controls are shown in the progress display

  // Return cleanup function
  return () => {
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    if (process.stdin.isTTY) {
      process.stdin.removeListener('data', onData);
      if (!keepStdinAlive) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }
    process.removeListener('SIGTERM', onSigterm);
  };
}

function printSplash(): void {
  console.log(`
    .--.        .--.
 .-(    ).   .-(    ).
(___.__)__) (___.__)__)
 ' ' ' ' '   ' ' ' ' '
    \u26A1   \u26A1   \u26A1
 ' ' ' ' '   ' ' ' ' '

   P R O C E L L A
       M E D I A

   record2s3 v1.0.0
`);
}

printSplash();
program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logToFile('FATAL', `Command failed: ${msg}`, stack);
  console.error(`[FATAL] ${msg}`);
  if (stack) console.error(stack);
  fatalExit(1);
});
