import type { TransferProgress } from './types.js';

export class ProgressReporter {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;
  private bytesUploaded: number = 0;
  private totalBytes: number = 0;
  private partsCompleted: number = 0;
  private totalParts: number = 0;
  private transferId: string = '';
  private lastReportedUploaded: number = 0;
  private lastReportedDownloaded: number = 0;
  private lastReportTime: number = 0;
  private linesWritten: number = 0;
  private downloadCounter: (() => number) | null = null;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  start(params: {
    transferId: string;
    totalBytes: number;
    totalParts: number;
    bytesAlreadyTransferred?: number;
    partsAlreadyCompleted?: number;
  }): void {
    this.transferId = params.transferId;
    this.totalBytes = params.totalBytes;
    this.totalParts = params.totalParts;
    this.bytesUploaded = params.bytesAlreadyTransferred ?? 0;
    this.partsCompleted = params.partsAlreadyCompleted ?? 0;
    this.startTime = Date.now();
    this.lastReportedUploaded = this.bytesUploaded;
    this.lastReportedDownloaded = this.bytesUploaded;
    this.lastReportTime = this.startTime;
    this.linesWritten = 0;

    this.stop();
    this.timer = setInterval(() => this.report(), this.intervalMs);
    this.timer.unref();
  }

  update(bytesUploaded: number, partsCompleted: number): void {
    this.bytesUploaded = bytesUploaded;
    this.partsCompleted = partsCompleted;
  }

  /**
   * Set a getter function that returns current FTP download byte count.
   * Called on every progress tick for live download speed.
   */
  setDownloadCounter(counter: () => number): void {
    this.downloadCounter = counter;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.linesWritten > 0) {
      process.stdout.write('\n');
      this.linesWritten = 0;
    }
    this.downloadCounter = null;
  }

  report(): void {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const intervalElapsed = now - this.lastReportTime;

    // Read live download counter
    const bytesDownloaded = this.downloadCounter ? this.downloadCounter() : this.bytesUploaded;

    // Current speeds (based on recent interval)
    const recentUploaded = this.bytesUploaded - this.lastReportedUploaded;
    const recentDownloaded = bytesDownloaded - this.lastReportedDownloaded;
    const currentUploadSpeed = intervalElapsed > 0 ? (recentUploaded / intervalElapsed) * 1000 : 0;
    const currentDownloadSpeed = intervalElapsed > 0 ? (recentDownloaded / intervalElapsed) * 1000 : 0;

    // Average speed (overall, based on uploaded bytes)
    const avgSpeed = elapsed > 0 ? (this.bytesUploaded / elapsed) * 1000 : 0;

    const remaining = this.totalBytes - this.bytesUploaded;
    const eta = avgSpeed > 0 ? (remaining / avgSpeed) * 1000 : 0;
    const percentage = this.totalBytes > 0
      ? (this.bytesUploaded / this.totalBytes) * 100
      : 0;

    const progress: TransferProgress = {
      transferId: this.transferId,
      bytesTransferred: this.bytesUploaded,
      totalBytes: this.totalBytes,
      percentage,
      speed: currentUploadSpeed,
      elapsed,
      eta,
      partsCompleted: this.partsCompleted,
      totalParts: this.totalParts,
      memoryUsage: process.memoryUsage(),
    };

    this.lastReportedUploaded = this.bytesUploaded;
    this.lastReportedDownloaded = bytesDownloaded;
    this.lastReportTime = now;

    this.logProgress(progress, currentDownloadSpeed, avgSpeed);
  }

  private logProgress(p: TransferProgress, dlSpeed: number, avgSpeed: number): void {
    const pct = p.percentage.toFixed(1);
    const transferred = formatBytes(p.bytesTransferred);
    const total = formatBytes(p.totalBytes);
    const eta = formatDuration(p.eta);
    const elapsed = formatDuration(p.elapsed);

    // Progress bar
    const barWidth = 20;
    const filled = Math.round((p.percentage / 100) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);

    // Speeds in Mbps (megabits per second)
    const dlStr = padLeft(formatMbps(dlSpeed), 10);
    const ulStr = padLeft(formatMbps(p.speed), 10);
    const avgStr = padLeft(formatMbps(avgSpeed), 10);

    const stats = `  ${bar} ${pct.padStart(5)}%  ${transferred}/${total}  DL:${dlStr}  UL:${ulStr}  Avg:${avgStr}  ETA: ${eta}  [${elapsed}]  Parts: ${p.partsCompleted}/${p.totalParts}`;
    const controls = `  Ctrl+C/q: pause | a: abort | Ctrl+C x2: force quit`;

    // Calculate how many visual lines each string occupies when wrapped
    const cols = process.stdout.columns || 80;
    const visualLines = (text: string) => Math.max(1, Math.ceil(text.length / cols));

    // Move cursor up to overwrite previous output
    if (this.linesWritten > 0) {
      process.stdout.write(`\x1b[${this.linesWritten}A`);
    }

    // Write stats + controls, clearing each line.
    // Since there is no trailing \n, the cursor sits on the last visual line,
    // so we only need to move up (totalLines - 1) to reach the first line.
    const totalLines = visualLines(stats) + visualLines(controls);
    process.stdout.write(`\r\x1b[J${stats}\n\x1b[2m${controls}\x1b[0m`);
    this.linesWritten = totalLines - 1;
  }
}

function formatMbps(bytesPerSecond: number): string {
  const mbps = (bytesPerSecond * 8) / (1000 * 1000);
  if (mbps < 1) return mbps.toFixed(1) + ' Mbps';
  return mbps.toFixed(1) + ' Mbps';
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? ' ' + str : ' '.repeat(width - str.length) + str;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0 || !isFinite(ms)) return '--:--';
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
