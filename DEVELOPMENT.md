# HyperDeck FTP-to-S3/Local: Development Notes

## What This App Does

Streams large video files from a Blackmagic HyperDeck recorder via FTP directly into S3-compatible cloud storage (Cloudflare R2, AWS S3, Backblaze B2, etc.) **or a local/UNC network path** using multipart upload. For S3, no temporary files touch disk — the entire transfer is a streaming pipeline from the HyperDeck's FTP server through memory buffers into S3 parts. For local/UNC, parts are staged on disk and concatenated into the final file on completion.

Built for professional video production where HyperDeck devices record to internal SSDs and the footage needs to get to the cloud or a network share without pulling it to a local workstation first.

## Architecture

```
HyperDeck SSD
     |
     | FTP (1 Gbps LAN)
     v
 FTP Client (basic-ftp)
     |
     | PassThrough stream
     v
 ChunkerTransform
     | Accumulates data into exact part-sized buffers
     v
 Uploader (interface)
     |
     +--- S3MultipartUploader (AWS SDK v3)     +--- FileSystemUploader (Node.js fs)
     |    Concurrent uploads (3 default)       |    Writes parts to staging dir
     v                                         v
 Cloudflare R2 / AWS S3 / etc.           Local disk / UNC path
```

### Source Files

| File | Purpose |
|---|---|
| `cli.ts` | Commander.js CLI — `transfer`, `resume`, `abort`, `list`, `clips`, `info` commands + interactive setup |
| `transfer-manager.ts` | Orchestrates the full pipeline: FTP connect, chunking, concurrent upload via `Uploader` interface, state persistence |
| `uploader.ts` | `Uploader` interface — the contract both uploaders implement |
| `s3-multipart-uploader.ts` | S3 multipart operations with per-part retry and transient error detection. Implements `Uploader` |
| `fs-uploader.ts` | Filesystem uploader — writes parts to staging dir, concatenates on complete. Implements `Uploader` |
| `ftp-client.ts` | Wraps basic-ftp with keepalive, reconnect (exponential backoff), and streaming download |
| `chunker-transform.ts` | Node.js Transform stream that batches FTP data into exact `partSize`-byte buffers |
| `state-manager.ts` | Persists transfer progress to JSON files — enables resume after crash/interrupt |
| `progress-reporter.ts` | Real-time progress: speed, ETA, parts completed, memory usage |
| `file-browser.ts` | FTP file discovery — cross-references transfer state and destination (S3 or FS) for already-uploaded detection |
| `hyperdeck-client.ts` | HyperDeck Ethernet Protocol (TCP 9993) for clip discovery and device info |
| `config.ts` | Loads and validates environment variables with typed defaults (conditional per destination) |
| `types.ts` | TypeScript interfaces for all configuration and state |
| `index.ts` | Public API exports for library usage |

## How It Was Built

### Step 1: FTP Streaming Without Disk

The core challenge was avoiding disk. `basic-ftp`'s `downloadTo()` normally writes to a file or a Writable stream. We pass it a `PassThrough` stream and return that immediately without awaiting the download promise. This lets the caller consume data as it arrives while the download runs in the background.

```
FTP socket → basic-ftp internals → PassThrough → (consumer reads from here)
```

The PassThrough's `highWaterMark` (default 1 MB) controls how much FTP data buffers in memory before backpressure pauses the socket.

### Step 2: Chunking for S3 Multipart

S3 multipart upload requires discrete parts (minimum 5 MB each, maximum 10,000 parts per upload). FTP delivers data in arbitrary-sized TCP segments. `ChunkerTransform` sits between them: it accumulates incoming data into a pre-allocated `Buffer.allocUnsafe(partSize)` and pushes exactly one buffer per S3 part. The final part can be smaller.

### Step 3: Multipart Upload with Retry

Each part is uploaded via the AWS SDK's `UploadPartCommand`. The uploader distinguishes transient errors (5xx, network timeouts, throttling) from permanent ones (4xx auth failures) and only retries the former, with exponential backoff.

`completeMultipartUpload` sorts parts by number before sending — this is required by S3 and is important when parts complete out of order due to concurrency.

### Step 4: Resumable State

Every completed part is recorded to a JSON state file on disk. If the process crashes, `resume` loads the state, queries S3 `ListParts` to verify what actually made it (S3 is the source of truth, not local state), reconciles, and resumes FTP from the byte offset where it left off.

State writes use a temp-file-then-rename pattern to prevent corruption if the process dies mid-write.

### Step 5: Interactive Controls

The CLI enters raw TTY mode to capture immediate keypresses during transfer:
- `q` or first `Ctrl+C` — pause (saves state, resumable later)
- `a` — abort (deletes S3 upload and all uploaded parts)
- Second `Ctrl+C` within 3 seconds — force quit

## What Had to Change to Make It Work

### Problem: FTP Data Socket Timeout

The HyperDeck delivers data over a 1 Gbps LAN link, but S3 upload speed depends on the machine's internet bandwidth. In testing, upload to Cloudflare R2 was only ~5.5 Mbps. The original code uploaded parts **sequentially**: read a chunk from FTP, upload to S3, repeat. With 100 MB parts at 5.5 Mbps, each upload took ~140 seconds. During that time, no data was being read from the FTP stream, and basic-ftp's data socket timeout (30 seconds) would fire, crashing the transfer with:

```
Error: Timeout (data socket)
```

### Fix 1: Concurrent S3 Uploads

The `HDFS_S3_CONCURRENCY` config and `S3Config.concurrency` field already existed but weren't wired into the pipeline. The sequential loop:

```typescript
// Old: sequential — FTP stalls while each part uploads
for await (const chunk of readable) {
  const part = await uploader.uploadPart(...);  // blocks 140s
  stateManager.recordPart(state, part);
}
```

Was replaced with a bounded-concurrency pattern:

```typescript
// New: up to 3 parts upload simultaneously
for await (const chunk of readable) {
  if (this.aborted || pipelineError) break;

  const task = (async () => {
    const part = await uploader.uploadPart(...);
    stateManager.recordPart(state, part);
  })();

  const tracked = task
    .catch(err => { pipelineError = err; })
    .finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);

  if (inFlight.size >= concurrency) {
    await Promise.race(inFlight);  // wait for any one to finish
  }
}
await Promise.all(inFlight);  // drain remaining
```

This is safe in Node.js because:
- `uploadPart()` makes independent async AWS SDK calls
- `recordPart()` is entirely synchronous (`push` + `+=` + `writeFileSync`)
- `completeMultipartUpload()` sorts parts by number before sending

### Fix 2: Smaller Default Part Size (100 MB to 25 MB)

Even with 3 concurrent uploads, 100 MB parts at 5.5 Mbps took ~140 seconds each. The FTP stream would be paused by backpressure for most of that time, exceeding even a generous timeout.

With 25 MB parts, each upload takes ~36 seconds. With 3 concurrent, a slot opens every ~12 seconds on average, keeping FTP flowing. For a 185 GB file this means ~7,400 parts (well under S3's 10,000 limit).

### Fix 3: FTP Timeout Increase (30s to 120s)

The default 30-second data socket timeout was too aggressive for a use case where S3 upload speed is the bottleneck. Increased to 120 seconds for safety margin. Combined with 25 MB parts and 3x concurrency, the FTP stream is typically idle for ~34 seconds between reads — well within 120s.

### Fix 4: Unhandled Promise Rejection in FTP Client

The original download stream setup had a subtle bug:

```typescript
// Bug: separate .then() and .catch() on same promise
downloadPromise.catch((err) => { passThrough.destroy(err); });
downloadPromise.then(() => { passThrough.end(); });
```

When `downloadPromise` rejects, `.catch()` handles it, but `.then()` creates a **separate** promise chain that also rejects — with nobody catching it. This caused `node:internal/process/promises` to fire `triggerUncaughtException`, crashing the process.

Fixed by chaining into a single promise:

```typescript
downloadPromise.then(
  () => { passThrough.end(); },
  (err) => { passThrough.destroy(err); },
).finally(() => { this.startKeepalive(); });
```

### Fix 5: Stream Error Handling During Concurrent Uploads

With the concurrent pattern, if the FTP stream errors while `Promise.race(inFlight)` is waiting, the `for await` loop wouldn't see the error until its next `.next()` call. If the error threw out of the loop, in-flight upload promises would be orphaned and their completed parts lost.

Wrapped the `for await` in a try/catch so stream errors are captured and in-flight uploads still drain:

```typescript
try {
  for await (const chunk of readable) { /* ... */ }
} catch (err) {
  pipelineError = pipelineError ?? err;
}
await Promise.all(inFlight);  // still drain — saves completed parts
if (pipelineError) { saveState(); throw pipelineError; }
```

## Test Results

### Before (sequential, 100 MB parts, 30s timeout)

```
Transfer started (23 parts)
[id] 0.0% | 0 B/2.2 GB | 0 B/s | Parts: 0/23
... (30 seconds of 0%) ...
Error: Timeout (data socket)
node:internal/process/promises:394 triggerUncaughtException
```

Process crashed with unhandled rejection. Zero parts uploaded.

### After (concurrent, 25 MB parts, 120s timeout)

```
Transfer started (90 parts)
[id]  3.4% |  75 MB/2.2 GB | 15.0 MB/s | Parts: 3/90
[id] 13.4% | 300 MB/2.2 GB | 15.0 MB/s | Parts: 12/90
[id] 50.4% | 1.1 GB/2.2 GB | 15.0 MB/s | Parts: 45/90
[id] 100%  | 2.2 GB/2.2 GB | 26.6 MB/s | Parts: 90/90
Completing multipart upload...
Transfer complete: https://....r2.cloudflarestorage.com/hyperdecktor2/file.mxf
```

Full 2.2 GB file transferred successfully. Memory stable at ~290 MB. No timeouts, no crashes.

## Configuration Reference

All settings are environment variables (loaded from `.env`):

| Variable | Default | Description |
|---|---|---|
| `HDFS_FTP_HOST` | (required) | HyperDeck IP address |
| `HDFS_FTP_PORT` | `21` | FTP port |
| `HDFS_FTP_USER` | `anonymous` | FTP username |
| `HDFS_FTP_PASSWORD` | (empty) | FTP password |
| `HDFS_FTP_TIMEOUT` | `120000` | Data socket timeout (ms) |
| `HDFS_FTP_KEEPALIVE` | `10000` | NOOP keepalive interval (ms) |
| `HDFS_DESTINATION` | `s3` | Transfer destination: `s3` or `local` |
| `HDFS_S3_BUCKET` | (empty) | S3 bucket name (required when destination=s3) |
| `HDFS_S3_REGION` | `us-east-1` | S3 region (use `auto` for R2) |
| `HDFS_S3_ENDPOINT` | (none) | Custom S3 endpoint for R2/B2/etc |
| `HDFS_S3_KEY_PREFIX` | (empty) | Prefix for S3 object keys |
| `HDFS_S3_PART_SIZE` | `26214400` | Part size in bytes (25 MB) |
| `HDFS_S3_CONCURRENCY` | `3` | Concurrent S3 part uploads |
| `HDFS_S3_MAX_RETRIES` | `3` | Retries per part on transient error |
| `HDFS_S3_FORCE_PATH_STYLE` | `false` | Required for Backblaze B2 |
| `HDFS_FS_OUTPUT_DIR` | (none) | Output directory for local/UNC (required when destination=local) |
| `HDFS_FS_PART_SIZE` | `26214400` | Part size for FS staging (25 MB) |
| `HDFS_FS_CONCURRENCY` | `4` | Concurrent part writes |
| `HDFS_FS_MAX_RETRIES` | `3` | Retries per part write on error |
| `HDFS_HIGH_WATER_MARK` | `1048576` | FTP stream buffer size (1 MB) |
| `HDFS_STATE_DIR` | `./state` | Directory for transfer state files |
| `HDFS_PROGRESS_INTERVAL` | `5000` | Progress report interval (ms) |
| `HDFS_HYPERDECK_HOST` | (none) | HyperDeck IP for clip discovery |

## Key Takeaways

1. **FTP + slow upload = timeout trap.** When the downstream consumer (S3) is much slower than the upstream source (FTP), sequential processing stalls the source stream. Concurrency is essential.

2. **Part size matters more than you'd think.** 100 MB parts seemed reasonable but at 5.5 Mbps upload they took 140 seconds each — longer than any sensible timeout. 25 MB parts at the same speed take 36 seconds, keeping the pipeline moving.

3. **`.then()` and `.catch()` on the same promise create two chains.** If the promise rejects, the `.then()` branch produces an unhandled rejection. Use `.then(onFulfilled, onRejected)` or chain them.

4. **`for await` only sees stream errors on `.next()`.** If you're awaiting something else (like `Promise.race`) when the stream errors, you won't see it until the loop resumes. Wrap in try/catch and drain in-flight work before re-throwing.

5. **S3 is the source of truth for resume.** Local state files can be stale or corrupt. Always query `ListParts` and reconcile before resuming.

6. **Memory stays bounded with streaming.** Even transferring 2.2 GB, RSS stayed at ~290 MB — just the in-flight part buffers (3 x 25 MB = 75 MB) plus Node.js overhead. No disk needed.

---

## Local/UNC Filesystem Transfer Destination (v1.1)

### Why

The original app only supported S3-compatible storage. Production teams also need to land footage on a local NAS or UNC share (`\\server\share\footage` or `D:\footage`) without going through an S3-to-NAS sync step. Both destinations should coexist — the user picks which one during the browse setup flow.

### What Changed

The transfer pipeline (`executePipeline`) was already destination-agnostic — it only called `uploader.uploadPart()`. We extracted a formal `Uploader` interface, created a `FileSystemUploader` that implements it, and let the user choose destination at startup.

#### New Files

| File | Purpose |
|---|---|
| `src/uploader.ts` | `Uploader` interface — 7 methods that both uploaders implement |
| `src/fs-uploader.ts` | `FileSystemUploader` — writes parts to `.parts/<key>/<uploadId>/` staging dir, concatenates on complete |

#### Modified Files

| File | What Changed |
|---|---|
| `src/types.ts` | Added `DestinationType = 's3' \| 'local'`, `FileSystemConfig`, `destination` on `AppConfig`, optional `destination` on `TransferState` |
| `src/s3-multipart-uploader.ts` | Added `implements Uploader` to class declaration (no method changes) |
| `src/state-manager.ts` | `createState` accepts optional `destination` field; `loadState`/`listAll` default missing `destination` to `'s3'` for backward compat with existing state files |
| `src/config.ts` | Added `HDFS_DESTINATION`, `HDFS_FS_OUTPUT_DIR`, `HDFS_FS_PART_SIZE`, `HDFS_FS_MAX_RETRIES`, `HDFS_FS_CONCURRENCY` env vars; `HDFS_S3_BUCKET` defaults to empty (not required when destination is `local`); validation is conditional per destination |
| `src/transfer-manager.ts` | Uses `Uploader` interface via factory; `resume`/`abort` read `state.destination` to pick correct uploader; renamed `resolveS3Key` to `resolveOutputKey`; added `getPartSize()`, `getBucket()`, `getConcurrency()`, `destinationLabel()` helpers |
| `src/file-browser.ts` | `discoverFiles` accepts optional `fsConfig`/`destination` params; checks already-transferred files via `FileSystemUploader.headObject` when destination is `local` |
| `src/cli.ts` | Added `arrowSelect()` arrow-key selector; `runBrowse()` prompts for destination first, then S3 or local/UNC prompts; `list` command shows Dest column |
| `src/index.ts` | Exports `FileSystemUploader`, `Uploader`, `FileSystemConfig`, `DestinationType`, `UploaderFactory` |

### How FileSystemUploader Works

The filesystem uploader mirrors the S3 multipart upload lifecycle using the local filesystem:

```
createMultipartUpload  → mkdirSync(".parts/<key>/<uploadId>/")
                         returns a random UUID as uploadId

uploadPart             → writeFileSync temp file, renameSync to 000001.part
                         atomic write prevents partial parts on crash

completeMultipartUpload → streams all .part files into final output path
                          then deletes .parts/ staging directory

abortMultipartUpload    → rmSync(".parts/<key>/<uploadId>/", recursive)

listParts               → readdirSync(".parts/<key>/<uploadId>/")
                          returns part number + file size for each

headObject              → statSync on final output file
                          returns size or null if not found
```

This design enables resume support identical to S3 — if the process crashes, `listParts` reads the staging directory to find which parts completed, and the pipeline resumes from the correct byte offset.

### CLI Flow After Change

```
--- Connection Setup ---

HyperDeck IP address [172.18.0.191]:

Transfer destination:
  > S3
    Local / UNC path

Output directory []: \\server\share\footage
.env updated (2 values saved)

Connecting to FTP 172.18.0.191...
```

Arrow keys move the `>` cursor, Enter confirms. When `S3` is selected, the existing S3 prompts (bucket, endpoint, keys) appear instead.

### Backward Compatibility

- **Existing state files:** Transfer states saved before this change have no `destination` field. `loadState`/`listAll` default missing `destination` to `'s3'`, so existing in-progress transfers resume correctly.
- **Existing `.env` files:** `HDFS_DESTINATION` defaults to `'s3'`, so the app behaves identically without config changes. `HDFS_S3_BUCKET` now defaults to empty string instead of being required at load time — validation catches it only when destination is `'s3'`.
- **No new dependencies:** `FileSystemUploader` uses only Node.js built-in `fs` and `path` modules.

### What Worked Well

1. **The existing pipeline was already destination-agnostic.** `executePipeline` only called `uploader.uploadPart()`, `uploader.createMultipartUpload()`, etc. Extracting the `Uploader` interface required zero changes to the pipeline's control flow — just a type annotation swap from `S3MultipartUploader` to `Uploader`.

2. **Atomic writes for parts.** The same temp-file-then-rename pattern used by `StateManager` works well for part files. If the process crashes mid-write, the `.tmp` file is orphaned and the `.part` file doesn't exist — `listParts` won't see it, and resume will re-upload that part.

3. **The `bucket`/`key` parameter convention.** Rather than creating a completely different API surface, the FS uploader simply ignores `bucket` and uses `key` as a relative path under `outputDir`. This means the `TransferState` structure is identical for both destinations — same `key`, same `completedParts` array, same resume logic.

4. **Conditional config validation.** S3 bucket, endpoint, and credential validation only runs when `destination === 's3'`. This means users can set `HDFS_DESTINATION=local` without providing any S3 credentials, and vice versa. The `.env.example` documents all variables for both destinations.

5. **Arrow-key selector compiles cleanly.** The `arrowSelect()` function uses raw mode TTY input directly — no third-party dependency needed. It falls back gracefully in non-TTY environments by returning the default selection.

### What Didn't Work / Gotchas

1. **`completeMultipartUpload` streaming with `{ end: false }`.** When concatenating part files into the final output, you must pass `{ end: false }` to `pipeline()` so the write stream stays open between parts. Without it, the first part's pipeline call closes the write stream and subsequent parts fail with `ERR_STREAM_WRITE_AFTER_END`. After all parts are piped, you call `writeStream.end()` manually and await the `finish` event.

2. **UNC paths on Windows with Node.js `fs`.** Node.js `fs` handles UNC paths (`\\server\share\path`) natively on Windows, but the path separators can get tricky when mixed with `path.join()`. In practice, `path.join()` normalizes correctly on Windows (produces `\\server\share\path\file.mxf`), but this should be tested on actual UNC shares in production — the development environment used local paths only.

3. **`HDFS_S3_BUCKET` had to become optional.** Previously it was a required env var (`env('HDFS_S3_BUCKET')` threw if missing). When the user selects `local` destination, there's no bucket. Changing it to `env('HDFS_S3_BUCKET', '')` (default empty string) and moving the "bucket required" check into conditional validation was necessary but means a user with `HDFS_DESTINATION=s3` and no bucket set gets a validation error instead of the previous "missing env var" error. The error message is clear, but it's a subtle behavior change.

4. **State file `destination` field is optional.** Adding a new field to `TransferState` requires handling old state files that don't have it. The fix is simple (default to `'s3'` on load), but it's a pattern to be aware of for any future state schema changes. If more fields are added later, consider a `schemaVersion` field.

5. **No unit tests yet for `FileSystemUploader`.** The implementation compiles cleanly and follows the same patterns as the S3 uploader, but there are no automated tests. Priority test cases:
   - Part write + read round-trip
   - `completeMultipartUpload` concatenation order
   - `abortMultipartUpload` cleanup
   - `headObject` for existing vs missing files
   - Resume after partial transfer (some parts in staging dir)
   - UNC path handling on Windows

### New Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HDFS_DESTINATION` | `s3` | Transfer destination: `s3` or `local` |
| `HDFS_FS_OUTPUT_DIR` | (required when local) | Output directory path (local or UNC) |
| `HDFS_FS_PART_SIZE` | `26214400` | Part size for FS staging (25 MB) |
| `HDFS_FS_MAX_RETRIES` | `3` | Retries per part write on error |
| `HDFS_FS_CONCURRENCY` | `4` | Concurrent part writes (FS is faster than S3, so default is higher) |

### Verification Checklist

- [x] `npx tsc --noEmit` — compiles cleanly
- [x] `npm run build` — builds to dist/ with no errors
- [ ] `npm start` → choose `local` destination → select files → transfers to local path
- [ ] `npm start` → choose `s3` destination → existing S3 flow works unchanged
- [ ] Resume works for both: `hdfs resume` reads `destination` from state file
- [ ] `hdfs list` shows S3/LOCAL column for each transfer
- [ ] Already-transferred files detected on both destinations (state check + head check)
- [ ] UNC path tested on Windows with actual network share
