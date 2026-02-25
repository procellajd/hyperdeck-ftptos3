import * as readline from 'node:readline';
import type { BrowseEntry } from './file-browser.js';

export interface SelectionResult {
  selected: BrowseEntry[];
  action: 'confirm' | 'quit' | 'refresh';
}

interface RenderLine {
  kind: 'header' | 'file';
  entryIndex?: number;  // index into BrowseEntry[] for file lines
}

export function interactiveSelect(entries: BrowseEntry[]): Promise<SelectionResult> {
  return new Promise((resolve) => {
    const selected = new Set<number>();
    const lines: RenderLine[] = [];

    // Build render lines grouped by slot
    const slotMap = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i++) {
      const slot = entries[i].slot;
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot)!.push(i);
    }
    for (const [, indices] of slotMap) {
      lines.push({ kind: 'header' });
      for (const idx of indices) {
        lines.push({ kind: 'file', entryIndex: idx });
      }
    }

    // Find first navigable line
    let cursor = lines.findIndex(l => l.kind === 'file');
    if (cursor === -1) cursor = 0;
    let scrollOffset = 0;

    const completedCount = entries.filter(e => e.uploadStatus === 'completed').length;

    function getTermHeight(): number {
      return process.stdout.rows || 24;
    }

    function render() {
      const termHeight = getTermHeight();
      // Reserve 4 lines: header (2) + blank + footer
      const listHeight = termHeight - 4;

      // Adjust scroll so cursor is visible
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + listHeight) scrollOffset = cursor - listHeight + 1;

      let out = '\x1b[H\x1b[J'; // move to top-left, clear screen

      // Header
      out += ` hdfs browse \u2014 Select files to transfer (${entries.length} files, ${completedCount} already uploaded)\n\n`;

      // Visible slice of lines
      const visibleEnd = Math.min(lines.length, scrollOffset + listHeight);
      for (let i = scrollOffset; i < visibleEnd; i++) {
        const line = lines[i];
        if (line.kind === 'header') {
          // Find the slot name from the next file line
          const nextFile = lines.slice(i + 1).find(l => l.kind === 'file');
          const slotName = nextFile?.entryIndex !== undefined ? entries[nextFile.entryIndex].slot : '?';
          out += ` \x1b[1m${slotName}/\x1b[0m\n`;
        } else {
          const entry = entries[line.entryIndex!];
          const isCursor = i === cursor;
          const isSelected = selected.has(line.entryIndex!);

          const pointer = isCursor ? '>' : ' ';
          const checkbox = isSelected ? '[\x1b[32m\u2713\x1b[0m]' : '[ ]';
          const nameStr = entry.name;
          const sizeStr = formatSize(entry.size).padStart(8);

          let statusStr = '';
          if (entry.uploadStatus === 'completed') {
            statusStr = '  \x1b[32m\u2713 uploaded\x1b[0m';
          } else if (entry.uploadStatus === 'in_progress') {
            statusStr = `  \x1b[33m\u25D0 ${entry.transferPercent ?? 0}%\x1b[0m`;
          }

          const lineStr = ` ${pointer} ${checkbox}   ${nameStr}${sizeStr}${statusStr}`;

          if (isCursor) {
            out += `\x1b[7m${lineStr}\x1b[0m\n`;
          } else {
            out += `${lineStr}\n`;
          }
        }
      }

      // Pad remaining lines
      for (let i = visibleEnd - scrollOffset; i < listHeight; i++) {
        out += '\n';
      }

      // Footer
      const selectedCount = selected.size;
      out += `\n \x1b[2m\u2191\u2193 navigate | Space select | a all | n none | r refresh | Enter transfer${selectedCount > 0 ? ` (${selectedCount})` : ''} | q quit\x1b[0m`;

      process.stdout.write(out);
    }

    function cleanup() {
      // Show cursor, clear screen
      process.stdout.write('\x1b[?25h\x1b[H\x1b[J');
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('keypress', onKeypress);
        process.stdin.pause();
      }
    }

    function finish(action: 'confirm' | 'quit' | 'refresh') {
      cleanup();
      const selectedEntries = [...selected].map(i => entries[i]);
      resolve({ selected: selectedEntries, action });
    }

    function moveCursor(direction: -1 | 1) {
      let next = cursor + direction;
      // Skip header lines
      while (next >= 0 && next < lines.length && lines[next].kind !== 'file') {
        next += direction;
      }
      if (next >= 0 && next < lines.length) {
        cursor = next;
      }
    }

    function onKeypress(_str: string | undefined, key: readline.Key) {
      if (!key) return;

      if (key.name === 'up') {
        moveCursor(-1);
      } else if (key.name === 'down') {
        moveCursor(1);
      } else if (key.name === 'space') {
        const line = lines[cursor];
        if (line.kind === 'file' && line.entryIndex !== undefined) {
          if (selected.has(line.entryIndex)) {
            selected.delete(line.entryIndex);
          } else {
            selected.add(line.entryIndex);
          }
        }
      } else if (key.name === 'return') {
        finish('confirm');
        return;
      } else if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        finish('quit');
        return;
      } else if (key.name === 'a') {
        // Select all non-completed files
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].uploadStatus !== 'completed') {
            selected.add(i);
          }
        }
      } else if (key.name === 'n') {
        selected.clear();
      } else if (key.name === 'r') {
        finish('refresh');
        return;
      }

      render();
    }

    // Set up raw mode + keypress events
    if (!process.stdin.isTTY) {
      console.error('Interactive mode requires a TTY');
      resolve({ selected: [], action: 'quit' });
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    render();
  });
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
