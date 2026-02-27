import type { FtpClient } from './ftp-client.js';
import type { StateManager } from './state-manager.js';
import { S3MultipartUploader } from './s3-multipart-uploader.js';
import { FileSystemUploader } from './fs-uploader.js';
import type { TransferState, S3Config, FileSystemConfig, DestinationType } from './types.js';

export interface BrowseEntry {
  ftpPath: string;          // "/ssd1/file.mxf"
  name: string;             // "file.mxf"
  slot: string;             // "ssd1"
  size: number;             // bytes
  uploadStatus: 'completed' | 'in_progress' | 'not_uploaded';
  transferId?: string;
  transferPercent?: number;
  codec?: string;           // "ProRes:HQ"
  videoFormat?: string;     // "1080p25"
  startTimecode?: string;   // "01:00:00:00"
  duration?: string;        // "00:05:03:22"
}

export async function discoverFiles(
  ftpClient: FtpClient,
  stateManager: StateManager,
  s3Config?: S3Config,
  fsConfig?: FileSystemConfig,
  destination?: DestinationType,
): Promise<BrowseEntry[]> {
  // 1. List root to find slot directories
  const rootItems = await ftpClient.list('/');
  const slots = rootItems.filter(item => item.type === 2);

  // 2. List files in each slot
  const entries: BrowseEntry[] = [];
  for (const slot of slots) {
    const files = await ftpClient.list('/' + slot.name);
    for (const file of files) {
      if (file.type !== 1) continue;
      entries.push({
        ftpPath: `/${slot.name}/${file.name}`,
        name: file.name,
        slot: slot.name,
        size: file.size,
        uploadStatus: 'not_uploaded',
      });
    }
  }

  // 3. Cross-reference with transfer state
  const allStates = stateManager.listAll();
  const stateByFtpPath = new Map<string, TransferState>();
  const stateByFilename = new Map<string, TransferState>();

  for (const state of allStates) {
    stateByFtpPath.set(state.ftpPath, state);
    // Also index by filename extracted from ftpPath for transfer-all matches
    const filename = state.ftpPath.split('/').pop();
    if (filename) {
      // Keep the most recent state per filename (by updatedAt)
      const existing = stateByFilename.get(filename);
      if (!existing || state.updatedAt > existing.updatedAt) {
        stateByFilename.set(filename, state);
      }
    }
  }

  for (const entry of entries) {
    // Try exact ftpPath match first, then fallback to filename match
    const state = stateByFtpPath.get(entry.ftpPath) ?? stateByFilename.get(entry.name);
    if (!state) continue;

    entry.transferId = state.transferId;
    if (state.status === 'completed') {
      entry.uploadStatus = 'completed';
    } else if (state.status === 'in_progress') {
      entry.uploadStatus = 'in_progress';
      entry.transferPercent = state.totalFileSize > 0
        ? Math.round((state.totalBytesTransferred / state.totalFileSize) * 100)
        : 0;
    }
    // 'aborted' states are treated as not_uploaded
  }

  // 4. Destination fallback — check unmatched files against destination
  const unchecked = entries.filter(e => e.uploadStatus === 'not_uploaded');
  if (unchecked.length > 0) {
    const dest = destination ?? 's3';

    if (dest === 'local' && fsConfig) {
      const uploader = new FileSystemUploader(fsConfig);
      try {
        await Promise.all(unchecked.map(async (entry) => {
          const size = await uploader.headObject('', entry.name);
          if (size !== null) {
            entry.uploadStatus = 'completed';
          }
        }));
      } catch {
        // FS check is best-effort
      } finally {
        uploader.destroy();
      }
    } else if (dest === 's3' && s3Config) {
      const uploader = new S3MultipartUploader(s3Config);
      try {
        const prefix = s3Config.keyPrefix ? s3Config.keyPrefix.replace(/\/$/, '') + '/' : '';
        await Promise.all(unchecked.map(async (entry) => {
          const key = prefix + entry.name;
          const s3Size = await uploader.headObject(s3Config.bucket, key);
          if (s3Size !== null) {
            entry.uploadStatus = 'completed';
          }
        }));
      } catch {
        // S3 check is best-effort — don't fail the browse
      } finally {
        uploader.destroy();
      }
    }
  }

  return entries;
}
