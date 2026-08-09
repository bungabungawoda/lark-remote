import fs from 'node:fs';

/**
 * Find the first line in a JSONL file that matches a predicate using streaming reads.
 * Stops reading as soon as a match is found.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @param pred      Predicate applied to each trimmed non-empty line.
 * @returns The matching trimmed line, or null if no match / file not found / read error.
 */
export function findJsonlLine(filePath: string, pred: (line: string) => boolean): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  const chunk = Buffer.alloc(65536);
  let buf: Buffer = Buffer.alloc(0);

  try {
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      // Find the last newline so we only decode complete lines. UTF-8 multi-byte
      // characters never contain the 0x0A byte, so splitting on `\n` at the raw
      // byte level is always safe and never truncates a multi-byte sequence.
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        // Decode everything before the last `\n` and split into lines.
        const text = buf.subarray(0, nlIdx).toString('utf-8');
        // Keep the tail after the last `\n` as the new buffer.
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        // All elements except the last are guaranteed complete (they had their
        // own trailing `\n`). The last element is whatever followed the final
        // `\n` in `text`; it may be empty or a partial line — re-emit it as part
        // of the next buffer by prepending it back. But since we sliced on the
        // *last* newline in buf, everything before it is fully complete lines
        // joined by `\n`; the trailing fragment is already excluded by keeping
        // only buf.subarray(nlIdx+1). So `parts` here is the complete lines,
        // and `parts[parts.length-1]` is the final segment before the last `\n`
        // — which IS complete (the last `\n` we split on was its terminator).
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed && pred(trimmed)) {
            return trimmed;
          }
        }
        break;
      }
    }
    // Handle last remaining line (file without trailing newline).
    const trimmed = buf.toString('utf-8').trim();
    if (trimmed && pred(trimmed)) {
      return trimmed;
    }
  } finally {
    fs.closeSync(fd);
  }

  return null;
}

/**
 * Read the last non-empty line from a JSONL file using streaming reads.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @returns The last trimmed non-empty line, or null if the file is empty / not found.
 */
export function readLastJsonlLine(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  const chunk = Buffer.alloc(65536);
  let buf: Buffer = Buffer.alloc(0);
  let last: string | null = null;

  try {
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        const text = buf.subarray(0, nlIdx).toString('utf-8');
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed) {
            last = trimmed;
          }
        }
        break;
      }
    }
    const trimmed = buf.toString('utf-8').trim();
    if (trimmed) {
      last = trimmed;
    }
  } finally {
    fs.closeSync(fd);
  }

  return last;
}

/**
 * Read the last N non-empty lines from a JSONL file using streaming reads.
 *
 * Unlike `readJsonlLines` (which materializes the entire file into a `string[]`),
 * this only retains the last `n` lines — memory is O(n), not O(whole file). The
 * file is still read front-to-back in chunks (no reverse seek), but earlier
 * lines are discarded as soon as the buffer exceeds `n`, so a multi-MB file
 * costs only ~`n` line strings of resident memory.
 *
 * Used by tail-only read paths (P2-5) such as `isSessionActive`, which only
 * need to inspect the file's tail (e.g. the last ~20 loop events) but were
 * previously full-slurping the whole wire log.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @param n         Maximum number of trailing non-empty lines to retain.
 * @returns Array of the last ≤`n` raw line strings (empty lines excluded),
 *          in file order. Empty array if the file is empty / not found.
 */
export function readLastNJsonlLines(filePath: string, n: number): string[] {
  if (n <= 0) return [];
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }

  const chunk = Buffer.alloc(65536);
  let buf: Buffer = Buffer.alloc(0);
  const lines: string[] = [];

  try {
    for (;;) {
      const nread = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (nread === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, nread)]);
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        const text = buf.subarray(0, nlIdx).toString('utf-8');
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part);
            if (lines.length > n) {
              lines.splice(0, lines.length - n);
            }
          }
        }
        break;
      }
    }
    const tail = buf.toString('utf-8');
    if (tail.trim()) {
      lines.push(tail);
      if (lines.length > n) {
        lines.splice(0, lines.length - n);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}

/**
 * Stream-scan a JSONL file once, invoking `onLine` for each non-empty line
 * with the line's raw string and its **starting byte offset** within the file.
 *
 * Unlike `readJsonlLines` this retains NOTHING — memory is O(chunk), not
 * O(whole file). The callback receives the byte offset so callers can record
 * where a line of interest (e.g. the last user message) begins, then re-read
 * only the tail from that offset via `readJsonlLinesFromOffset` (P2-5
 * byte-offset two-pass: full-file scalar scan without materializing a
 * `string[]`, then tail-only re-parse for events).
 *
 * @param filePath Absolute path to a `.jsonl` file.
 * @param onLine   Called for each non-empty line with `(line, offset)` where
 *                 `offset` is the byte offset of the line's first character.
 * @returns `true` if the file was opened and scanned, `false` on open error.
 */
export function scanJsonlLines(
  filePath: string,
  onLine: (line: string, offset: number) => void,
): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }

  const chunk = Buffer.alloc(65536);
  // Raw byte buffer holding the not-yet-decoded tail (everything after the
  // last consumed `\n`). Byte offsets are tracked against the real file, so
  // they are immune to multi-byte UTF-8 decode artifacts.
  let buf: Buffer = Buffer.alloc(0);
  let baseOffset = 0;

  try {
    for (;;) {
      const nread = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (nread === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, nread)]);
      // Decode all complete lines (everything up to the last `\n`). The tail
      // after the last `\n` stays in `buf` for the next iteration.
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        const complete = buf.subarray(0, nlIdx);
        const text = complete.toString('utf-8');
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        let cursor = baseOffset;
        for (const part of parts) {
          if (part.trim()) {
            onLine(part, cursor);
          }
          // advance past this line + its '\n' (1 byte)
          cursor += Buffer.byteLength(part, 'utf-8') + 1;
        }
        baseOffset += complete.length + 1;
        break;
      }
    }
    const tail = buf.toString('utf-8');
    if (tail.trim()) {
      onLine(tail, baseOffset);
    }
  } finally {
    fs.closeSync(fd);
  }

  return true;
}

/**
 * Read all non-empty lines starting from a byte `offset` in a JSONL file.
 *
 * Companion to `scanJsonlLines` for the P2-5 byte-offset two-pass pattern:
 * pass 1 records the offset where the tail begins (e.g. the byte right after
 * the last user message); pass 2 seeks there and reads/parses only the tail,
 * so raw line-string memory is O(tail) instead of O(whole file).
 *
 * @param filePath Absolute path to a `.jsonl` file.
 * @param offset   Byte offset to seek to before reading. **Must fall on a line
 *                 boundary** (e.g. 0, or the start of the line after the last
 *                 user message as recorded by `scanJsonlLines`); a mid-line
 *                 offset will include a leading partial line.
 * @returns Array of raw line strings from `offset` to EOF (empty lines
 *          excluded). Empty array on open/seek error or `offset` past EOF.
 */
export function readJsonlLinesFromOffset(filePath: string, offset: number): string[] {
  if (offset < 0) return [];
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }

  const chunk = Buffer.alloc(65536);
  let buf: Buffer = Buffer.alloc(0);
  const lines: string[] = [];

  try {
    let position = offset;
    for (;;) {
      const nread = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (nread === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, nread)]);
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        const text = buf.subarray(0, nlIdx).toString('utf-8');
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part);
          }
        }
        break;
      }
      position += nread;
    }
    const tail = buf.toString('utf-8');
    if (tail.trim()) {
      lines.push(tail);
    }
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}

/**
 * Read all non-empty lines from a JSONL file using streaming reads.
 *
 * @param filePath  Absolute path to a `.jsonl` file.
 * @param chunkSize Buffer size for each `fs.readSync` call (default 65536).
 * @returns Array of raw line strings (empty lines excluded).
 */
export function readJsonlLines(filePath: string, chunkSize: number = 65536): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  const chunk = Buffer.alloc(chunkSize);
  let buf: Buffer = Buffer.alloc(0);
  const lines: string[] = [];

  try {
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      let nlIdx: number;
      while ((nlIdx = buf.lastIndexOf(0x0a)) !== -1) {
        const text = buf.subarray(0, nlIdx).toString('utf-8');
        buf = buf.subarray(nlIdx + 1);
        const parts = text.split('\n');
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part);
          }
        }
        break;
      }
    }
    const tail = buf.toString('utf-8');
    if (tail.trim()) {
      lines.push(tail);
    }
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}
