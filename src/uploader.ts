import type { CompletedPart } from './types.js';

export interface Uploader {
  createMultipartUpload(bucket: string, key: string): Promise<string>;
  uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Buffer, checksum?: string): Promise<CompletedPart>;
  completeMultipartUpload(bucket: string, key: string, uploadId: string, parts: CompletedPart[]): Promise<string>;
  abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void>;
  listParts(bucket: string, key: string, uploadId: string): Promise<CompletedPart[]>;
  headObject(bucket: string, key: string): Promise<number | null>;
  destroy(): void;
}
