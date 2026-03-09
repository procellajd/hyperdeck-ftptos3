/**
 * Bounded async queue for decoupling the FTP download (producer) from
 * S3/filesystem uploads (consumer) in the transfer pipeline.
 *
 * Without this, the FTP stream stalls whenever all upload concurrency slots
 * are occupied — bytes stop flowing from the HyperDeck even though the
 * network link has spare capacity.  The queue lets the FTP side pre-fetch
 * `maxSize` chunks ahead so that when an upload slot frees up, the next
 * chunk is already in memory and can be dispatched immediately.
 */

export interface ChunkItem {
  buffer: Buffer;
  partNumber: number;
  checksum?: string;
}

export class AsyncChunkQueue {
  private readonly items: ChunkItem[] = [];
  private readonly maxSize: number;
  private done = false;
  private error: Error | null = null;

  // Resolve functions for blocked waiters
  private consumerWaiter: (() => void) | null = null;
  private producerWaiter: (() => void) | null = null;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Producer: enqueue a chunk.  Awaits if the queue is at capacity,
   * resuming as soon as the consumer pulls an item.
   */
  async push(item: ChunkItem): Promise<void> {
    while (this.items.length >= this.maxSize && !this.done && !this.error) {
      await new Promise<void>(resolve => { this.producerWaiter = resolve; });
    }
    if (this.error) throw this.error;
    if (this.done) return;

    this.items.push(item);
    this.wakeConsumer();
  }

  /**
   * Consumer: dequeue a chunk.  Awaits if the queue is empty, resuming
   * when the producer pushes an item.  Returns `null` when the producer
   * has called `finish()` and the queue is fully drained.
   */
  async pull(): Promise<ChunkItem | null> {
    while (this.items.length === 0 && !this.done && !this.error) {
      await new Promise<void>(resolve => { this.consumerWaiter = resolve; });
    }
    if (this.error) throw this.error;
    if (this.items.length === 0) return null; // done + drained

    const item = this.items.shift()!;
    this.wakeProducer();
    return item;
  }

  /** Signal that no more items will be pushed (normal completion). */
  finish(): void {
    this.done = true;
    this.wakeConsumer();
    this.wakeProducer();
  }

  /** Signal an error — both push() and pull() will throw on next call. */
  abort(err: Error): void {
    if (this.error) return; // first error wins
    this.error = err;
    this.wakeConsumer();
    this.wakeProducer();
  }

  get size(): number {
    return this.items.length;
  }

  private wakeConsumer(): void {
    if (this.consumerWaiter) {
      const resolve = this.consumerWaiter;
      this.consumerWaiter = null;
      resolve();
    }
  }

  private wakeProducer(): void {
    if (this.producerWaiter) {
      const resolve = this.producerWaiter;
      this.producerWaiter = null;
      resolve();
    }
  }
}
