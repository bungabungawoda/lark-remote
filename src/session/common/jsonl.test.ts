import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readJsonlLines,
  scanJsonlLines,
  readJsonlLinesFromOffset,
  readLastNJsonlLines,
  readLastJsonlLine,
  findJsonlLine,
} from './jsonl.js';

describe('readJsonlLines', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads all JSONL lines from a file', () => {
    const filePath = path.join(tmpDir, 'test.jsonl');
    const lines = [
      JSON.stringify({ type: 'system', cwd: '/home/user/project' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = readJsonlLines(filePath);

    expect(result).toHaveLength(3);
    expect(JSON.parse(result[0])).toEqual({ type: 'system', cwd: '/home/user/project' });
    expect(JSON.parse(result[1])).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    expect(JSON.parse(result[2])).toEqual({
      type: 'assistant',
      message: { role: 'assistant', content: 'hi' },
    });
  });

  it('accepts a custom chunkSize parameter', () => {
    const filePath = path.join(tmpDir, 'chunked.jsonl');
    // Write a file with content that spans multiple small chunks
    const line1 = JSON.stringify({ type: 'first', data: 'a'.repeat(200) });
    const line2 = JSON.stringify({ type: 'second', data: 'b'.repeat(200) });
    fs.writeFileSync(filePath, line1 + '\n' + line2 + '\n');

    // Use a tiny chunk size to force multi-chunk reads
    const result = readJsonlLines(filePath, 64);

    expect(result).toHaveLength(2);
    expect(JSON.parse(result[0]).type).toBe('first');
    expect(JSON.parse(result[1]).type).toBe('second');
  });
});

/**
 * Direct boundary-case tests for the P2-5 byte-offset helpers.
 *
 * The offset arithmetic in `scanJsonlLines` (recording the byte offset of the
 * line after the last user message) + `readJsonlLinesFromOffset` (seek + read
 * the tail) is the crux of the P2-5 tail-only read. These tests pin the exact
 * edge cases an adversarial reviewer verified empirically: user-message-is-
 * last-line (with/without trailing newline → empty tail), offset past EOF,
 * empty-line offset accounting, multi-byte UTF-8 content, and the rolling-
 * window behavior of `readLastNJsonlLines`.
 */
describe('scanJsonlLines', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-scan-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the correct byte offset for every line (ASCII, with trailing newline)', () => {
    const filePath = path.join(tmpDir, 'offsets.jsonl');
    const lines = [
      '{"type":"system","cwd":"/p"}',
      '{"type":"user","message":{"role":"user"}}',
      '{"type":"assistant","message":{"role":"assistant"}}',
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const seen: Array<{ line: string; offset: number }> = [];
    scanJsonlLines(filePath, (line, offset) => seen.push({ line, offset }));

    // Each line's reported start offset must equal the byte position where it
    // actually begins in the file (line[i].length + 1 for the '\n').
    let expected = 0;
    for (let i = 0; i < lines.length; i++) {
      expect(seen[i].line).toBe(lines[i]);
      expect(seen[i].offset).toBe(expected);
      expected += Buffer.byteLength(lines[i], 'utf-8') + 1;
    }
  });

  it('advances offset correctly across empty lines', () => {
    const filePath = path.join(tmpDir, 'empties.jsonl');
    const content = '{"a":1}\n\n{"b":2}\n';
    fs.writeFileSync(filePath, content);

    const seen: Array<{ line: string; offset: number }> = [];
    scanJsonlLines(filePath, (line, offset) => seen.push({ line, offset }));

    // Empty lines are skipped (not passed to the callback) but the offset of
    // the following non-empty line must account for them.
    expect(seen.map((s) => s.line)).toEqual(['{"a":1}', '{"b":2}']);
    // '{"a":1}' = 7 bytes + '\n'(1) = 8; empty '\n'(1) = 9; so {"b":2} starts at 9.
    expect(seen[0].offset).toBe(0);
    expect(seen[1].offset).toBe(9);
  });

  it('reports correct offsets for multi-byte UTF-8 content', () => {
    const filePath = path.join(tmpDir, 'utf8.jsonl');
    const lines = ['{"q":"你好"}', '{"q":"世界"}', '{"q":"✅"}'];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const seen: Array<{ line: string; offset: number }> = [];
    scanJsonlLines(filePath, (line, offset) => seen.push({ line, offset }));

    let expected = 0;
    for (let i = 0; i < lines.length; i++) {
      expect(seen[i].line).toBe(lines[i]);
      expect(seen[i].offset).toBe(expected);
      // Must use byte length (UTF-8), not string .length (UTF-16 code units).
      expected += Buffer.byteLength(lines[i], 'utf-8') + 1;
    }
  });

  it('handles the last line without a trailing newline', () => {
    const filePath = path.join(tmpDir, 'no-newline.jsonl');
    // No trailing '\n' on the final line.
    fs.writeFileSync(filePath, '{"a":1}\n{"b":2}');

    const seen: string[] = [];
    scanJsonlLines(filePath, (line) => seen.push(line));

    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('returns false when the file cannot be opened', () => {
    const ok = scanJsonlLines(path.join(tmpDir, 'does-not-exist.jsonl'), () => {});
    expect(ok).toBe(false);
  });
});

describe('readJsonlLinesFromOffset', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-fromoffset-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads only the tail when offset is the line after the last user message', () => {
    const filePath = path.join(tmpDir, 'tail.jsonl');
    const lines = [
      '{"type":"user","message":{"role":"user"}}',
      '{"type":"assistant","message":{"role":"assistant"}}',
      '{"type":"user","message":{"role":"user"}}',
      '{"type":"assistant","message":{"role":"assistant","text":"final"}}',
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    // Compute the offset right after the LAST user line (line index 2).
    let tailOffset = 0;
    scanJsonlLines(filePath, (line, offset) => {
      if (line.includes('"role":"user"')) {
        tailOffset = offset + Buffer.byteLength(line, 'utf-8') + 1;
      }
    });

    const tail = readJsonlLinesFromOffset(filePath, tailOffset);
    expect(tail).toHaveLength(1);
    expect(JSON.parse(tail[0]).message.text).toBe('final');
  });

  it('returns empty when the user message is the last line (trailing newline)', () => {
    const filePath = path.join(tmpDir, 'user-last-nl.jsonl');
    const lines = ['{"type":"user","message":{"role":"user"}}'];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    let tailOffset = -1;
    scanJsonlLines(filePath, (line, offset) => {
      tailOffset = offset + Buffer.byteLength(line, 'utf-8') + 1;
    });

    // tailOffset === file size (offset right after the '\n') → empty tail.
    expect(tailOffset).toBe(fs.statSync(filePath).size);
    expect(readJsonlLinesFromOffset(filePath, tailOffset)).toEqual([]);
  });

  it('returns empty when the user message is the last line (no trailing newline)', () => {
    const filePath = path.join(tmpDir, 'user-last-nonl.jsonl');
    const lines = ['{"type":"user","message":{"role":"user"}}'];
    fs.writeFileSync(filePath, lines.join('')); // no trailing '\n'

    let tailOffset = -1;
    scanJsonlLines(filePath, (line, offset) => {
      tailOffset = offset + Buffer.byteLength(line, 'utf-8') + 1;
    });

    // tailOffset lands 1 byte past EOF (the +1 assumes a '\n' that isn't there).
    // readJsonlLinesFromOffset must handle offset-past-EOF gracefully.
    expect(tailOffset).toBe(fs.statSync(filePath).size + 1);
    expect(readJsonlLinesFromOffset(filePath, tailOffset)).toEqual([]);
  });

  it('reads the whole file when offset is 0', () => {
    const filePath = path.join(tmpDir, 'whole.jsonl');
    const lines = ['{"a":1}', '{"b":2}', '{"c":3}'];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = readJsonlLinesFromOffset(filePath, 0);
    expect(result).toEqual(lines);
  });

  it('returns empty for a negative offset', () => {
    const filePath = path.join(tmpDir, 'neg.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n');
    expect(readJsonlLinesFromOffset(filePath, -1)).toEqual([]);
  });

  it('returns empty when the file cannot be opened', () => {
    expect(readJsonlLinesFromOffset(path.join(tmpDir, 'nope.jsonl'), 0)).toEqual([]);
  });
});

describe('readLastNJsonlLines', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-lastn-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retains only the last N non-empty lines (rolling window)', () => {
    const filePath = path.join(tmpDir, 'rolling.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => `{"i":${i}}`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = readLastNJsonlLines(filePath, 5);
    expect(result).toHaveLength(5);
    expect(result.map((l) => JSON.parse(l).i)).toEqual([45, 46, 47, 48, 49]);
  });

  it('returns all lines when the file has fewer than N', () => {
    const filePath = path.join(tmpDir, 'few.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n');

    const result = readLastNJsonlLines(filePath, 20);
    expect(result).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('excludes empty lines and handles no trailing newline', () => {
    const filePath = path.join(tmpDir, 'empties.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n\n{"b":2}'); // no trailing newline

    const result = readLastNJsonlLines(filePath, 10);
    expect(result).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('returns empty array for n <= 0 or unreadable file', () => {
    expect(readLastNJsonlLines(path.join(tmpDir, 'x'), 5)).toEqual([]);
    const filePath = path.join(tmpDir, 'x.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n');
    expect(readLastNJsonlLines(filePath, 0)).toEqual([]);
  });
});

/**
 * Adversarial red tests for a confirmed multi-byte UTF-8 cross-chunk-boundary
 * corruption bug in the shared JSONL reader (`src/session/common/jsonl.ts`).
 *
 * Root cause: every streaming reader uses `remainder += chunk.subarray(0, nread)
 * .toString('utf-8')`. When a multi-byte UTF-8 character straddles the 64 KiB
 * chunk boundary (first byte(s) at the tail of chunk N, remaining bytes at the
 * head of chunk N+1), each independent `Buffer.toString('utf-8')` call replaces
 * the incomplete leading/trailing sequence with U+FFFD (3 bytes each). String
 * concatenation cannot resurrect the original bytes, so:
 *
 *  1. The line content delivered to the `scanJsonlLines` callback is polluted
 *     with U+FFFD — the original multi-byte character is lost.
 *  2. `Buffer.byteLength(pollutedLine, 'utf-8')` is larger than the true byte
 *     length (U+FFFD = 3 bytes vs the original 1–2 trailing bytes), so the
 *     `tailOffset` computed by callers (`offset + byteLength(line) + 1`) is
 *     inflated.
 *  3. `readJsonlLinesFromOffset(filePath, inflatedTailOffset)` seeks into the
 *     middle of the next line, reads a half-line, and `JSON.parse` fails — the
 *     tail event is silently dropped.
 *
 * `readJsonlLinesFromOffset` and `readLastNJsonlLines` share the same
 * `remainder += chunk.toString('utf-8')` pattern, so they also see the U+FFFD
 * pollution on lines that cross the boundary.
 *
 * These tests must FAIL on the current (buggy) implementation and only pass
 * once the reader buffers raw bytes and decodes complete UTF-8 sequences.
 */
describe('scanJsonlLines multi-byte cross-chunk boundary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-mbc-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a JSONL file whose first line places a 3-byte UTF-8 character (`你`
   * = E4 BD A0) so that its first byte (E4) lands exactly on the last byte of
   * the first 64 KiB chunk (offset 65535). The second line is a normal
   * assistant message that the tail read must recover intact.
   */
  function buildCrossBoundaryFile(): {
    filePath: string;
    userLine: string;
    assistantLine: string;
    correctTailOffset: number;
  } {
    const filePath = path.join(tmpDir, 'cross-boundary.jsonl');
    // 51-byte fixed JSON prefix.
    const prefix = '{"type":"user","message":{"role":"user","content":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8'); // 51
    // Pad with ASCII so that prefixBytes + N = 65535 → first byte of `你` at
    // offset 65535, i.e. the very last byte of the first 64 KiB chunk.
    const N = 65535 - prefixBytes; // 65484
    const userLine = prefix + 'x'.repeat(N) + '你"}}';
    const assistantLine = '{"type":"assistant","message":{"role":"assistant","content":"hi"}}';
    fs.writeFileSync(filePath, userLine + '\n' + assistantLine + '\n');
    const correctTailOffset = Buffer.byteLength(userLine, 'utf-8') + 1; // 65542
    return { filePath, userLine, assistantLine, correctTailOffset };
  }

  it('test_anchor_scan_line_content_not_polluted_by_fffd', () => {
    const { filePath, userLine } = buildCrossBoundaryFile();

    let receivedUserLine = '';
    scanJsonlLines(filePath, (line) => {
      if (line.includes('"role":"user"')) {
        receivedUserLine = line;
      }
    });

    // The callback must receive the original content including `你`, not a
    // U+FFFD-polluted surrogate. On the buggy implementation the 3 bytes of
    // `你` are split across the chunk boundary and each `toString('utf-8')`
    // independently emits U+FFFD, so the received line contains replacement
    // characters instead of `你`.
    expect(receivedUserLine).toBe(userLine);
    expect(receivedUserLine).toContain('你');
    expect(receivedUserLine).not.toContain('�');
  });

  it('test_anchor_scan_tail_offset_matches_true_byte_length', () => {
    const { filePath, correctTailOffset } = buildCrossBoundaryFile();
    let userOffset = -1;
    let receivedUserLine = '';
    scanJsonlLines(filePath, (line, offset) => {
      if (line.includes('"role":"user"')) {
        userOffset = offset;
        receivedUserLine = line;
      }
    });

    // Callers compute tailOffset = offset + byteLength(line) + 1. Because the
    // polluted line has a different byte length than the original, this value
    // is inflated by the bug (+6 on this fixture). Pin the exact correct
    // value so the assertion fails on the current implementation.
    const computedTailOffset = userOffset + Buffer.byteLength(receivedUserLine, 'utf-8') + 1;
    expect(computedTailOffset).toBe(correctTailOffset);
  });

  it('test_anchor_read_from_offset_returns_parseable_tail', () => {
    const { filePath, assistantLine } = buildCrossBoundaryFile();

    // Use the scan callback to derive the tail offset, exactly as real
    // callers (claude-sessions / codex-rollout-reader / pi-sessions) do.
    let userOffset = -1;
    let receivedUserLine = '';
    scanJsonlLines(filePath, (line, offset) => {
      if (line.includes('"role":"user"')) {
        userOffset = offset;
        receivedUserLine = line;
      }
    });
    const tailOffset = userOffset + Buffer.byteLength(receivedUserLine, 'utf-8') + 1;

    const tail = readJsonlLinesFromOffset(filePath, tailOffset);
    expect(tail).toHaveLength(1);
    // The tail line must be the complete assistant line and parse cleanly.
    expect(tail[0]).toBe(assistantLine);
    const parsed = JSON.parse(tail[0]);
    expect(parsed.type).toBe('assistant');
    expect(parsed.message.role).toBe('assistant');
  });

  it('test_anchor_read_from_true_offset_parses_assistant_line', () => {
    // Sanity check: when we seek to the *correct* byte offset, the tail read
    // must succeed. This anchors that the fixture itself is well-formed and
    // that the failure in the sibling test is purely the offset-inflation bug,
    // not a broken fixture.
    const { filePath, correctTailOffset, assistantLine } = buildCrossBoundaryFile();

    const tail = readJsonlLinesFromOffset(filePath, correctTailOffset);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toBe(assistantLine);
    expect(JSON.parse(tail[0]).type).toBe('assistant');
  });

  it('test_anchor_readJsonlLinesFromOffset_line_content_not_polluted', () => {
    // `readJsonlLinesFromOffset` shares the same `remainder += chunk.toString
    // ('utf-8')` pattern. When a multi-byte character straddles a chunk
    // boundary inside the tail region, the returned line string must still be
    // the original (unpolluted) content. Build a file where the assistant
    // line itself contains a multi-byte char whose first byte lands on the
    // chunk boundary.
    const filePath = path.join(tmpDir, 'tail-cross.jsonl');
    // First line: exactly 65536 bytes so the second line starts at offset
    // 65536 and its first chunk read begins there.
    const prefix = '{"type":"assistant","message":{"role":"assistant","content":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8');
    // We want `你`'s first byte at absolute offset 65535 + X where X falls on
    // a chunk boundary relative to the seek. Simpler: make the assistant line
    // begin at offset 0 (no leading user line) and place `你` so its first
    // byte is at 65535 — identical to the scan fixture but read via
    // readJsonlLinesFromOffset.
    const N = 65535 - prefixBytes;
    const assistantLine = prefix + 'x'.repeat(N) + '你"}}';
    fs.writeFileSync(filePath, assistantLine + '\n');

    // Reading from offset 0 exercises the same cross-boundary decode path.
    const result = readJsonlLinesFromOffset(filePath, 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(assistantLine);
    expect(result[0]).toContain('你');
    expect(result[0]).not.toContain('�');
  });

  it('test_anchor_readLastNJsonlLines_line_content_not_polluted', () => {
    // `readLastNJsonlLines` shares the same decode pattern. A line that
    // straddles a chunk boundary must be returned with its original multi-byte
    // content intact.
    const filePath = path.join(tmpDir, 'lastn-cross.jsonl');
    const prefix = '{"type":"assistant","message":{"role":"assistant","content":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8');
    const N = 65535 - prefixBytes;
    const assistantLine = prefix + 'x'.repeat(N) + '你"}}';
    fs.writeFileSync(filePath, assistantLine + '\n');

    const result = readLastNJsonlLines(filePath, 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(assistantLine);
    expect(result[0]).toContain('你');
    expect(result[0]).not.toContain('�');
  });

  it('test_anchor_findJsonlLine_line_content_not_polluted', () => {
    // `findJsonlLine` was converted to the same byte-buffer pattern. A matching
    // line that straddles a chunk boundary must be returned with its original
    // multi-byte content intact (not U+FFFD-polluted).
    const filePath = path.join(tmpDir, 'find-cross.jsonl');
    const prefix = '{"type":"user","message":{"role":"user","content":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8');
    const N = 65535 - prefixBytes;
    const userLine = prefix + 'x'.repeat(N) + '你"}}';
    fs.writeFileSync(filePath, userLine + '\n');

    const found = findJsonlLine(filePath, (l) => l.includes('"role":"user"'));
    expect(found).toBe(userLine);
    expect(found).toContain('你');
    expect(found).not.toContain('�');
  });

  it('test_anchor_readLastJsonlLine_line_content_not_polluted', () => {
    // `readLastJsonlLine` was converted to the same byte-buffer pattern. The
    // last line straddling a chunk boundary must be returned intact.
    const filePath = path.join(tmpDir, 'lastline-cross.jsonl');
    const prefix = '{"type":"assistant","message":{"role":"assistant","content":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8');
    const N = 65535 - prefixBytes;
    const assistantLine = prefix + 'x'.repeat(N) + '你"}}';
    fs.writeFileSync(filePath, assistantLine + '\n');

    const last = readLastJsonlLine(filePath);
    expect(last).toBe(assistantLine);
    expect(last).toContain('你');
    expect(last).not.toContain('�');
  });

  it('test_anchor_readJsonlLines_line_content_not_polluted', () => {
    // `readJsonlLines` (full-slurp) was converted to the same byte-buffer
    // pattern. A line straddling the default 64 KiB chunk boundary must be
    // returned intact — independent of the custom chunkSize ASCII test above.
    const filePath = path.join(tmpDir, 'full-cross.jsonl');
    const prefix = '{"type":"user","message":{"role":"user","content":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8');
    const N = 65535 - prefixBytes;
    const userLine = prefix + 'x'.repeat(N) + '你"}}';
    fs.writeFileSync(filePath, userLine + '\n');

    const result = readJsonlLines(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(userLine);
    expect(result[0]).toContain('你');
    expect(result[0]).not.toContain('�');
  });
});
