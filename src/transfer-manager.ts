import { Readable, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { FtpClient } from './ftp-client.js';
import { S3MultipartUploader } from './s3-multipart-uploader.js';
import { FileSystemUploader } from './fs-uploader.js';
import { ChunkerTransform } from './chunker-transform.js';
import { StateManager } from './state-manager.js';
import { ProgressReporter } from './progress-reporter.js';
import type { Uploader } from './uploader.js';
import type { AppConfig, TransferState } from './types.js';

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
    const key = this.resolveOutputKey(ftpPath, outputKey);
    const ftpClient = new FtpClient(this.config.ftp);
    const uploader = this.createUploader();

    try {
      console.log(`Connecting to FTP ${this.config.ftp.host}...`);
      await ftpClient.connect();

      console.log(`Getting file size for ${ftpPath}...`);
      const totalFileSize = await ftpClient.getFileSize(ftpPath);
      console.log(`File size: ${formatBytes(totalFileSize)}`);

      const partSize = this.getPartSize();
      const totalParts = Math.ceil(totalFileSize / partSize);
      const bucket = this.getBucket();

      console.log(`Initiating multipart upload to ${this.destinationLabel(key)}...`);
      const uploadId = await uploader.createMultipartUpload(bucket, key);

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

      this.progress.start({
        transferId: state.transferId,
        totalBytes: totalFileSize,
        totalParts,
      });

      await this.executePipeline(ftpClient, uploader, state, 0);

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
      const totalParts = Math.ceil(state.totalFileSize / state.partSize);
      const completedParts = state.completedParts.length;

      console.log(
        `Resuming transfer ${state.transferId}: ${completedParts}/${totalParts} parts complete, offset ${formatBytes(startOffset)}`,
      );

      console.log(`Connecting to FTP ${this.config.ftp.host}...`);
      await ftpClient.connect();

      this.progress.start({
        transferId: state.transferId,
        totalBytes: state.totalFileSize,
        totalParts,
        bytesAlreadyTransferred: state.totalBytesTransferred,
        partsAlreadyCompleted: completedParts,
      });

      await this.executePipeline(ftpClient, uploader, state, startOffset);

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
   * Execute the streaming pipeline: FTP -> ChunkerTransform -> uploader.
   */
  private async executePipeline(
    ftpClient: FtpClient,
    uploader: Uploader,
    state: TransferState,
    startOffset: number,
  ): Promise<void> {
    const ftpStream = await ftpClient.downloadToStream(
      state.ftpPath,
      startOffset,
      this.config.highWaterMark,
    );

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
    const pipeline = ftpStream.pipe(counter).pipe(chunker);

    let nextPartNumber = state.completedParts.length + 1;

    const concurrency = this.getConcurrency();
    const inFlight = new Set<Promise<void>>();
    let pipelineError: Error | null = null;

    // Use for-await-of for backpressure: reads chunks as slots open up.
    // Wrap in try/catch so FTP stream errors don't orphan in-flight uploads.
    const readable = Readable.from(pipeline);
    try {
      for await (const chunk of readable) {
        if (this.aborted || pipelineError) break;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const partNumber = nextPartNumber++;

        const task = (async () => {
          const completedPart = await uploader.uploadPart(
            state.bucket,
            state.key,
            state.uploadId,
            partNumber,
            buffer,
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
      pipelineError = pipelineError ?? (err as Error);
    }

    // Drain remaining in-flight uploads
    await Promise.all(inFlight);

    if (pipelineError) {
      this.stateManager.saveState(state);
      throw pipelineError;
    }
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
