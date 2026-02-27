import { createConnection, type Socket } from 'node:net';
import type { HyperDeckClip, HyperDeckDeviceInfo, HyperDeckSlotInfo } from './types.js';

export interface ClipMeta {
  codec: string;
  videoFormat: string;
  startTimecode: string;
  duration: string;
}

export interface SlotStats {
  remainingSize: number;  // bytes
  totalSize: number;      // bytes
  recordingTime: number;  // seconds
  status: string;
}

const HYPERDECK_PORT = 9993;
const CONNECT_TIMEOUT = 5000;
const COMMAND_TIMEOUT = 10000;

/**
 * Client for Blackmagic HyperDeck Ethernet Protocol (TCP port 9993).
 * Provides clip discovery and device info for transfer automation.
 *
 * Protocol: text-based, each command ends with \n, responses have a status
 * code line followed by key: value pairs, terminated by a blank line.
 */
export class HyperDeckClient {
  private socket: Socket | null = null;
  private readonly host: string;
  private buffer = '';

  constructor(host: string) {
    this.host = host;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          this.socket?.destroy();
          reject(new Error(`Connection to HyperDeck ${this.host} timed out`));
        });
      }, CONNECT_TIMEOUT);

      this.socket = createConnection({ host: this.host, port: HYPERDECK_PORT });
      this.socket.setEncoding('utf-8');

      // Wait for the initial connection banner (500 connection info)
      this.socket.once('data', (data: string) => {
        this.buffer = '';
        if (typeof data === 'string' && data.startsWith('500 ')) {
          settle(() => resolve());
        } else {
          settle(() => reject(new Error(`Unexpected HyperDeck banner: ${String(data).trim()}`)));
        }
      });

      this.socket.on('error', (err) => {
        settle(() => reject(err));
      });
    });
  }

  /**
   * Send a command and read the response.
   * Response format: "{code} {description}\r\n{key}: {value}\r\n...\r\n"
   */
  private async sendCommand(command: string): Promise<{ code: number; data: Record<string, string> }> {
    if (!this.socket || this.socket.destroyed) throw new Error('Not connected to HyperDeck');

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.socket?.removeListener('data', onData);
        this.socket?.removeListener('error', onError);
        this.socket?.removeListener('close', onClose);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`HyperDeck command timed out: ${command}`));
      }, COMMAND_TIMEOUT);

      let responseBuffer = '';

      const tryParse = (): boolean => {
        // Multi-line response: ends with \r\n\r\n or \n\n
        const endIndex = responseBuffer.indexOf('\r\n\r\n');
        const endIndexAlt = responseBuffer.indexOf('\n\n');
        const foundEnd = endIndex !== -1 ? endIndex + 4 : (endIndexAlt !== -1 ? endIndexAlt + 2 : -1);

        if (foundEnd !== -1) {
          const fullResponse = responseBuffer.substring(0, foundEnd);
          const lines = fullResponse.split(/\r?\n/).filter(l => l.length > 0);
          return finishParse(lines);
        }

        // Simple response: "200 ok\r\n" — status line without trailing colon
        // means no data block follows, resolve immediately
        const simpleMatch = responseBuffer.match(/^(\d{3}) (.+?)(\r?\n)/);
        if (simpleMatch && !simpleMatch[2].endsWith(':')) {
          const lines = [simpleMatch[0].trimEnd()];
          return finishParse(lines);
        }

        return false;
      };

      const finishParse = (lines: string[]): boolean => {
        if (lines.length === 0) {
          reject(new Error('Empty HyperDeck response'));
          return true;
        }

        const statusMatch = lines[0].match(/^(\d+)\s+(.*)$/);
        if (!statusMatch) {
          reject(new Error(`Invalid HyperDeck response: ${lines[0]}`));
          return true;
        }

        const code = parseInt(statusMatch[1], 10);
        const data: Record<string, string> = {};

        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(':');
          if (colonIdx !== -1) {
            const key = lines[i].substring(0, colonIdx).trim();
            const value = lines[i].substring(colonIdx + 1).trim();
            data[key] = value;
          }
        }

        resolve({ code, data });
        return true;
      };

      const onData = (chunk: string) => {
        responseBuffer += chunk;
        if (settled) return;

        if (tryParse()) {
          settled = true;
          cleanup();
        }
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`HyperDeck socket error during "${command}": ${err.message}`));
      };

      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`HyperDeck connection closed during "${command}"`));
      };

      this.socket!.on('data', onData);
      this.socket!.on('error', onError);
      this.socket!.on('close', onClose);
      this.socket!.write(command + '\n');
    });
  }

  async getDeviceInfo(): Promise<HyperDeckDeviceInfo> {
    const response = await this.sendCommand('device info');

    if (response.code !== 204) {
      throw new Error(`device info failed with code ${response.code}`);
    }

    const slotCount = parseInt(response.data['slot count'] ?? '2', 10);
    const slots: HyperDeckSlotInfo[] = [];

    for (let i = 1; i <= slotCount; i++) {
      try {
        const slotResponse = await this.sendCommand(`slot info: slot id: ${i}`);
        if (slotResponse.code === 202) {
          slots.push({
            slotId: i,
            status: slotResponse.data['status'] ?? 'unknown',
            volumeName: slotResponse.data['volume name'] ?? '',
            recordingTime: slotResponse.data['recording time'] ?? '',
            videoFormat: slotResponse.data['video format'] ?? '',
          });
        }
      } catch {
        // Slot may not be available
      }
    }

    return {
      protocolVersion: response.data['protocol version'] ?? '',
      model: response.data['model'] ?? '',
      uniqueId: response.data['unique id'] ?? '',
      slotCount,
      slots,
    };
  }

  async getClips(slotId: number = 1): Promise<HyperDeckClip[]> {
    // Select the slot first
    await this.sendCommand(`slot select: slot id: ${slotId}`);

    // Use disk list (code 206) which returns actual files on disk.
    // Unlike "clips get" (code 205) which returns playback timeline clips
    // and may be empty even when files exist on disk.
    const response = await this.sendCommand('disk list');
    if (response.code !== 206) {
      throw new Error(`disk list failed with code ${response.code}`);
    }

    const clips: HyperDeckClip[] = [];
    let idx = 1;

    // disk list response format per line:
    //   {index}: {name} {file_format} {video_format} {duration}
    // Parse right-to-left: duration is last token, video_format second-to-last,
    // file_format third-to-last, everything before that is the filename.
    for (const [key, value] of Object.entries(response.data)) {
      // Skip non-numeric keys (e.g. "slot id")
      if (!/^\d+$/.test(key)) continue;

      const parts = value.split(/\s+/);
      if (parts.length < 4) {
        // Minimal: name fileFormat videoFormat duration
        clips.push({
          id: idx++,
          name: parts[0] ?? `clip_${idx}`,
          codec: 'unknown',
          format: 'unknown',
          duration: parts[parts.length - 1] ?? '00:00:00;00',
          slot: slotId,
        });
        continue;
      }

      const duration = parts[parts.length - 1];
      const videoFormat = parts[parts.length - 2];
      const fileFormat = parts[parts.length - 3];
      const name = parts.slice(0, parts.length - 3).join(' ');

      clips.push({
        id: idx++,
        name: name || `clip_${idx}`,
        codec: fileFormat,
        format: videoFormat,
        duration: duration,
        slot: slotId,
      });
    }

    return clips;
  }

  /**
   * Get clip metadata via TCP for a set of clip filenames on a given slot.
   * Uses `disk list` for codec/format/duration and `clip info` for start timecode.
   */
  async getClipMeta(slotId: number, clipNames: Set<string>): Promise<Map<string, ClipMeta>> {
    const result = new Map<string, ClipMeta>();

    await this.sendCommand(`slot select: slot id: ${slotId}`);
    const diskResp = await this.sendCommand('disk list');
    if (diskResp.code !== 206) return result;

    // Parse disk list entries: {index}: {name} {file_format} {video_format} {duration}
    for (const [key, value] of Object.entries(diskResp.data)) {
      if (!/^\d+$/.test(key)) continue;
      const parts = value.split(/\s+/);
      if (parts.length < 4) continue;

      const duration = parts[parts.length - 1];
      const videoFormat = parts[parts.length - 2];
      const codec = parts[parts.length - 3];
      const name = parts.slice(0, parts.length - 3).join(' ');

      if (!clipNames.has(name)) continue;

      result.set(name, { codec, videoFormat, duration, startTimecode: '' });
    }

    // Fetch start timecode per clip via "clip info: name: {name}" (best-effort)
    for (const name of result.keys()) {
      try {
        const clipResp = await this.sendCommand(`clip info: name: ${name}`);
        if (clipResp.code === 228 || clipResp.code === 205 || clipResp.code === 206) {
          const tc = clipResp.data['start timecode'] ?? clipResp.data['timecode'] ?? '';
          if (tc) {
            result.get(name)!.startTimecode = tc;
          }
        }
      } catch {
        // Skip failures — start timecode is nice-to-have
      }
    }

    return result;
  }

  /**
   * Get slot-level stats: remaining/total size and recording time.
   */
  async getSlotStats(slotId: number): Promise<SlotStats | null> {
    try {
      const resp = await this.sendCommand(`slot info: slot id: ${slotId}`);
      if (resp.code !== 202) return null;

      return {
        remainingSize: parseInt(resp.data['remaining size'] ?? '0', 10),
        totalSize: parseInt(resp.data['total size'] ?? '0', 10),
        recordingTime: parseInt(resp.data['recording time'] ?? '0', 10),
        status: resp.data['status'] ?? 'unknown',
      };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.socket) {
      try {
        await this.sendCommand('quit');
      } catch {
        // Ignore quit errors
      }
      this.socket.destroy();
      this.socket = null;
    }
  }
}
