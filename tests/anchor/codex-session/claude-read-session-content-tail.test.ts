/**
 * P2-5 anchor: claude readSessionContent tail-only read invariant
 *
 * Before P2-5, claude readSessionContent (src/session/claude/sessions.ts)
 * calls `readJsonlLines(filePath)` (line 479) which slurps the ENTIRE
 * multi-MB jsonl into a `string[]`. The catch-up path (events after the
 * last user message) only needs the tail, and scalarScan already parses
 * each line once without retaining parsed objects (P2-2), but the raw
 * `string[]` of whole-file line strings is still fully materialized —
 * that is the remaining catch-up-path materialization cost P2-5 targets.
 *
 * After P2-5, readSessionContent's catch-up path must NOT call the full-
 * slurp `readJsonlLines` from the shared jsonl module. A tail-only
 * strategy (e.g. byte-offset two-pass: scalarScan via streaming scan
 * recording the byte offset of the last user message, then read+parse
 * only the tail from that offset) keeps raw line-string memory O(tail)
 * instead of O(whole file).
 *
 * This anchor has two cases:
 * 1. Anti-degradation (true red): on a 100+ line claude session jsonl
 *    (50 user/assistant pairs ending with an assistant), readSessionContent
 *    must not invoke the shared full-slurp `readJsonlLines` at all.
 *    Current implementation calls it at line 479 → red.
 * 2. Parity (pin, currently green): on a fixture covering events (tail
 *    assistant text), usage (input/output/cacheRead/cacheCreation/
 *    compactCount/contextLength), aiTitle, recap, displayTitle, all
 *    output fields must equal the pre-rewrite values. This pins behavior
 *    so the tail-only rewrite does not change observable output.
 *
 * Intent:
 *   target: readSessionContent reads only the tail of the jsonl for the
 *           catch-up events path, so the full-slurp `readJsonlLines` is
 *           never called on the session file.
 *   importance: /resume and auto-resume call readSessionContent on every
 *               claude session; full materialization of a 10MB+ jsonl
 *               synchronously blocks the event loop for a catch-up that
 *               only needs the lines after the last user message.
 *   spec_basis: §P2-5 ("tail-only 读取").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger, jsonlSpy } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  jsonlSpy: {
    readJsonlLines: vi.fn(),
    readLastJsonlLine: vi.fn(),
    findJsonlLine: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// Spy the shared jsonl module. Real implementations are delegated via
// importOriginal so parity still works; call counts are tracked so the
// anti-degradation case can assert readJsonlLines is never called on the
// session file.
vi.mock('../../../src/session/common/jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/session/common/jsonl.js')>();
  jsonlSpy.readJsonlLines.mockImplementation(actual.readJsonlLines);
  jsonlSpy.readLastJsonlLine.mockImplementation(actual.readLastJsonlLine);
  jsonlSpy.findJsonlLine.mockImplementation(actual.findJsonlLine);
  return {
    ...actual,
    readJsonlLines: jsonlSpy.readJsonlLines,
    readLastJsonlLine: jsonlSpy.readLastJsonlLine,
    findJsonlLine: jsonlSpy.findJsonlLine,
  };
});

// Import AFTER mocks are in place so claude sessions.ts picks up the spied
// shared readJsonlLines.
const { readSessionContent } = await import('../../../src/session/claude/sessions.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p25-claude-anchor-'));
  jsonlSpy.readJsonlLines.mockClear();
  jsonlSpy.readLastJsonlLine.mockClear();
  jsonlSpy.findJsonlLine.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a claude session directory under tmpDir and write a jsonl with the
 * given content lines. Returns { sessionId, filePath }.
 *
 * Layout mirrors src/session/claude/sessions.ts: <projectsDir>/<encoded-cwd>/
 * <sessionId>.jsonl. The init line carries the `cwd` field that
 * readCwdFromJsonl verifies (fileCwd === cwd).
 */
function writeSession(
  cwd: string,
  lines: string[],
  sessionId = 'test-session-1234',
): { sessionId: string; filePath: string } {
  const encoded = cwd.replace(/\//g, '-').replace(/_/g, '-');
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`;
  const allLines = [initLine, ...lines];
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, allLines.join('\n') + '\n');
  return { sessionId, filePath };
}

describe('P2-5 anchor: claude readSessionContent tail-only read', () => {
  it('test_anchor_p2_5_claude_read_session_content_no_full_slurp', () => {
    // 50 user/assistant pairs (100 content lines) ending with an assistant
    // carrying usage. scalarScan must scan the whole file to find
    // lastUserIdx (the 100th line, the last user before the final assistant)
    // — this is exactly the tension point where a tail-only rewrite needs a
    // byte-offset two-pass strategy rather than a full string[] materialize.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q${i}"}]}}`,
      );
      lines.push(
        `{"type":"assistant","message":{"id":"m${i}","role":"assistant","content":[{"type":"text","text":"a${i}"}],"usage":{"input_tokens":${100 + i},"output_tokens":${10 + i}}}}`,
      );
    }
    const { sessionId, filePath } = writeSession('/tmp/proj', lines);

    // Sanity: the file has 101 non-empty lines (init + 100 content).
    const nonEmpty = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    expect(nonEmpty).toBe(101);

    jsonlSpy.readJsonlLines.mockClear();

    const result = readSessionContent(sessionId, '/tmp/proj', {
      projectsDir: tmpDir,
    });

    // The return value is sanity-checked (events present) but the core
    // invariant is the slurp assertion below.
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.map((e) => e.content)).toContain('a49');

    // Core invariant: the full-slurp shared readJsonlLines must NOT be
    // called on the (potentially multi-MB) session jsonl by
    // readSessionContent's catch-up path. A tail-only strategy reads just
    // the tail. The current implementation calls readJsonlLines(filePath)
    // at line 479 → red.
    //
    // We scope the assertion to filePath: readCwdFromJsonl uses
    // findJsonlLine (early-stop, NOT readJsonlLines) for the cwd pre-check,
    // so cwd verification does not trigger this spy — that is the desired
    // boundary, the anti-degradation net targets only the full slurp.
    const slurpCalls = jsonlSpy.readJsonlLines.mock.calls.filter((call) => call[0] === filePath);
    expect(slurpCalls).toHaveLength(0);
  });

  it('test_anchor_p2_5_claude_read_session_content_parity', () => {
    // Fixture covering every output field of readSessionContent:
    //   - user / assistant with usage (input/output/cacheRead/cacheCreation)
    //   - compact_boundary (compactCount + contextLength via postTokens)
    //   - isCompactSummary user (recap)
    //   - ai-title (displayTitle + aiTitle)
    //   - a final assistant after the last real user (events tail content)
    const { sessionId } = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":5000}}',
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"Summary of prior"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"ai-title","aiTitle":"Test Title"}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":5000,"output_tokens":50,"cache_read_input_tokens":800,"cache_creation_input_tokens":100}}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', {
      projectsDir: tmpDir,
    });

    // events: tail after last user (q2) → the final assistant text "a2".
    expect(result.events.map((e) => e.content)).toContain('a2');
    expect(result.events.map((e) => e.content)).not.toContain('a1');

    // 非累计字段 = 末轮（本 run）scope（对齐 codex `last_token_usage` 语义）；
    // 累计字段 = session 总和。修复前非累计字段也塞 session 累计（混 scope）。
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(5000); // 末轮 m2
    expect(result.usage?.outputTokens).toBe(50); // 末轮 m2
    expect(result.usage?.cacheReadTokens).toBe(800); // 末轮 m2
    expect(result.usage?.cacheCreationTokens).toBe(100); // 末轮 m2
    expect(result.usage?.compactCount).toBe(1);
    // contextLength = max(lastPostTokens=5000, last assistant 窗口占用).
    // lastWindow uses acc.last (the last assistant's per-message usage:
    // 5000+800+100 = 5900, excludes output — review P2-8), NOT the cumulative total.
    expect(result.usage?.contextLength).toBe(5900);
    expect(result.usage?.totalTokens).toBe(5000 + 50 + 800 + 100); // 末轮分项和
    // session 累计（所有 run 之和）
    expect(result.usage?.cumulativeInputTokens).toBe(5100); // 100 + 5000
    expect(result.usage?.cumulativeOutputTokens).toBe(70); // 20 + 50
    expect(result.usage?.cumulativeCacheReadTokens).toBe(800); // 0 + 800
    expect(result.usage?.cumulativeCacheCreationTokens).toBe(100); // 0 + 100

    // aiTitle + displayTitle
    expect(result.aiTitle).toBe('Test Title');
    expect(result.displayTitle).toBe('Test Title');

    // recap from isCompactSummary user
    expect(result.recap).toBe('Summary of prior');
  });
});
