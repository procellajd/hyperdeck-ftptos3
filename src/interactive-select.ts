import type { BrowseEntry } from './file-browser.js';
import type { SlotStats } from './hyperdeck-client.js';

export interface SelectionResult {
  selected: BrowseEntry[];
  action: 'confirm' | 'quit' | 'refresh';
}

interface RenderLine {
  kind: 'header' | 'file' | 'title';
  entryIndex?: number;  // index into BrowseEntry[] for file lines
  slotName?: string;    // for header lines
}

export function interactiveSelect(
  entries: BrowseEntry[],
  slotStats?: Map<string, SlotStats>,
): Promise<SelectionResult> {
  return new Promise((resolve) => {
    const selected = new Set<number>();
    const lines: RenderLine[] = [];

    // Detect whether any entry has metadata (REST API succeeded)
    const hasMetadata = entries.some(e => e.codec || e.videoFormat || e.startTimecode || e.duration);

    // Compute column widths
    const nameWidth = Math.min(35, Math.max(8, ...entries.map(e => e.name.length)));
    const codecWidth = 14;
    const formatWidth = 14;
    const tcWidth = 11;

    // Build render lines grouped by slot
    const slotMap = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i++) {
      const slot = entries[i].slot;
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot)!.push(i);
    }

    // Insert title line at position 0 when metadata is present
    if (hasMetadata) {
      lines.push({ kind: 'title' });
    }

    for (const [slotName, indices] of slotMap) {
      lines.push({ kind: 'header', slotName });
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
        if (line.kind === 'title') {
          // Column title line — dim text, aligned to data columns
          // 9 chars for " > [✓]   " prefix
          let titleStr = '         ' + 'Filename'.padEnd(nameWidth + 2);
          titleStr += 'Codec'.padEnd(codecWidth);
          titleStr += 'Format'.padEnd(formatWidth);
          titleStr += 'Start TC'.padEnd(tcWidth + 2);
          titleStr += 'Duration'.padEnd(tcWidth + 2);
          titleStr += '    Size';
          out += `\x1b[2m${titleStr}\x1b[0m\n`;
        } else if (line.kind === 'header') {
          const slotName = line.slotName ?? '?';
          let headerStr = ` \x1b[1m${slotName}/\x1b[0m`;
          const stats = slotStats?.get(slotName);
          if (stats && stats.totalSize > 0) {
            const freeStr = formatSize(stats.remainingSize);
            const totalStr = formatSize(stats.totalSize);
            headerStr += `  \x1b[2m${freeStr} free / ${totalStr}`;
            if (stats.recordingTime > 0) {
              const hours = stats.recordingTime / 3600;
              const recStr = hours >= 1 ? `${Math.floor(hours)}h${Math.round((hours % 1) * 60)}m` : `${Math.round(hours * 60)}m`;
              headerStr += `  ~${recStr} rec time`;
            }
            headerStr += '\x1b[0m';
          }
          out += `${headerStr}\n`;
        } else {
          const entry = entries[line.entryIndex!];
          const isCursor = i === cursor;
          const isSelected = selected.has(line.entryIndex!);

          const pointer = isCursor ? '>' : ' ';
          const checkbox = isSelected ? '[\x1b[32m\u2713\x1b[0m]' : '[ ]';
          const nameStr = entry.name.padEnd(nameWidth + 2);
          const sizeStr = formatSize(entry.size).padStart(8);

          let metaStr = '';
          if (hasMetadata) {
            metaStr = (entry.codec ?? '').padEnd(codecWidth)
              + (entry.videoFormat ?? '').padEnd(formatWidth)
              + (entry.startTimecode ?? '').padEnd(tcWidth + 2)
              + (entry.duration ?? '').padEnd(tcWidth + 2);
          }

          let statusStr = '';
          if (entry.uploadStatus === 'completed') {
            statusStr = '  \x1b[32m\u2713 uploaded\x1b[0m';
          } else if (entry.uploadStatus === 'in_progress') {
            statusStr = `  \x1b[33m\u25D0 ${entry.transferPercent ?? 0}%\x1b[0m`;
          }

          const lineStr = ` ${pointer} ${checkbox}   ${nameStr}${metaStr}${sizeStr}${statusStr}`;

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
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
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
      // Skip header and title lines
      while (next >= 0 && next < lines.length && lines[next].kind !== 'file') {
        next += direction;
      }
      if (next >= 0 && next < lines.length) {
        cursor = next;
      }
    }

    function onData(data: Buffer) {
      const key = data.toString();

      // Arrow keys (escape sequences)
      if (key === '\x1b[A' || key === 'k') {
        moveCursor(-1);
      } else if (key === '\x1b[B' || key === 'j') {
        moveCursor(1);
      } else if (key === ' ') {
        const line = lines[cursor];
        if (line.kind === 'file' && line.entryIndex !== undefined) {
          if (selected.has(line.entryIndex)) {
            selected.delete(line.entryIndex);
          } else {
            selected.add(line.entryIndex);
          }
        }
      } else if (key === '\r' || key === '\n') {
        finish('confirm');
        return;
      } else if (key === 'q' || key === 'Q' || key === '\x03') {
        finish('quit');
        return;
      } else if (key === 'a' || key === 'A') {
        // Select all non-completed files
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].uploadStatus !== 'completed') {
            selected.add(i);
          }
        }
      } else if (key === 'n' || key === 'N') {
        selected.clear();
      } else if (key === 'r' || key === 'R') {
        finish('refresh');
        return;
      } else {
        return; // Unknown key, don't re-render
      }

      render();
    }

    // Set up raw mode + data events (no readline dependency)
    if (!process.stdin.isTTY) {
      console.error('Interactive mode requires a TTY');
      resolve({ selected: [], action: 'quit' });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);

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
