import { createConnection, type Socket } from 'node:net';
import type { HyperDeckClip, HyperDeckDeviceInfo, HyperDeckSlotInfo } from './types.js';

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
      const timer = setTimeout(() => {
        reject(new Error(`Connection to HyperDeck ${this.host} timed out`));
      }, CONNECT_TIMEOUT);

      this.socket = createConnection({ host: this.host, port: HYPERDECK_PORT }, () => {
        clearTimeout(timer);
      });

      this.socket.setEncoding('utf-8');

      // Wait for the initial connection banner (500 connection info)
      this.socket.once('data', (data: string) => {
        this.buffer = '';
        if (data.startsWith('500 ')) {
          resolve();
        } else {
          reject(new Error(`Unexpected HyperDeck banner: ${data.trim()}`));
        }
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Send a command and read the response.
   * Response format: "{code} {description}\r\n{key}: {value}\r\n...\r\n"
   */
  private async sendCommand(command: string): Promise<{ code: number; data: Record<string, string> }> {
    if (!this.socket) throw new Error('Not connected to HyperDeck');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`HyperDeck command timed out: ${command}`));
      }, COMMAND_TIMEOUT);

      let responseBuffer = '';

      const onData = (chunk: string) => {
        responseBuffer += chunk;

        // Look for complete response: ends with \r\n\r\n or \n\n
        const endIndex = responseBuffer.indexOf('\r\n\r\n');
        const endIndexAlt = responseBuffer.indexOf('\n\n');
        const foundEnd = endIndex !== -1 ? endIndex + 4 : (endIndexAlt !== -1 ? endIndexAlt + 2 : -1);

        if (foundEnd !== -1) {
          clearTimeout(timer);
          this.socket?.removeListener('data', onData);

          const fullResponse = responseBuffer.substring(0, foundEnd);
          const lines = fullResponse.split(/\r?\n/).filter(l => l.length > 0);

          if (lines.length === 0) {
            reject(new Error('Empty HyperDeck response'));
            return;
          }

          // Parse status line: "{code} {description}"
          const statusMatch = lines[0].match(/^(\d+)\s+(.*)$/);
          if (!statusMatch) {
            reject(new Error(`Invalid HyperDeck response: ${lines[0]}`));
            return;
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
        }
      };

      this.socket!.on('data', onData);
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

    const response = await this.sendCommand('disk list');
    if (response.code !== 206) {
      throw new Error(`disk list failed with code ${response.code}`);
    }

    // The clips command returns clip list in the response body
    const clipsResponse = await this.sendCommand('clips get');
    if (clipsResponse.code !== 205) {
      throw new Error(`clips get failed with code ${clipsResponse.code}`);
    }

    const clips: HyperDeckClip[] = [];
    const clipCount = parseInt(clipsResponse.data['clip count'] ?? '0', 10);

    // Clips are numbered 1..clipCount in the response data
    for (let i = 1; i <= clipCount; i++) {
      const clipLine = clipsResponse.data[String(i)];
      if (clipLine) {
        // Format: "name codec format duration"
        const parts = clipLine.split(/\s+/);
        clips.push({
          id: i,
          name: parts[0] ?? `clip_${i}`,
          codec: parts[1] ?? 'unknown',
          format: parts[2] ?? 'unknown',
          duration: parts[3] ?? '00:00:00;00',
          slot: slotId,
        });
      }
    }

    return clips;
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
