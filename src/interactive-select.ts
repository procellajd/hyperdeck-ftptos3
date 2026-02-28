import type { BrowseEntry } from './file-browser.js';
import type { SlotStats } from './hyperdeck-client.js';

export interface SelectionResult {
  selected: BrowseEntry[];
  action: 'confirm' | 'quit' | 'refresh' | 'clear';
}

interface RenderLine {
  kind: 'header' | 'file' | 'title';
  entryIndex?: number;  // index into BrowseEntry[] for file lines
  slotName?: string;    // for header lines
}

interface Layout {
  nameW: number;
  codecW: number;
  fmtW: number;
  tcW: number;
  durW: number;
  showCodec: boolean;
  showFmt: boolean;
  showTc: boolean;
  showDur: boolean;
}

const PREFIX_W = 7;  // " > [✓] "
const SIZE_W = 8;    // "324.6 GB" padStart

function shortenCodec(codec: string): string {
  return codec.replace(/^QuickTime/, 'QT ');
}

function truncName(name: string, width: number): string {
  if (name.length <= width) return name;
  if (width <= 1) return name.substring(0, width);
  return name.substring(0, width - 1) + '\u2026';
}

export function interactiveSelect(
  entries: BrowseEntry[],
  slotStats?: Map<string, SlotStats>,
): Promise<SelectionResult> {
  return new Promise((resolve) => {
    const selected = new Set<number>();
    const lines: RenderLine[] = [];

    const hasMetadata = entries.some(e => e.codec || e.videoFormat || e.startTimecode || e.duration);

    // Pre-compute shortened codec strings (indexed by entry index)
    const shortCodecs = entries.map(e => shortenCodec(e.codec ?? ''));

    // Measure actual max widths of metadata values
    const codecDataW = Math.max(0, ...shortCodecs.map(s => s.length));
    const fmtDataW = Math.max(0, ...entries.map(e => (e.videoFormat ?? '').length));
    const tcDataW = Math.max(0, ...entries.map(e => (e.startTimecode ?? '').length));
    const durDataW = Math.max(0, ...entries.map(e => (e.duration ?? '').length));
    const maxNameLen = Math.max(8, ...entries.map(e => e.name.length));

    // Build render lines grouped by slot
    const slotMap = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i++) {
      const slot = entries[i].slot;
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot)!.push(i);
    }

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

    /**
     * Compute adaptive column layout based on terminal width.
     * Columns added in priority order: name+size always,
     * then codec+format, duration, start timecode as space allows.
     */
    function computeLayout(termCols: number): Layout {
      const MIN_NAME = 16;
      const FIXED = PREFIX_W + SIZE_W + 1; // +1 for space before size

      if (!hasMetadata) {
        return {
          nameW: Math.max(MIN_NAME, Math.min(maxNameLen, termCols - FIXED)),
          codecW: 0, fmtW: 0, tcW: 0, durW: 0,
          showCodec: false, showFmt: false, showTc: false, showDur: false,
        };
      }

      let metaW = 0;
      let showCodec = false, showFmt = false, showDur = false, showTc = false;

      // Try codec + format (always together, +1 space separator each)
      const cfW = (codecDataW > 0 ? codecDataW + 1 : 0) + (fmtDataW > 0 ? fmtDataW + 1 : 0);
      if (cfW > 0 && termCols - FIXED - cfW >= MIN_NAME) {
        showCodec = codecDataW > 0;
        showFmt = fmtDataW > 0;
        metaW += cfW;
      }

      // Try duration
      if (showCodec && durDataW > 0) {
        const dW = durDataW + 1;
        if (termCols - FIXED - metaW - dW >= MIN_NAME) {
          showDur = true;
          metaW += dW;
        }
      }

      // Try start timecode
      if (showCodec && tcDataW > 0) {
        const tW = tcDataW + 1;
        if (termCols - FIXED - metaW - tW >= MIN_NAME) {
          showTc = true;
          metaW += tW;
        }
      }

      const nameW = Math.max(MIN_NAME, Math.min(maxNameLen, termCols - FIXED - metaW));

      return {
        nameW,
        codecW: showCodec ? codecDataW : 0,
        fmtW: showFmt ? fmtDataW : 0,
        tcW: showTc ? tcDataW : 0,
        durW: showDur ? durDataW : 0,
        showCodec, showFmt, showTc, showDur,
      };
    }

    function render() {
      const termHeight = process.stdout.rows || 24;
      const termCols = process.stdout.columns || 80;
      const listHeight = termHeight - 4;
      const L = computeLayout(termCols);

      // Adjust scroll so cursor is visible
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + listHeight) scrollOffset = cursor - listHeight + 1;

      let out = '\x1b[H\x1b[J'; // move to top-left, clear screen

      // Header
      out += ` browse \u2014 ${entries.length} files, ${completedCount} uploaded\n\n`;

      // Visible slice of lines
      const visibleEnd = Math.min(lines.length, scrollOffset + listHeight);
      for (let i = scrollOffset; i < visibleEnd; i++) {
        const line = lines[i];
        if (line.kind === 'title') {
          // Column titles — aligned with data, dim
          let t = ' '.repeat(PREFIX_W) + 'Name'.padEnd(L.nameW + 1);
          if (L.showCodec) t += 'Codec'.padEnd(L.codecW + 1);
          if (L.showFmt) t += 'Format'.padEnd(L.fmtW + 1);
          if (L.showTc) t += 'TC In'.padEnd(L.tcW + 1);
          if (L.showDur) t += 'Duration'.padEnd(L.durW + 1);
          t += 'Size'.padStart(SIZE_W);
          out += `\x1b[2m${t}\x1b[0m\n`;
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
              const recStr = hours >= 1
                ? `${Math.floor(hours)}h${Math.round((hours % 1) * 60)}m`
                : `${Math.round(hours * 60)}m`;
              headerStr += `  ~${recStr} rec`;
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
          const nameStr = truncName(entry.name, L.nameW).padEnd(L.nameW + 1);
          const sizeStr = formatSize(entry.size).padStart(SIZE_W);

          let metaStr = '';
          if (L.showCodec) metaStr += shortCodecs[line.entryIndex!].padEnd(L.codecW + 1);
          if (L.showFmt) metaStr += (entry.videoFormat ?? '').padEnd(L.fmtW + 1);
          if (L.showTc) metaStr += (entry.startTimecode ?? '').padEnd(L.tcW + 1);
          if (L.showDur) metaStr += (entry.duration ?? '').padEnd(L.durW + 1);

          let statusStr = '';
          if (entry.uploadStatus === 'completed') {
            statusStr = ' \x1b[32m\u2713 up\x1b[0m';
          } else if (entry.uploadStatus === 'in_progress') {
            statusStr = ` \x1b[33m\u25D0${entry.transferPercent ?? 0}%\x1b[0m`;
          }

          const lineStr = ` ${pointer} ${checkbox} ${nameStr}${metaStr}${sizeStr}${statusStr}`;

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
      out += `\n \x1b[2m\u2191\u2193 nav | Space sel | a all | n none | c clear | r refresh | Enter xfer${selectedCount > 0 ? ` (${selectedCount})` : ''} | q quit\x1b[0m`;

      process.stdout.write(out);
    }

    function cleanup() {
      process.stdout.write('\x1b[?25h\x1b[H\x1b[J');
      if (process.stdin.isTTY) {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function finish(action: 'confirm' | 'quit' | 'refresh' | 'clear') {
      cleanup();
      const selectedEntries = [...selected].map(i => entries[i]);
      resolve({ selected: selectedEntries, action });
    }

    function moveCursor(direction: -1 | 1) {
      let next = cursor + direction;
      while (next >= 0 && next < lines.length && lines[next].kind !== 'file') {
        next += direction;
      }
      if (next >= 0 && next < lines.length) {
        cursor = next;
      }
    }

    function onData(data: Buffer) {
      const key = data.toString();

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
      } else if (key === 'c' || key === 'C') {
        finish('clear');
        return;
      } else {
        return;
      }

      render();
    }

    if (!process.stdin.isTTY) {
      console.error('Interactive mode requires a TTY');
      resolve({ selected: [], action: 'quit' });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);

    process.stdout.write('\x1b[?25l'); // hide cursor
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
