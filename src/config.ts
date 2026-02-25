import { config as dotenvConfig } from 'dotenv';
import type { AppConfig, DestinationType, FileSystemConfig } from './types.js';

dotenvConfig();

function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${key}: ${raw}`);
  return parsed;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === 'true' || raw === '1';
}

function envOptional(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined || value === '') return undefined;
  return value;
}

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const destination = env('HDFS_DESTINATION', 's3') as DestinationType;

  let fsConfig: FileSystemConfig | undefined;
  const fsOutputDir = envOptional('HDFS_FS_OUTPUT_DIR');
  if (destination === 'local' || fsOutputDir) {
    fsConfig = {
      outputDir: fsOutputDir ?? '',
      partSize: envInt('HDFS_FS_PART_SIZE', 25 * 1024 * 1024),
      maxRetries: envInt('HDFS_FS_MAX_RETRIES', 3),
      concurrency: envInt('HDFS_FS_CONCURRENCY', 4),
    };
  }

  const config: AppConfig = {
    ftp: {
      host: env('HDFS_FTP_HOST'),
      port: envInt('HDFS_FTP_PORT', 21),
      user: env('HDFS_FTP_USER', 'anonymous'),
      password: env('HDFS_FTP_PASSWORD', ''),
      timeout: envInt('HDFS_FTP_TIMEOUT', 120000),
      keepalive: envInt('HDFS_FTP_KEEPALIVE', 10000),
    },
    s3: {
      bucket: env('HDFS_S3_BUCKET', ''),
      keyPrefix: env('HDFS_S3_KEY_PREFIX', ''),
      region: env('HDFS_S3_REGION', 'us-east-1'),
      endpoint: envOptional('HDFS_S3_ENDPOINT'),
      accessKeyId: envOptional('HDFS_S3_ACCESS_KEY_ID'),
      secretAccessKey: envOptional('HDFS_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: envBool('HDFS_S3_FORCE_PATH_STYLE', false),
      partSize: envInt('HDFS_S3_PART_SIZE', 25 * 1024 * 1024),
      maxRetries: envInt('HDFS_S3_MAX_RETRIES', 3),
      concurrency: envInt('HDFS_S3_CONCURRENCY', 3),
    },
    destination,
    fs: fsConfig,
    highWaterMark: envInt('HDFS_HIGH_WATER_MARK', 1024 * 1024),
    stateDir: env('HDFS_STATE_DIR', './state'),
    progressInterval: envInt('HDFS_PROGRESS_INTERVAL', 5000),
    hyperdeckHost: envOptional('HDFS_HYPERDECK_HOST'),
  };

  if (overrides) {
    Object.assign(config, overrides);
  }

  validateConfig(config);
  return config;
}

function validateConfig(config: AppConfig): void {
  if (config.destination === 's3') {
    if (!config.s3.bucket) {
      throw new Error('S3 bucket is required when destination is s3');
    }
    if (config.s3.partSize < 5 * 1024 * 1024) {
      throw new Error('S3 part size must be at least 5MB');
    }
    if (config.s3.partSize > 5 * 1024 * 1024 * 1024) {
      throw new Error('S3 part size must not exceed 5GB');
    }
    if (config.s3.maxRetries < 0) {
      throw new Error('Max retries must be non-negative');
    }
    if (config.s3.concurrency < 1) {
      throw new Error('Concurrency must be at least 1');
    }
    if (config.s3.accessKeyId && !config.s3.secretAccessKey) {
      throw new Error('S3 secret access key is required when access key ID is provided');
    }
    if (!config.s3.accessKeyId && config.s3.secretAccessKey) {
      throw new Error('S3 access key ID is required when secret access key is provided');
    }
  }

  if (config.destination === 'local') {
    if (!config.fs?.outputDir) {
      throw new Error('Output directory (HDFS_FS_OUTPUT_DIR) is required when destination is local');
    }
    if (config.fs.maxRetries < 0) {
      throw new Error('Max retries must be non-negative');
    }
    if (config.fs.concurrency < 1) {
      throw new Error('Concurrency must be at least 1');
    }
  }
}
