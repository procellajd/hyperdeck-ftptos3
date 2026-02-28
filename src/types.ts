export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  timeout: number;
  keepalive: number;
  maxRetries: number;
}

export interface S3Config {
  bucket: string;
  keyPrefix: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  partSize: number;
  maxRetries: number;
  concurrency: number;
  checksumAlgorithm?: 'CRC32';
}

export type DestinationType = 's3' | 'local';

export interface FileSystemConfig {
  outputDir: string;
  partSize: number;
  maxRetries: number;
  concurrency: number;
}

export interface AppConfig {
  ftp: FtpConfig;
  s3: S3Config;
  destination: DestinationType;
  fs?: FileSystemConfig;
  highWaterMark: number;
  stateDir: string;
  progressInterval: number;
  hyperdeckHost?: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size: number;
  checksum?: string;  // Base64-encoded CRC32
}

export interface TransferState {
  transferId: string;
  uploadId: string;
  bucket: string;
  key: string;
  ftpPath: string;
  totalFileSize: number;
  partSize: number;
  completedParts: CompletedPart[];
  totalBytesTransferred: number;
  status: 'in_progress' | 'completed' | 'aborted';
  destination?: DestinationType;
  createdAt: string;
  updatedAt: string;
}

export interface TransferProgress {
  transferId: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number; // bytes per second
  elapsed: number; // ms
  eta: number; // ms
  partsCompleted: number;
  totalParts: number;
  memoryUsage: NodeJS.MemoryUsage;
}

export interface HyperDeckClip {
  id: number;
  name: string;
  codec: string;
  format: string;
  duration: string;
  slot: number;
  startTimecode?: string;
  fileSize?: number;
  container?: string;
  filePath?: string;
}

export interface HyperDeckDeviceInfo {
  protocolVersion: string;
  model: string;
  uniqueId: string;
  slotCount: number;
  slots: HyperDeckSlotInfo[];
}

export interface HyperDeckSlotInfo {
  slotId: number;
  status: string;
  volumeName: string;
  recordingTime: string;
  videoFormat: string;
}
