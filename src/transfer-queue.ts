import { TransferManager } from './transfer-manager.js';
import { setupInteractiveControls } from './cli.js';
import { log } from './logger.js';
import type { BrowseEntry } from './file-browser.js';
import type { AppConfig } from './types.js';

export interface QueueResult {
  completed: string[];
  failed: { file: string; error: string }[];
  skipped: string[];
  paused: boolean;
}

export async function executeTransferQueue(
  files: BrowseEntry[],
  config: AppConfig,
): Promise<QueueResult> {
  const result: QueueResult = {
    completed: [],
    failed: [],
    skipped: [],
    paused: false,
  };

  let paused = false;

  for (let i = 0; i < files.length; i++) {
    if (paused) {
      result.skipped.push(files[i].name);
      continue;
    }

    const file = files[i];
    console.log(`\n[${i + 1}/${files.length}] Transferring: ${file.name} (${formatBytes(file.size)})`);
    log(`Queue [${i + 1}/${files.length}]: starting ${file.name} (${file.size} bytes) ftpPath=${file.ftpPath}`);

    // Fresh TransferManager per file to avoid stale aborted flag
    const manager = new TransferManager(config);
    const cleanup = setupInteractiveControls(manager);

    try {
      const state = await manager.transfer(file.ftpPath);
      log(`Queue [${i + 1}/${files.length}]: transfer returned status=${state.status}`);
      if (state.status === 'completed') {
        result.completed.push(file.name);
      } else if (state.status === 'in_progress') {
        // Paused by user — stop queue, return to caller
        paused = true;
        result.paused = true;
      } else {
        // Aborted (cancelled) — stop queue, return to caller
        paused = true;
        result.paused = true;
      }
    } catch (err) {
      const message = (err as Error).message;
      log(`Queue [${i + 1}/${files.length}]: transfer threw: ${message}`);
      console.error(`Failed: ${message}`);
      result.failed.push({ file: file.name, error: message });
    } finally {
      cleanup();
    }
  }

  // Print summary
  console.log('\n' + '─'.repeat(50));
  console.log('Transfer queue summary:');
  if (result.completed.length > 0) {
    console.log(`  \x1b[32m\u2713 ${result.completed.length} completed\x1b[0m`);
  }
  if (result.failed.length > 0) {
    console.log(`  \x1b[31m\u2717 ${result.failed.length} failed\x1b[0m`);
  }
  if (result.skipped.length > 0) {
    console.log(`  \x1b[33m\u2013 ${result.skipped.length} skipped\x1b[0m`);
  }

  return result;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
