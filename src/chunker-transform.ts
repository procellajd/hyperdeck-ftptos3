import { Transform, type TransformCallback } from 'node:stream';

/**
 * Transform stream that accumulates incoming data into exactly `partSize`-byte
 * Buffer chunks. The final chunk may be smaller than `partSize`.
 *
 * This ensures each emitted buffer corresponds to one S3 multipart upload part.
 */
export class ChunkerTransform extends Transform {
  private buffer: Buffer;
  private offset: number;
  private readonly partSize: number;

  constructor(partSize: number) {
    super();
    if (partSize < 5 * 1024 * 1024) {
      throw new Error('Part size must be at least 5MB');
    }
    this.partSize = partSize;
    this.buffer = Buffer.allocUnsafe(partSize);
    this.offset = 0;
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    let sourceOffset = 0;

    while (sourceOffset < chunk.length) {
      const spaceInBuffer = this.partSize - this.offset;
      const bytesToCopy = Math.min(spaceInBuffer, chunk.length - sourceOffset);

      chunk.copy(this.buffer, this.offset, sourceOffset, sourceOffset + bytesToCopy);
      this.offset += bytesToCopy;
      sourceOffset += bytesToCopy;

      if (this.offset === this.partSize) {
        // Emit a full part-sized buffer and allocate a fresh one
        this.push(this.buffer);
        this.buffer = Buffer.allocUnsafe(this.partSize);
        this.offset = 0;
      }
    }

    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.offset > 0) {
      // Emit the remaining data as the final (smaller) chunk
      this.push(this.buffer.subarray(0, this.offset));
    }
    callback();
  }
}
