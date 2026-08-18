import fs from 'node:fs';

/**
 * Stream a JSONL file line-by-line using chunked reads.
 *
 * Opens the file, reads in 64KB chunks, splits on `\n`, and invokes `onLine`
 * for each non-empty trimmed line. Handles files without a trailing newline.
 *
 * `onLine` may return `true` to **stop early** (no further reads); the file
 * descriptor is always closed in a `finally` block.
 *
 * @returns `true` if the file was opened and scanned, `false` on open error.
 */
function forEachJsonlLine(filePath: string, onLine: (line: string) => boolean | void): boolean {
  return forEachJsonlLineCore(filePath, { onLine });
}

/**
 * Variant of `forEachJsonlLine` that also tracks **byte offsets** for each line.
 *
 * `onLine` receives `(line, offset)` where `offset` is the starting byte offset
 * of the line within the file. May return `true` to stop early.
 *
 * @returns `true` if the file was opened and scanned, `false` on open error.
 */
function forEachJsonlLineWithOffset(
  filePath: string,
  onLine: (line: string, offset: number) => boolean | void,
): boolean {
  return forEachJsonlLineCore(filePath, {
    onLine: (line, offset) => onLine(line, offset ?? 0),
    trackOffsets: true,
  });
}

/**
 * Variant of `forEachJsonlLine` that starts reading from a byte `offset`.
 *
 * @param filePath Absolute path to a `.jsonl` file.
 * @param offset   Byte offset to seek to before reading. **Must fall on a line
 *                 boundary**; a mid-line offset will include a leading partial line.
 * @param onLine   Called for each non-empty trimmed line. May return `true` to stop early.
 * @returns `true` if the file was opened and scanned, `false` on open error.
 */
function forEachJsonlLineFromOffset(
  filePath: string,
  offset: number,
  onLine: (line: string) => boolean | void,
): boolean {
  if (offset < 0) return false;
  return forEachJsonlLineCore(filePath, { startOffset: offset, onLine });
}

/**
 * Core chunked JSONL reader shared by the three public variants. Reads the
 * file in 64KB chunks, splitting on `\n` at the byte level (UTF-8 multi-byte
 * characters never contain 0x0A, so this never truncates a multi-byte seq).
 *
 * @param opts.startOffset   Byte offset to seek to before reading (0 = start).
 * @param opts.trackOffsets  When true, pass each line's starting byte offset to onLine.
 * @param opts.onLine        Called per non-empty trimmed line; may return `true` to stop.
 */
function forEachJsonlLineCore(
  filePath: string,
  opts: {
    startOffset?: number;
    trackOffsets?: boolean;
    onLine: (line: string, offset?: number) => boolean | void;
  },
): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }

  const CHUNK_SIZE = 65536;
  const chunk = Buffer.alloc(CHUNK_SIZE);
  // Raw byte buffer holding the not-yet-decoded tail (everything after the
  // last consumed `\n`). UTF-8 multi-byte characters never contain 0x0A,
  // so splitting on `\n` at the byte level never truncates a multi-byte seq.
  let buf: Buffer = Buffer.alloc(0);
  let position = opts.startOffset ?? 0;
  let baseOffset = 0;
  let stop = false;

  try {
    for (;;) {
      const nread = fs.readSync(fd, chunk, 0, CHUNK_SIZE, position);
      if (nread === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, nread)]);
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        const complete = buf.subarray(0, nlIdx);
        const text = complete.toString('utf-8');
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        let cursor = (opts.startOffset ?? 0) + baseOffset;
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed) {
            if (opts.onLine(trimmed, opts.trackOffsets ? cursor : undefined) === true) {
              stop = true;
              break;
            }
          }
          cursor += Buffer.byteLength(part, 'utf-8') + 1;
        }
        baseOffset += complete.length + 1;
        break; // only process up to last complete newline per chunk
      }
      if (stop) break;
      position += nread;
    }
    // Handle remaining tail (file without trailing newline).
    if (!stop) {
      const tail = buf.toString('utf-8').trim();
      if (tail) {
        opts.onLine(tail, opts.trackOffsets ? (opts.startOffset ?? 0) + baseOffset : undefined);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return true;
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Find the first line in a JSONL file that matches a predicate using streaming reads.
 * Stops reading as soon as a match is found.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @param pred      Predicate applied to each trimmed non-empty line.
 * @returns The matching trimmed line, or null if no match / file not found / read error.
 */
export function findJsonlLine(filePath: string, pred: (line: string) => boolean): string | null {
  let found: string | null = null;
  forEachJsonlLine(filePath, (line) => {
    if (pred(line)) {
      found = line;
      return true; // stop early
    }
  });
  return found;
}

/**
 * Read the last non-empty line from a JSONL file using streaming reads.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @returns The last trimmed non-empty line, or null if the file is empty / not found.
 */
export function readLastJsonlLine(filePath: string): string | null {
  let last: string | null = null;
  forEachJsonlLine(filePath, (line) => {
    last = line;
  });
  return last;
}

/**
 * Read the last N non-empty lines from a JSONL file using streaming reads.
 *
 * Unlike `readJsonlLines` (which materializes the entire file into a `string[]`),
 * this only retains the last `n` lines — memory is O(n), not O(whole file).
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @param n         Maximum number of trailing non-empty lines to retain.
 * @returns Array of the last ≤`n` raw line strings (empty lines excluded),
 *          in file order. Empty array if the file is empty / not found.
 */
export function readLastNJsonlLines(filePath: string, n: number): string[] {
  if (n <= 0) return [];
  const lines: string[] = [];
  forEachJsonlLine(filePath, (line) => {
    lines.push(line);
    if (lines.length > n) {
      lines.splice(0, lines.length - n);
    }
  });
  return lines;
}

/**
 * Stream-scan a JSONL file once, invoking `onLine` for each non-empty line
 * with the line's raw string and its **starting byte offset** within the file.
 *
 * Memory is O(chunk), not O(whole file). The callback receives the byte offset
 * so callers can record where a line of interest begins, then re-read only the
 * tail from that offset via `readJsonlLinesFromOffset`.
 *
 * @param filePath Absolute path to a `.jsonl` file.
 * @param onLine   Called for each non-empty line with `(line, offset)`.
 * @returns `true` if the file was opened and scanned, `false` on open error.
 */
export function scanJsonlLines(
  filePath: string,
  onLine: (line: string, offset: number) => void,
): boolean {
  return forEachJsonlLineWithOffset(filePath, onLine);
}

/**
 * Read all non-empty lines starting from a byte `offset` in a JSONL file.
 *
 * Companion to `scanJsonlLines` for the byte-offset two-pass pattern.
 *
 * @param filePath Absolute path to a `.jsonl` file.
 * @param offset   Byte offset to seek to before reading. **Must fall on a line
 *                 boundary**; a mid-line offset will include a leading partial line.
 * @returns Array of raw line strings from `offset` to EOF (empty lines
 *          excluded). Empty array on open/seek error or `offset` past EOF.
 */
export function readJsonlLinesFromOffset(filePath: string, offset: number): string[] {
  const lines: string[] = [];
  forEachJsonlLineFromOffset(filePath, offset, (line) => {
    lines.push(line);
  });
  return lines;
}

/**
 * Read all non-empty lines from a JSONL file using streaming reads.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @returns Array of raw line strings (empty lines excluded).
 */
export function readJsonlLines(filePath: string): string[] {
  const lines: string[] = [];
  forEachJsonlLine(filePath, (line) => {
    lines.push(line);
  });
  return lines;
}
