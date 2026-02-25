import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Config, CompletedPart } from './types.js';
import type { Uploader } from './uploader.js';

const RETRY_BASE_DELAY_MS = 1000;

export class S3MultipartUploader implements Uploader {
  private readonly client: S3Client;
  private readonly config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  /**
   * Initiate a new multipart upload. Returns the upload ID.
   */
  async createMultipartUpload(bucket: string, key: string): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    if (!response.UploadId) {
      throw new Error('CreateMultipartUpload did not return an UploadId');
    }
    return response.UploadId;
  }

  /**
   * Upload a single part with retry and exponential backoff.
   * Returns the completed part info (partNumber + ETag).
   */
  async uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<CompletedPart> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await this.client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body,
          }),
        );

        if (!response.ETag) {
          throw new Error(`UploadPart ${partNumber} did not return an ETag`);
        }

        return {
          partNumber,
          etag: response.ETag,
          size: body.length,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!isTransientError(err) || attempt === this.config.maxRetries) {
          break;
        }

        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.error(
          `Part ${partNumber} upload failed (attempt ${attempt + 1}/${this.config.maxRetries + 1}), retrying in ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
      }
    }

    throw lastError ?? new Error(`Part ${partNumber} upload failed`);
  }

  /**
   * Complete the multipart upload with all uploaded parts.
   */
  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<string> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    const response = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map(p => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      }),
    );

    return response.Location ?? `s3://${bucket}/${key}`;
  }

  /**
   * Abort a multipart upload, cleaning up any uploaded parts.
   */
  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * List all uploaded parts for a given multipart upload.
   * Used during resume to verify S3-side state.
   */
  async listParts(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<CompletedPart[]> {
    const parts: CompletedPart[] = [];
    let partNumberMarker: string | undefined;

    // Paginate through all parts
    while (true) {
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          ...(partNumberMarker ? { PartNumberMarker: partNumberMarker } : {}),
        }),
      );

      if (response.Parts) {
        for (const part of response.Parts) {
          if (part.PartNumber && part.ETag && part.Size) {
            parts.push({
              partNumber: part.PartNumber,
              etag: part.ETag,
              size: part.Size,
            });
          }
        }
      }

      if (!response.IsTruncated) break;
      partNumberMarker = String(response.NextPartNumberMarker);
    }

    return parts;
  }

  /**
   * Check if an object exists in S3. Returns its size if found, null if not.
   */
  async headObject(bucket: string, key: string): Promise<number | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return response.ContentLength ?? 0;
    } catch (err) {
      const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (statusCode === 404 || (err as { name?: string }).name === 'NotFound') {
        return null;
      }
      throw err;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * Determine if an error is transient and worth retrying.
 * Retries: 5xx server errors, network/timeout errors.
 * Does NOT retry: 4xx client errors (auth, bucket not found, etc.).
 */
function isTransientError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (statusCode !== undefined) {
      return statusCode >= 500;
    }
    const code = (err as { code?: string }).code;
    if (code) {
      return [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EPIPE',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'TimeoutError',
        'NetworkingError',
        'RequestTimeout',
        'ThrottlingException',
        'SlowDown',
      ].includes(code);
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
