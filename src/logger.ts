import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOG_PATH = resolve(process.cwd(), 'record2s3.log');

export function logToFile(level: string, message: string, stack?: string): void {
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
