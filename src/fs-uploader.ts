import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmSync,
  existsSync,
  createReadStream,
  createWriteStream,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { CompletedPart, FileSystemConfig } from './types.js';
import type { Uploader } from './uploader.js';

export class FileSystemUploader implements Uploader {
  private readonly config: FileSystemConfig;

  constructor(config: FileSystemConfig) {
    this.config = config;
  }

  /**
   * Create a staging directory for parts. Returns a unique upload ID.
   */
  async createMultipartUpload(_bucket: string, key: string): Promise<string> {
    const uploadId = randomUUID();
    const partsDir = this.partsDir(key, uploadId);
    mkdirSync(partsDir, { recursive: true });
    return uploadId;
  }

  /**
   * Write a single part to the staging directory.
   * Uses atomic write (temp file + rename) to prevent partial parts.
   */
  async uploadPart(
    _bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<CompletedPart> {
    const partsDir = this.partsDir(key, uploadId);
    const partFile = join(partsDir, this.partFilename(partNumber));
    const tempFile = partFile + '.tmp.' + Date.now();

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        writeFileSync(tempFile, body);
        renameSync(tempFile, partFile);
        return {
          partNumber,
          etag: `part-${partNumber}`,
          size: body.length,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Clean up temp file on failure
        try { unlinkSync(tempFile); } catch { /* ignore */ }
        if (attempt === this.config.maxRetries) break;
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    throw lastError ?? new Error(`Part ${partNumber} write failed`);
  }

  /**
   * Concatenate all parts into the final output file, then remove the staging directory.
   */
  async completeMultipartUpload(
    _bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<string> {
    const partsDir = this.partsDir(key, uploadId);
    const outputPath = this.outputPath(key);

    mkdirSync(dirname(outputPath), { recursive: true });

    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const tempOutput = outputPath + '.tmp.' + Date.now();
    const writeStream = createWriteStream(tempOutput);

    try {
      for (const part of sorted) {
        const partFile = join(partsDir, this.partFilename(part.partNumber));
        await pipeline(createReadStream(partFile), writeStream, { end: false });
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      renameSync(tempOutput, outputPath);
    } catch (err) {
      try { unlinkSync(tempOutput); } catch { /* ignore */ }
      throw err;
    }

    // Clean up parts directory
    rmSync(partsDir, { recursive: true, force: true });

    return outputPath;
  }

  /**
   * Abort: delete the staging directory and all parts.
   */
  async abortMultipartUpload(
    _bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    const partsDir = this.partsDir(key, uploadId);
    if (existsSync(partsDir)) {
      rmSync(partsDir, { recursive: true, force: true });
    }
  }

  /**
   * List completed parts by reading the staging directory.
   */
  async listParts(
    _bucket: string,
    key: string,
    uploadId: string,
  ): Promise<CompletedPart[]> {
    const partsDir = this.partsDir(key, uploadId);
    if (!existsSync(partsDir)) return [];

    const files = readdirSync(partsDir).filter(f => f.endsWith('.part')).sort();
    const parts: CompletedPart[] = [];
    for (const file of files) {
      const partNumber = parseInt(file.replace('.part', ''), 10);
      const filePath = join(partsDir, file);
      const stat = statSync(filePath);
      parts.push({
        partNumber,
        etag: `part-${partNumber}`,
        size: stat.size,
      });
    }
    return parts;
  }

  /**
   * Check if the final output file exists. Returns its size or null.
   */
  async headObject(_bucket: string, key: string): Promise<number | null> {
    const outputPath = this.outputPath(key);
    try {
      const stat = statSync(outputPath);
      return stat.size;
    } catch {
      return null;
    }
  }

  destroy(): void {
    // No resources to clean up
  }

  private partsDir(key: string, uploadId: string): string {
    return join(this.config.outputDir, '.parts', key, uploadId);
  }

  private outputPath(key: string): string {
    return join(this.config.outputDir, key);
  }

  private partFilename(partNumber: number): string {
    return String(partNumber).padStart(6, '0') + '.part';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
