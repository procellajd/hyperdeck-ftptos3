import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { crc32 } from 'node:zlib';
import { FtpClient } from './ftp-client.js';
import { S3MultipartUploader } from './s3-multipart-uploader.js';
import { FileSystemUploader } from './fs-uploader.js';
import { ChunkerTransform } from './chunker-transform.js';
import { StateManager } from './state-manager.js';
import { ProgressReporter } from './progress-reporter.js';
import { log } from './logger.js';
import type { Uploader } from './uploader.js';
import type { AppConfig, TransferState } from './types.js';

const MAX_S3_PARTS = 10_000;

export type UploaderFactory = () => Uploader;

export class TransferManager {
  private readonly config: AppConfig;
  private readonly stateManager: StateManager;
  private readonly progress: ProgressReporter;
  private readonly createUploader: UploaderFactory;
  private aborted = false;
  private abortMode: 'pause' | 'cancel' = 'pause';

  constructor(config: AppConfig, createUploader?: UploaderFactory) {
    this.config = config;
    this.stateManager = new StateManager(config.stateDir);
    this.progress = new ProgressReporter(config.progressInterval);
    this.createUploader = createUploader ?? (() => this.defaultUploader());
  }

  /**
   * Transfer a file from FTP to the configured destination.
   */
  async transfer(ftpPath: string, outputKey?: string): Promise<TransferState> {
    log(`transfer() called: ftpPath=${ftpPath}, outputKey=${outputKey}`);
    const key = this.resolveOutputKey(ftpPath, outputKey);
    const ftpClient = new FtpClient(this.config.ftp);
    const uploader = this.createUploader();

    try {
      console.log(`Connecting to FTP ${this.config.ftp.host}...`);
      log(`Connecting to FTP ${this.config.ftp.host}:${this.config.ftp.port}`);
      await ftpClient.connect();
      log('FTP connected');

      console.log(`Getting file size for ${ftpPath}...`);
      const totalFileSize = await ftpClient.getFileSize(ftpPath);
      console.log(`File size: ${formatBytes(totalFileSize)}`);
      log(`File size: ${totalFileSize} bytes`);

      const basePartSize = this.getPartSize();
      const partSize = autoScalePartSize(basePartSize, totalFileSize);
      if (partSize !== basePartSize) {
        console.log(`Auto-scaled part size: ${formatBytes(basePartSize)} → ${formatBytes(partSize)} (file needs ${Math.ceil(totalFileSize / basePartSize)} parts at default, max ${MAX_S3_PARTS})`);
        log(`Auto-scaled part size from ${basePartSize} to ${partSize}`);
      }
      const totalParts = Math.ceil(totalFileSize / partSize);
      const bucket = this.getBucket();

      const useChecksum = this.config.destination === 's3' && this.config.s3.checksumAlgorithm === 'CRC32';
      const checksumSuffix = useChecksum ? ' (CRC32 integrity check enabled)' : '';
      console.log(`Initiating multipart upload to ${this.destinationLabel(key)}...${checksumSuffix}`);
      log(`Creating multipart upload: bucket=${bucket}, key=${key}`);
      const uploadId = await uploader.createMultipartUpload(bucket, key);
      log(`Multipart upload created: uploadId=${uploadId}`);

      const state = this.stateManager.createState({
        uploadId,
        bucket,
        key,
        ftpPath,
        totalFileSize,
        partSize,
        destination: this.config.destination,
      });

      console.log(`Transfer ${state.transferId} started (${totalParts} parts)`);
      log(`Transfer ${state.transferId} started (${totalParts} parts, partSize=${partSize})`);

      this.progress.checksumEnabled = useChecksum;
      this.progress.start({
        transferId: state.transferId,
        totalBytes: totalFileSize,
        totalParts,
      });

      await this.executeWithRetry(ftpClient, uploader, state, 0);

      this.progress.report();
      this.progress.stop();

      if (this.aborted) {
        if (this.abortMode === 'cancel') {
          console.log(`\nAborting upload and cleaning up parts...`);
          log(`Transfer ${state.transferId} cancelled, cleaning up`);
          await uploader.abortMultipartUpload(state.bucket, state.key, state.uploadId);
          this.stateManager.markAborted(state);
          console.log(`Transfer ${state.transferId} aborted. Uploaded parts deleted.`);
        } else {
          log(`Transfer ${state.transferId} paused at ${state.totalBytesTransferred} bytes`);
          console.log(`\nTransfer ${state.transferId} paused. Resume with: hdfs resume ${state.transferId}`);
        }
        return state;
      }

      console.log(`Completing upload...`);
      log(`Completing multipart upload ${state.transferId}`);
      const location = await uploader.completeMultipartUpload(
        state.bucket,
        state.key,
        state.uploadId,
        state.completedParts,
      );
      this.stateManager.markCompleted(state);
      console.log(`Transfer complete: ${location}`);
      log(`Transfer ${state.transferId} complete: ${location}`);

      return state;
    } catch (err) {
      log(`transfer() error: ${(err as Error).message}\n${(err as Error).stack}`);
      throw err;
    } finally {
      log('transfer() finally: cleaning up');
      this.progress.stop();
      ftpClient.close();
      uploader.destroy();
    }
  }

  /**
   * Resume an interrupted transfer.
   */
  async resume(transferId?: string): Promise<TransferState> {
    let state: TransferState | null = null;

    if (transferId) {
      state = this.stateManager.loadState(transferId);
      if (!state) throw new Error(`Transfer state not found: ${transferId}`);
    } else {
      const resumable = this.stateManager.listResumable();
      if (resumable.length === 0) throw new Error('No resumable transfers found');
      if (resumable.length > 1) {
        console.log('Multiple resumable transfers found:');
        for (const s of resumable) {
          const pct = s.totalFileSize > 0
            ? ((s.totalBytesTransferred / s.totalFileSize) * 100).toFixed(1)
            : '0.0';
          console.log(`  ${s.transferId}  ${s.ftpPath} -> ${s.key}  ${pct}%`);
        }
        throw new Error('Specify a transfer ID to resume');
      }
      state = resumable[0];
    }

    if (state.status !== 'in_progress') {
      throw new Error(`Transfer ${state.transferId} is ${state.status}, cannot resume`);
    }

    const ftpClient = new FtpClient(this.config.ftp);
    const uploader = this.uploaderForDestination(state.destination ?? 's3');

    try {
      console.log(`Verifying destination state for upload ${state.uploadId}...`);
      const existingParts = await uploader.listParts(state.bucket, state.key, state.uploadId);

      // Reconcile: use destination as the source of truth
      state.completedParts = existingParts;
      state.totalBytesTransferred = existingParts.reduce((sum, p) => sum + p.size, 0);
      this.stateManager.saveState(state);

      const startOffset = state.totalBytesTransferred;
      // Auto-scale part size for resumed transfers (applies to remaining parts)
      const scaledPartSize = autoScalePartSize(state.partSize, state.totalFileSize);
      if (scaledPartSize !== state.partSize) {
        console.log(`Auto-scaled part size: ${formatBytes(state.partSize)} → ${formatBytes(scaledPartSize)}`);
        log(`Auto-scaled part size from ${state.partSize} to ${scaledPartSize}`);
        state.partSize = scaledPartSize;
        this.stateManager.saveState(state);
      }
      const totalParts = Math.ceil(state.totalFileSize / state.partSize);
      const completedParts = state.completedParts.length;

      console.log(
        `Resuming transfer ${state.transferId}: ${completedParts}/${totalParts} parts complete, offset ${formatBytes(startOffset)}`,
      );

      console.log(`Connecting to FTP ${this.config.ftp.host}...`);
      await ftpClient.connect();

      this.progress.checksumEnabled = this.config.destination === 's3' && this.config.s3.checksumAlgorithm === 'CRC32';
      this.progress.start({
        transferId: state.transferId,
        totalBytes: state.totalFileSize,
        totalParts,
        bytesAlreadyTransferred: state.totalBytesTransferred,
        partsAlreadyCompleted: completedParts,
      });

      await this.executeWithRetry(ftpClient, uploader, state, startOffset);

      this.progress.report();
      this.progress.stop();

      if (this.aborted) {
        if (this.abortMode === 'cancel') {
          console.log(`\nAborting upload and cleaning up parts...`);
          await uploader.abortMultipartUpload(state.bucket, state.key, state.uploadId);
          this.stateManager.markAborted(state);
          console.log(`Transfer ${state.transferId} aborted. Uploaded parts deleted.`);
        } else {
          console.log(`\nTransfer ${state.transferId} paused. Resume with: hdfs resume ${state.transferId}`);
        }
        return state;
      }

      console.log(`Completing upload...`);
      const location = await uploader.completeMultipartUpload(
        state.bucket,
        state.key,
        state.uploadId,
        state.completedParts,
      );
      this.stateManager.markCompleted(state);
      console.log(`Transfer complete: ${location}`);

      return state;
    } finally {
      this.progress.stop();
      ftpClient.close();
      uploader.destroy();
    }
  }

  /**
   * Abort a transfer: clean up uploaded parts and mark state.
   */
  async abort(transferId: string): Promise<void> {
    const state = this.stateManager.loadState(transferId);
    if (!state) throw new Error(`Transfer state not found: ${transferId}`);

    const uploader = this.uploaderForDestination(state.destination ?? 's3');
    try {
      console.log(`Aborting upload ${state.uploadId}...`);
      await uploader.abortMultipartUpload(state.bucket, state.key, state.uploadId);
      this.stateManager.markAborted(state);
      console.log(`Transfer ${transferId} aborted and cleaned up`);
    } finally {
      uploader.destroy();
    }
  }

  /**
   * List all transfer states.
   */
  listTransfers(): TransferState[] {
    return this.stateManager.listAll();
  }

  /**
   * Graceful shutdown: stop current transfer, save state, allow resume.
   */
  requestAbort(mode: 'pause' | 'cancel' = 'pause'): void {
    this.aborted = true;
    this.abortMode = mode;
  }

  /**
   * Retry wrapper around executePipeline. On transient FTP errors, reconnects
   * and restarts the pipeline from the last saved offset.
   */
  private async executeWithRetry(
    ftpClient: FtpClient,
    uploader: Uploader,
    state: TransferState,
    startOffset: number,
  ): Promise<void> {
    const maxRetries = this.config.ftp.maxRetries;
    log(`executeWithRetry: startOffset=${startOffset}, maxRetries=${maxRetries}`);

    for (let attempt = 0; ; attempt++) {
      try {
        const offset = attempt === 0 ? startOffset : state.totalBytesTransferred;
        log(`executeWithRetry: attempt ${attempt}, offset=${offset}`);
        await this.executePipeline(ftpClient, uploader, state, offset);
        log('executeWithRetry: pipeline completed successfully');
        return;
      } catch (err) {
        const isTransient = isFtpTransientError(err);
        log(`executeWithRetry: pipeline threw: ${(err as Error).message} (transient=${isTransient}, aborted=${this.aborted}, attempt=${attempt}/${maxRetries})`);
        if (this.aborted) throw err;
        if (attempt >= maxRetries || !isTransient) throw err;

        console.log(
          `\nFTP stream error (attempt ${attempt + 1}/${maxRetries}): ${(err as Error).message}`,
        );
        console.log(`Reconnecting and resuming from ${formatBytes(state.totalBytesTransferred)}...`);
        log('executeWithRetry: calling ftpClient.reconnect()');
        await ftpClient.reconnect();
        log('executeWithRetry: reconnected successfully');
      }
    }
  }

  /**
   * Execute the streaming pipeline: FTP -> ChunkerTransform -> uploader.
   */
  private async executePipeline(
    ftpClient: FtpClient,
    uploader: Uploader,
    state: TransferState,
    startOffset: number,
  ): Promise<void> {
    log(`executePipeline: starting download from offset ${startOffset}`);
    const ftpStream = await ftpClient.downloadToStream(
      state.ftpPath,
      startOffset,
      this.config.highWaterMark,
    );
    log('executePipeline: FTP stream created');

    // Count bytes as they arrive from FTP for download speed reporting
    let downloadedBytes = startOffset;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
        downloadedBytes += chunk.length;
        callback(null, chunk);
      },
    });
    this.progress.setDownloadCounter(() => downloadedBytes);

    const chunker = new ChunkerTransform(state.partSize);

    let nextPartNumber = state.completedParts.length + 1;
    const useChecksum = this.config.destination === 's3' && this.config.s3.checksumAlgorithm === 'CRC32';

    const concurrency = this.getConcurrency();
    const inFlight = new Set<Promise<void>>();
    let pipelineError: Error | null = null;

    // Attach error listeners BEFORE piping so errors are captured
    // instead of becoming uncaught exceptions that silently kill the process.
    const captureError = (err: Error) => {
      if (!pipelineError) {
        log(`executePipeline: stream error captured: ${err.message}`);
        pipelineError = err;
        // Destroy the chunker to unblock the for-await consumer
        if (!chunker.destroyed) chunker.destroy();
      }
    };
    ftpStream.on('error', captureError);
    counter.on('error', captureError);
    chunker.on('error', captureError);

    ftpStream.pipe(counter).pipe(chunker);

    // Use for-await-of for backpressure: reads chunks as slots open up.
    // Iterate chunker directly (Transform streams are AsyncIterable in Node.js 16+).
    try {
      for await (const chunk of chunker) {
        if (this.aborted || pipelineError) break;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const partNumber = nextPartNumber++;
        let checksum: string | undefined;
        if (useChecksum) {
          const crcBuf = Buffer.alloc(4);
          crcBuf.writeUInt32BE(crc32(buffer), 0);
          checksum = crcBuf.toString('base64');
        }

        const task = (async () => {
          const completedPart = await uploader.uploadPart(
            state.bucket,
            state.key,
            state.uploadId,
            partNumber,
            buffer,
            checksum,
          );

          this.stateManager.recordPart(state, completedPart);
          this.progress.update(state.totalBytesTransferred, state.completedParts.length);
        })();

        const tracked = task
          .catch((err) => { pipelineError = err as Error; })
          .finally(() => { inFlight.delete(tracked); });
        inFlight.add(tracked);

        // When at capacity, wait for any one upload to finish before reading the next chunk
        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
      }
    } catch (err) {
      // FTP stream error (e.g. data socket timeout) — capture it but
      // still drain in-flight uploads so completed parts are saved.
      log(`executePipeline: for-await threw: ${(err as Error).message}`);
      pipelineError = pipelineError ?? (err as Error);
    }

    log(`executePipeline: draining ${inFlight.size} in-flight uploads`);
    // Drain remaining in-flight uploads
    await Promise.all(inFlight);

    // Always flush state after drain — ensures the final batch of parts is persisted
    // regardless of how the pipeline exits (success, error, abort, pause).
    this.stateManager.flush(state);

    if (pipelineError) {
      log(`executePipeline: throwing after flush: ${pipelineError.message}`);
      throw pipelineError;
    }
    log(`executePipeline: finished, ${state.completedParts.length} parts, ${state.totalBytesTransferred} bytes`);
  }

  private defaultUploader(): Uploader {
    if (this.config.destination === 'local') {
      if (!this.config.fs) throw new Error('FileSystem config required for local destination');
      return new FileSystemUploader(this.config.fs);
    }
    return new S3MultipartUploader(this.config.s3);
  }

  private uploaderForDestination(destination: string): Uploader {
    if (destination === 'local') {
      if (!this.config.fs) throw new Error('FileSystem config required for local destination');
      return new FileSystemUploader(this.config.fs);
    }
    return new S3MultipartUploader(this.config.s3);
  }

  private resolveOutputKey(ftpPath: string, outputKey?: string): string {
    if (outputKey) {
      if (this.config.destination === 's3' && this.config.s3.keyPrefix) {
        return `${this.config.s3.keyPrefix.replace(/\/$/, '')}/${outputKey}`;
      }
      return outputKey;
    }
    // Use the filename from the FTP path
    const filename = ftpPath.split('/').pop() ?? ftpPath;
    if (this.config.destination === 's3' && this.config.s3.keyPrefix) {
      return `${this.config.s3.keyPrefix.replace(/\/$/, '')}/${filename}`;
    }
    return filename;
  }

  private getPartSize(): number {
    if (this.config.destination === 'local' && this.config.fs) {
      return this.config.fs.partSize;
    }
    return this.config.s3.partSize;
  }

  private getBucket(): string {
    if (this.config.destination === 'local') return '';
    return this.config.s3.bucket;
  }

  private getConcurrency(): number {
    if (this.config.destination === 'local' && this.config.fs) {
      return this.config.fs.concurrency;
    }
    return this.config.s3.concurrency;
  }

  private destinationLabel(key: string): string {
    if (this.config.destination === 'local') {
      return this.config.fs ? `${this.config.fs.outputDir}/${key}` : key;
    }
    return `s3://${this.config.s3.bucket}/${key}`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  'timeout',
  'timed out',
  'data socket',
  'connection closed',
];

const MAX_S3_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

function autoScalePartSize(basePartSize: number, totalFileSize: number): number {
  const neededParts = Math.ceil(totalFileSize / basePartSize);
  if (neededParts <= MAX_S3_PARTS) return basePartSize;
  const scaled = Math.ceil(totalFileSize / MAX_S3_PARTS);
  if (scaled > MAX_S3_PART_SIZE) {
    throw new Error(
      `File size ${formatBytes(totalFileSize)} is too large: even at maximum part size (5 GB), ` +
      `it would require ${Math.ceil(totalFileSize / MAX_S3_PART_SIZE)} parts (max ${MAX_S3_PARTS}).`,
    );
  }
  return scaled;
}

function isFtpTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  const msg = err.message.toLowerCase();
  return TRANSIENT_MESSAGE_PATTERNS.some(pattern => msg.includes(pattern));
}
