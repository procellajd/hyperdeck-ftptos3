#!/usr/bin/env node
import { Command } from 'commander';
import * as readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { TransferManager } from './transfer-manager.js';
import { HyperDeckClient } from './hyperdeck-client.js';
import { FtpClient } from './ftp-client.js';
import { StateManager } from './state-manager.js';
import { discoverFiles } from './file-browser.js';
import { interactiveSelect } from './interactive-select.js';
import { executeTransferQueue } from './transfer-queue.js';
import type { DestinationType } from './types.js';

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
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
  const answer = await askQuestion(prompt);
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

async function runBrowse(ftpHost?: string): Promise<void> {
  console.log('--- Connection Setup ---\n');

  // HyperDeck IP
  if (ftpHost) {
    process.env['HDFS_FTP_HOST'] = ftpHost;
  } else {
    const host = await promptWithDefault('HyperDeck IP address', 'HDFS_FTP_HOST');
    if (!host) {
      console.error('No IP address provided');
      process.exit(1);
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
      process.exit(1);
    }
    await promptWithDefault('S3/R2 Endpoint', 'HDFS_S3_ENDPOINT');
    await promptWithDefault('S3/R2 Access Key ID', 'HDFS_S3_ACCESS_KEY_ID');
    await promptWithDefault('S3/R2 Secret Access Key', 'HDFS_S3_SECRET_ACCESS_KEY', true);
  } else {
    // Local/UNC settings
    const outputDir = await promptWithDefault('Output directory', 'HDFS_FS_OUTPUT_DIR');
    if (!outputDir) {
      console.error('No output directory provided');
      process.exit(1);
    }
  }

  saveEnvChanges();
  console.log('');

  const config = loadConfig();

  let entries;
  while (true) {
    const ftpClient = new FtpClient(config.ftp);
    const stateManager = new StateManager(config.stateDir);

    try {
      console.log(`Connecting to FTP ${config.ftp.host}...`);
      await ftpClient.connect();
      entries = await discoverFiles(ftpClient, stateManager, config.s3, config.fs, config.destination);
      ftpClient.close();
    } catch (err) {
      console.error('Failed to list files:', (err as Error).message);
      process.exit(1);
    }

    if (entries.length === 0) {
      console.log('No files found on HyperDeck');
      return;
    }

    const result = await interactiveSelect(entries);

    if (result.action === 'quit') {
      return;
    }

    if (result.action === 'refresh') {
      continue;
    }

    // action === 'confirm'
    if (result.selected.length === 0) {
      console.log('No files selected');
      return;
    }

    console.log(`\nQueuing ${result.selected.length} file(s) for transfer...`);
    await executeTransferQueue(result.selected, config);
    return;
  }
}

const program = new Command();

program
  .name('hdfs')
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
    const manager = new TransferManager(config);
    const cleanup = setupInteractiveControls(manager);

    try {
      await manager.transfer(ftpPath, outputKey);
    } catch (err) {
      console.error('Transfer failed:', (err as Error).message);
      process.exit(1);
    } finally {
      cleanup();
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
      process.exit(1);
    }

    const hdClient = new HyperDeckClient(config.hyperdeckHost);
    const manager = new TransferManager(config);
    const cleanup = setupInteractiveControls(manager);

    try {
      await hdClient.connect();
      const clips = await hdClient.getClips(parseInt(opts.slot, 10));
      await hdClient.close();

      if (clips.length === 0) {
        console.log('No clips found');
        return;
      }

      console.log(`Found ${clips.length} clips to transfer`);

      for (const clip of clips) {
        const ftpPath = `/${clip.name}`;
        console.log(`\nTransferring: ${clip.name}`);
        try {
          await manager.transfer(ftpPath);
        } catch (err) {
          console.error(`Failed to transfer ${clip.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error('Transfer-all failed:', (err as Error).message);
      process.exit(1);
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
    const manager = new TransferManager(config);
    const cleanup = setupInteractiveControls(manager);

    try {
      await manager.resume(transferId);
    } catch (err) {
      console.error('Resume failed:', (err as Error).message);
      process.exit(1);
    } finally {
      cleanup();
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
      process.exit(1);
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
      process.exit(1);
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
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Show HyperDeck device info')
  .action(async () => {
    const config = loadConfig();

    if (!config.hyperdeckHost) {
      console.error('HDFS_HYPERDECK_HOST is required');
      process.exit(1);
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
      process.exit(1);
    }
  });

program
  .command('browse')
  .description('Interactive file browser — discover, select, and queue transfers')
  .action(async () => {
    await runBrowse();
  });

export function setupInteractiveControls(manager: TransferManager): () => void {
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
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.removeListener('SIGTERM', onSigterm);
  };
}

program.parseAsync();
