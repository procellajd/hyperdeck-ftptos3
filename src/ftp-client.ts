import { Client } from 'basic-ftp';
import { PassThrough } from 'node:stream';
import type { FtpConfig } from './types.js';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

export class FtpClient {
  private client: Client;
  private readonly config: FtpConfig;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: FtpConfig) {
    this.config = config;
    this.client = new Client(config.timeout);
  }

  async connect(): Promise<void> {
    await this.client.access({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      secure: false,
    });
    this.startKeepalive();
  }

  /**
   * Attempt to reconnect with exponential backoff.
   */
  async reconnect(): Promise<void> {
    this.stopKeepalive();
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        this.client.close();
        this.client = new Client(this.config.timeout);
        await this.connect();
        return;
      } catch (err) {
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt);
        console.error(`FTP reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} failed, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
    throw new Error(`Failed to reconnect to FTP after ${MAX_RECONNECT_ATTEMPTS} attempts`);
  }

  /**
   * Get file size via FTP SIZE command.
   */
  async getFileSize(remotePath: string): Promise<number> {
    return await this.client.size(remotePath);
  }

  /**
   * List files in a remote directory.
   */
  async list(remotePath: string = '/'): Promise<{ name: string; size: number; type: number }[]> {
    const items = await this.client.list(remotePath);
    return items.map(item => ({
      name: item.name,
      size: item.size,
      type: item.type,
    }));
  }

  /**
   * Download a file to a PassThrough stream, optionally starting from a byte offset (for resume).
   * Returns the PassThrough stream that data is piped into.
   */
  async downloadToStream(
    remotePath: string,
    startOffset: number = 0,
    highWaterMark: number = 1024 * 1024,
  ): Promise<PassThrough> {
    // Stop keepalive during active transfer — basic-ftp doesn't allow
    // concurrent commands on the same connection
    this.stopKeepalive();

    const passThrough = new PassThrough({ highWaterMark });

    // basic-ftp downloadTo returns a promise that resolves when transfer completes
    // We don't await it here — we return the stream and let the caller consume it
    const downloadPromise = this.client.downloadTo(passThrough, remotePath, startOffset);

    // Chain .then/.catch on a single promise to avoid unhandled rejections
    downloadPromise.then(
      () => {
        if (!passThrough.destroyed) {
          passThrough.end();
        }
      },
      (err) => {
        if (!passThrough.destroyed) {
          passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      },
    ).finally(() => {
      this.startKeepalive();
    });

    return passThrough;
  }

  /**
   * Check if the FTP connection is alive.
   */
  get closed(): boolean {
    return this.client.closed;
  }

  /**
   * Send NOOP to keep connection alive.
   */
  async sendNoop(): Promise<void> {
    try {
      await this.client.send('NOOP');
    } catch {
      // NOOP failure is not critical
    }
  }

  close(): void {
    this.stopKeepalive();
    this.client.close();
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    if (this.config.keepalive > 0) {
      this.keepaliveTimer = setInterval(() => {
        this.sendNoop();
      }, this.config.keepalive);
      this.keepaliveTimer.unref();
    }
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
