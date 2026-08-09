/**
 * P2-5 anchor: pi readSessionContent tail-only read invariant
 *
 * Before P2-5, pi readSessionContent (src/session/pi/sessions.ts) called
 * `readJsonlLines(filePath)` which slurps the ENTIRE multi-MB session jsonl
 * into a `string[]`. P2-6 already cut parsed-object memory to O(tail)
 * (piScalarScan + extractPiEventsFromTail), but the raw `string[]` of
 * whole-file line strings is still fully materialized — that is the
 * remaining catch-up-path materialization cost P2-5 targets.
 *
 * After P2-5, pi readSessionContent's catch-up path uses `readJsonlLinesFromOffset`
 * (byte-offset two-pass: piScalarScan via streaming scan recording the byte
 * offset of the last user message, then read+parse only the tail from that
 * offset). This keeps raw line-string memory O(tail) instead of O(whole file).
 *
 * This anchor has two cases:
 * 1. Anti-degradation: on a pi session with 40 user/assistant pairs,
 *    readSessionContent must not invoke the shared full-slurp `readJsonlLines`
 *    on the session file at all.
 * 2. Parity: on a fixture covering events (tail assistant text after last user),
 *    usage (last-turn input/output/cacheRead/cacheCreation), displayTitle,
 *    all output fields must equal the expected values.
 *
 * Intent:
 *   target: readSessionContent reads only the tail of the jsonl for the
 *           catch-up events path, so the full-slurp `readJsonlLines` is
 *           never called on the session file.
 *   importance: /resume and auto-resume call readSessionContent on every
 *               pi session; full materialization of a multi-MB jsonl
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

// Import AFTER mocks are in place so pi sessions.ts picks up the spied
// shared readJsonlLines.
const { PiSessionReader } = await import('../../../src/session/pi/index.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p25-pi-anchor-'));
  jsonlSpy.readJsonlLines.mockClear();
  jsonlSpy.readLastJsonlLine.mockClear();
  jsonlSpy.findJsonlLine.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Encode cwd to pi's directory name format: --<cwd-with-/->- */
function encodeCwd(cwd: string): string {
  const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
  return `--${encodedCwd}--`;
}

/** Write a session jsonl into the correct encoded directory. Returns file path. */
function writeSessionFile(sessionId: string, cwd: string, lines: unknown[]): string {
  const sessionsDir = path.join(tmpDir, 'sessions');
  const dir = path.join(sessionsDir, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${timestamp}_${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filePath;
}

describe('P2-5 anchor: pi readSessionContent tail-only read', () => {
  it('test_anchor_p2_5_pi_read_session_content_no_full_slurp', () => {
    const sessionId = 'sess-p25-pi';
    const cwd = '/tmp/proj';

    // 40 user/assistant pairs (80 content lines) + a session header.
    // scalarScan must scan the whole file to find lastUserIdx (the last
    // user before the final assistant) — this is exactly the tension point
    // where a tail-only rewrite needs a byte-offset two-pass strategy
    // rather than a full string[] materialize.
    const lines: unknown[] = [{ type: 'session', id: sessionId, cwd, model: 'glm-5.2' }];
    for (let i = 0; i < 40; i++) {
      lines.push({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: `q${i}` }] },
      });
      lines.push({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `a${i}` }],
          usage: {
            input: 100 + i,
            output: 10 + i,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 100 + i + 10 + i,
          },
        },
      });
    }
    const sessionPath = writeSessionFile(sessionId, cwd, lines);

    // Sanity: the file has 81 non-empty lines (header + 80 content).
    const nonEmpty = fs
      .readFileSync(sessionPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    expect(nonEmpty).toBe(81);

    jsonlSpy.readJsonlLines.mockClear();

    const reader = new PiSessionReader({ piDir: tmpDir });
    const result = reader.readSessionContent(sessionId, cwd);

    // The return value is sanity-checked (events present) but the core
    // invariant is the slurp assertion below.
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.map((e) => e.content)).toContain('a39');

    // Core invariant: the full-slurp shared readJsonlLines must NOT be
    // called on the (potentially multi-MB) session jsonl by
    // readSessionContent's catch-up path. A tail-only strategy reads just
    // the tail via readJsonlLinesFromOffset.
    //
    // We scope the assertion to sessionPath: readCwdFromPiJsonl uses
    // findJsonlLine (early-stop, NOT readJsonlLines) for the cwd pre-check,
    // so cwd verification does not trigger this spy — that is the desired
    // boundary, the anti-degradation net targets only the full slurp.
    const slurpCalls = jsonlSpy.readJsonlLines.mock.calls.filter((call) => call[0] === sessionPath);
    expect(slurpCalls).toHaveLength(0);
  });

  it('test_anchor_p2_5_pi_read_session_content_parity', () => {
    const sessionId = 'sess-p25-pi-parity';
    const cwd = '/tmp/proj';

    // Fixture covering every output field of readSessionContent:
    //   - header session event (cwd verification)
    //   - early user/assistant pair (must NOT appear in events tail)
    //   - last user message (displayTitle = "last question")
    //   - final assistant with usage (events tail "final answer"; usage is
    //     LAST-turn semantics in pi: input/output/cacheRead/cacheCreation
    //     come from the last assistant's usage only)
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'early question' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'early answer' }],
          usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 },
        },
      },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'last question' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          usage: { input: 500, output: 50, cacheRead: 80, cacheWrite: 100, totalTokens: 730 },
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const result = reader.readSessionContent(sessionId, cwd);

    // events: tail after last user → the final assistant text "final answer".
    expect(result.events.map((e) => e.content)).toContain('final answer');
    expect(result.events.map((e) => e.content)).not.toContain('early answer');

    // usage: pi "last turn" semantics — last assistant's values only.
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(500);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.cacheReadTokens).toBe(80);
    expect(result.usage?.cacheCreationTokens).toBe(100);
    expect(result.usage?.totalTokens).toBe(730);

    // displayTitle = last user message (skill-compressed, truncated to 200)
    expect(result.displayTitle).toBe('last question');
  });
});
