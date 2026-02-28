import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TransferState, CompletedPart, DestinationType } from './types.js';

export class StateManager {
  private readonly stateDir: string;
  private saveCounter = 0;
  private static readonly SAVE_EVERY = 10;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(this.stateDir, { recursive: true });
  }

  /**
   * Create initial transfer state and persist it.
   */
  createState(params: {
    uploadId: string;
    bucket: string;
    key: string;
    ftpPath: string;
    totalFileSize: number;
    partSize: number;
    destination?: DestinationType;
  }): TransferState {
    const now = new Date().toISOString();
    const state: TransferState = {
      transferId: randomUUID(),
      uploadId: params.uploadId,
      bucket: params.bucket,
      key: params.key,
      ftpPath: params.ftpPath,
      totalFileSize: params.totalFileSize,
      partSize: params.partSize,
      completedParts: [],
      totalBytesTransferred: 0,
      status: 'in_progress',
      destination: params.destination,
      createdAt: now,
      updatedAt: now,
    };
    this.saveState(state);
    return state;
  }

  /**
   * Record a completed part and persist state atomically.
   */
  recordPart(state: TransferState, part: CompletedPart): void {
    state.completedParts.push(part);
    state.totalBytesTransferred += part.size;
    state.updatedAt = new Date().toISOString();
    if (++this.saveCounter >= StateManager.SAVE_EVERY) {
      this.saveState(state);
      this.saveCounter = 0;
    }
  }

  /**
   * Unconditionally save state to disk. Call at end-of-transfer, on error, and on pause.
   */
  flush(state: TransferState): void {
    this.saveState(state);
    this.saveCounter = 0;
  }

  /**
   * Mark transfer as completed.
   */
  markCompleted(state: TransferState): void {
    state.status = 'completed';
    state.updatedAt = new Date().toISOString();
    this.saveState(state);
  }

  /**
   * Mark transfer as aborted.
   */
  markAborted(state: TransferState): void {
    state.status = 'aborted';
    state.updatedAt = new Date().toISOString();
    this.saveState(state);
  }

  /**
   * Atomically persist state via write-to-temp-then-rename.
   */
  saveState(state: TransferState): void {
    const filePath = this.statePath(state.transferId);
    const tempPath = filePath + '.tmp.' + Date.now();
    writeFileSync(tempPath, JSON.stringify(state), 'utf-8');
    renameSync(tempPath, filePath);
  }

  /**
   * Load a transfer state by ID.
   */
  loadState(transferId: string): TransferState | null {
    const filePath = this.statePath(transferId);
    if (!existsSync(filePath)) return null;
    const data = readFileSync(filePath, 'utf-8');
    const state = JSON.parse(data) as TransferState;
    if (!state.destination) state.destination = 's3';
    return state;
  }

  /**
   * List all transfer states that are resumable (in_progress).
   */
  listResumable(): TransferState[] {
    return this.listAll().filter(s => s.status === 'in_progress');
  }

  /**
   * List all transfer states.
   */
  listAll(): TransferState[] {
    if (!existsSync(this.stateDir)) return [];
    const files = readdirSync(this.stateDir).filter(f => f.endsWith('.json'));
    const states: TransferState[] = [];
    for (const file of files) {
      try {
        const data = readFileSync(join(this.stateDir, file), 'utf-8');
        const state = JSON.parse(data) as TransferState;
        if (!state.destination) state.destination = 's3';
        states.push(state);
      } catch {
        // Skip corrupt state files
      }
    }
    return states;
  }

  /**
   * Delete a transfer state file.
   */
  deleteState(transferId: string): void {
    const filePath = this.statePath(transferId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  private statePath(transferId: string): string {
    return join(this.stateDir, `${transferId}.json`);
  }
}
