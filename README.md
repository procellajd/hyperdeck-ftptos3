# record2s3

Stream video recordings from Blackmagic HyperDeck devices directly to S3-compatible storage or local/UNC paths via FTP -- with zero local disk usage for cloud transfers.

## The Problem

HyperDeck Studio recorders write multi-gigabyte video files to internal SSDs. Getting those files off the deck and into cloud storage typically means: copy to a local drive, then upload. For a 65 GB recording session, that's slow, requires free disk space, and can't resume if something fails halfway.

## How It Works

record2s3 connects to the HyperDeck's built-in FTP server and streams data directly into S3 multipart uploads. Bytes flow from the HyperDeck through memory buffers straight to your storage destination -- no intermediate files, no local disk needed.

```
HyperDeck SSD → FTP → record2s3 (memory only) → S3 / R2 / B2 / Local / UNC
```

A 2.2 GB file transfers at ~27 MB/s with stable memory usage around 290 MB. If the transfer is interrupted, it resumes from the exact byte where it left off.

## Setup

**Requirements:** Node.js 18+ (or use the standalone Windows .exe)

```bash
git clone https://github.com/procellajd/hyperdeck-ftptos3.git
cd hyperdeck-ftptos3
npm install
cp .env.example .env
```

Edit `.env` with your HyperDeck IP and storage credentials, then run:

```bash
npx tsx src/cli.ts
```

The interactive setup will walk you through configuration on first run.

### Standalone Windows Executable

```bash
npm run exe
```

Produces `record2s3.exe` -- a single file you can run on any Windows machine without Node.js installed.

## Commands

### Browse & Transfer (default)

```bash
record2s3
```

Interactive file browser that discovers all clips on the HyperDeck, shows metadata (codec, format, duration, timecode), and lets you select which to transfer.

```
 browse — 9 files, 2 uploaded

         Name                 Codec          Format         TC In        Duration     Size
 ─ ssd1/                     1.2 TB free / 2.0 TB  ~14h rec
   [ ] CALENDAR-TEST.mov     QT DNxHR HQX   2160p29.97     10:29:15:00  00:05:00:00  4.4 GB
   [✓] TC-TEST-1MIN.mov      QT DNxHR HQX   2160p29.97     01:00:00:00  00:01:00:00  878.4 MB  ✓ up
 > [ ] coconuttest.mov        QT DNxHR HQX   2160p29.97     22:29:03:00  00:00:31:00  455.0 MB

 ↑↓ nav | Space sel | a all | n none | c clear | r refresh | Enter xfer | q quit
```

### Transfer a Single File

```bash
record2s3 transfer /ssd1/recording.mov
```

Real-time progress with download/upload speeds, ETA, and memory usage:

```
  ████████████████████░░░░░░░░░░  67.3%  1.5/2.2 GB  DL: 28.1 Mbps  UL: 26.4 Mbps  ETA: 0:42  Parts: 60/90
  CRC32 ✓ | Ctrl+C/q: pause | a: abort | Ctrl+C x2: force quit
```

### Other Commands

| Command | Description |
|---------|-------------|
| `transfer-all --slot <id>` | Transfer all clips from a HyperDeck slot |
| `resume [transferId]` | Resume an interrupted transfer from where it left off |
| `list` | Show all transfers and their status |
| `abort <transferId>` | Cancel a transfer and clean up uploaded parts |
| `clips --slot <id>` | List clips on the HyperDeck with metadata |
| `info` | Show HyperDeck device info and slot status |

## Storage Destinations

### Amazon S3

```env
HDFS_DESTINATION=s3
HDFS_S3_BUCKET=my-bucket
HDFS_S3_REGION=us-east-1
HDFS_S3_ACCESS_KEY_ID=...
HDFS_S3_SECRET_ACCESS_KEY=...
```

### Cloudflare R2

```env
HDFS_DESTINATION=s3
HDFS_S3_BUCKET=my-bucket
HDFS_S3_REGION=auto
HDFS_S3_ENDPOINT=https://account-id.r2.cloudflarestorage.com
HDFS_S3_CHECKSUM=none
```

### Backblaze B2

```env
HDFS_DESTINATION=s3
HDFS_S3_BUCKET=my-bucket
HDFS_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
HDFS_S3_FORCE_PATH_STYLE=true
HDFS_S3_CHECKSUM=none
```

### IDrive e2

```env
HDFS_DESTINATION=s3
HDFS_S3_BUCKET=my-bucket
HDFS_S3_ENDPOINT=https://us-east-1.e2.idrivesync.com
HDFS_S3_CHECKSUM=none
```

### Local or Network Path

```env
HDFS_DESTINATION=local
HDFS_FS_OUTPUT_DIR=D:\footage
# or UNC: HDFS_FS_OUTPUT_DIR=\\server\share\footage
```

## Configuration Reference

### FTP (HyperDeck)

| Variable | Default | Description |
|----------|---------|-------------|
| `HDFS_FTP_HOST` | *required* | HyperDeck IP address |
| `HDFS_FTP_PORT` | `21` | FTP port |
| `HDFS_FTP_USER` | `anonymous` | FTP username |
| `HDFS_FTP_PASSWORD` | | FTP password |
| `HDFS_FTP_TIMEOUT` | `120000` | Data socket timeout (ms) |
| `HDFS_FTP_KEEPALIVE` | `10000` | Keepalive interval (ms) |

### S3 Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `HDFS_S3_BUCKET` | *required* | Target bucket |
| `HDFS_S3_KEY_PREFIX` | | Object key prefix |
| `HDFS_S3_REGION` | `us-east-1` | Bucket region |
| `HDFS_S3_ENDPOINT` | | Custom endpoint for R2/B2/e2 |
| `HDFS_S3_ACCESS_KEY_ID` | | Access key (or use AWS credential chain) |
| `HDFS_S3_SECRET_ACCESS_KEY` | | Secret key |
| `HDFS_S3_FORCE_PATH_STYLE` | `false` | Path-style URLs (required for B2) |
| `HDFS_S3_PART_SIZE` | `26214400` | Multipart part size in bytes (25 MB) |
| `HDFS_S3_MAX_RETRIES` | `3` | Retry count per part |
| `HDFS_S3_CONCURRENCY` | `8` | Concurrent part uploads |
| `HDFS_S3_CHECKSUM` | `CRC32` | Integrity checksum (`CRC32` or `none`) |

### Local Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `HDFS_FS_OUTPUT_DIR` | *required* | Output directory (supports UNC) |
| `HDFS_FS_PART_SIZE` | `26214400` | Part staging size (25 MB) |
| `HDFS_FS_MAX_RETRIES` | `3` | Retry count per part |
| `HDFS_FS_CONCURRENCY` | `4` | Concurrent part writes |

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `HDFS_DESTINATION` | `s3` | `s3` or `local` |
| `HDFS_HYPERDECK_HOST` | | HyperDeck IP for clip metadata |
| `HDFS_STATE_DIR` | `./state` | Transfer state directory |
| `HDFS_PROGRESS_INTERVAL` | `5000` | Progress update interval (ms) |
| `HDFS_HIGH_WATER_MARK` | `4194304` | Stream buffer size (4 MB) |

## Key Features

- **Zero disk usage** -- FTP data streams directly to S3 through memory buffers
- **Resumable transfers** -- state saved to disk; resume from exact byte offset after any interruption
- **CRC32 integrity checksums** -- optional end-to-end verification on S3 uploads
- **Auto part scaling** -- dynamically adjusts part size for files that would exceed S3's 10,000 part limit
- **Concurrent uploads** -- configurable parallelism to maximize throughput and prevent FTP timeouts
- **Interactive controls** -- pause (Ctrl+C), abort (a), or force quit during transfers
- **HyperDeck metadata** -- fetches codec, format, timecode, and duration via REST and TCP APIs
- **Multi-destination** -- S3, Cloudflare R2, Backblaze B2, IDrive e2, local filesystem, UNC paths
- **Standalone .exe** -- single-file Windows executable, no Node.js required
