import { appendFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOG_PATH = resolve(process.cwd(), 'record2s3.log');

// ── Log level filtering ────────────────────────────────────────────
const LOG_LEVEL_PRIORITY: Record<string, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4,
};

const envLevel = (process.env['HDFS_LOG_LEVEL'] ?? 'INFO').toUpperCase();
const minLevel = LOG_LEVEL_PRIORITY[envLevel] ?? LOG_LEVEL_PRIORITY['INFO'];

// ── Log file size management ───────────────────────────────────────
const MAX_LOG_SIZE = (() => {
  const raw = process.env['HDFS_LOG_MAX_SIZE'];
  if (!raw) return 10 * 1024 * 1024; // 10 MB
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? 10 * 1024 * 1024 : n;
})();

function trimLogIfNeeded(): void {
  try {
    const stats = statSync(LOG_PATH);
    if (stats.size <= MAX_LOG_SIZE) return;
    const keepBytes = Math.floor(MAX_LOG_SIZE / 5); // keep last ~20%
    const buf = Buffer.alloc(keepBytes);
    const fd = openSync(LOG_PATH, 'r');
    readSync(fd, buf, 0, keepBytes, stats.size - keepBytes);
    closeSync(fd);
    // Start at next full line
    const newlineIdx = buf.indexOf(10);
    const trimmed = newlineIdx >= 0 ? buf.subarray(newlineIdx + 1) : buf;
    writeFileSync(LOG_PATH, Buffer.concat([
      Buffer.from(`[${new Date().toISOString()}] [INFO] Log truncated (was ${stats.size} bytes)\n`),
      trimmed,
    ]));
  } catch {
    // File may not exist yet — that's fine
  }
}

trimLogIfNeeded();

// ── Public API ─────────────────────────────────────────────────────
export function logToFile(level: string, message: string, stack?: string): void {
  const priority = LOG_LEVEL_PRIORITY[level.toUpperCase()] ?? LOG_LEVEL_PRIORITY['INFO'];
  if (priority < minLevel) return;

  try {
    const ts = new Date().toISOString();
    let line = `[${ts}] [${level}] ${message}\n`;
    if (stack) line += stack + '\n';
    appendFileSync(LOG_PATH, line);
  } catch {
    // Cannot write log — ignore to avoid recursive failures
  }
}

export function log(message: string): void {
  logToFile('INFO', message);
}
