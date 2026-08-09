/**
 * P2-6 anchor: pi readSessionContent single-pass parsing invariant
 *
 * Before P2-6, pi readSessionContent (src/session/pi/sessions.ts) parsed
 * allLines 4 times:
 *   1. findLastUserIndex — JSON.parse every line
 *   2. event collection — JSON.parse from startIdx to end
 *   3. extractUsage — JSON.parse every line
 *   4. extractDisplayTitle — JSON.parse every line
 *
 * After P2-6, a single first pass must collect usage + lastUserIdx +
 * displayTitle, and a second pass re-parses only the TAIL (events after
 * the last user message) — mirroring claude's P2-2 scalarScan +
 * extractEventsFromTail pattern.
 *
 * This anchor verifies the parse-to-line ratio drops from ~4× to ≤1.5×
 * (when a user message exists; the tail re-parse is short). The skill
 * signature compression (`<skill>…</skill>` → `skill:x`) must survive
 * the merge — covered by a dedicated anchor.
 *
 * Intent:
 *   target: readSessionContent parses each line at most once in its first
 *           pass (plus a short tail re-parse), not 4 full passes.
 *   importance: 4× JSON.parse on multi-MB pi session files makes /resume
 *               synchronously block the event loop several× longer than
 *               necessary; users perceive sluggish /resume responses.
 *   spec_basis: §P2-6 ("pi readSessionContent
 *               4 遍解析 → 单遍聚合，解析 CPU -75%").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiSessionReader } from '../../../src/session/pi/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p26-anchor-'));
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

describe('P2-6 anchor: pi readSessionContent single-pass parsing', () => {
  it('test_anchor_pi_read_session_content_single_pass_ratio', () => {
    const sessionId = 'sess-p26';
    const cwd = '/tmp/proj';

    // Large session exercising all original passes: 40 user/assistant
    // pairs (each assistant carries usage) + a session header. A large
    // file dilutes the fixed overhead of readCwdFromPiJsonl
    // (findJsonlLine stops at the first `session` line), so the parse-to-
    // line ratio converges to the asymptotic single-pass bound. An
    // assistant AFTER the last user keeps the tail non-empty so the
    // second pass is short.
    const lines: unknown[] = [{ type: 'session', id: sessionId, cwd, model: 'glm-5.2' }];
    for (let i = 0; i < 40; i++) {
      lines.push({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `question ${i}` }],
        },
      });
      lines.push({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `answer ${i}` }],
          usage: {
            input: 100 + i,
            output: 10 + i,
            cacheRead: i * 5,
            cacheWrite: i,
            totalTokens: 100 + i + 10 + i + i * 5 + i,
          },
        },
      });
    }
    const sessionPath = writeSessionFile(sessionId, cwd, lines);

    const nonEmptyLines = fs
      .readFileSync(sessionPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;

    const originalParse = JSON.parse;
    let totalParseCount = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      totalParseCount++;
      return originalParse.apply(JSON, args as Parameters<typeof originalParse>);
    });

    try {
      const reader = new PiSessionReader({ piDir: tmpDir });
      const result = reader.readSessionContent(sessionId, cwd);

      // Correctness parity (must not regress):
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events.map((e) => e.content)).toContain('answer 39');
      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(139);
      expect(result.usage?.outputTokens).toBe(49);
      expect(result.usage?.cacheReadTokens).toBe(195);
      expect(result.usage?.cacheCreationTokens).toBe(39);
      expect(result.displayTitle).toBe('question 39');

      // Core invariant: total JSON.parse calls inside readSessionContent
      // must be bounded. Pre-P2-6: ~4× nonEmptyLines (4 full passes).
      // Post-P2-6: nonEmptyLines (single pass) + short tail re-parse +
      // readCwdFromPiJsonl fixed overhead (≈1-2 parses, independent of
      // line count). On an 81-line file the fixed overhead is diluted,
      // so the ratio converges to ~1.0-1.1.
      // 1.5× is generous enough to absorb the fixed overhead yet strict
      // enough to catch the 4× regression (which would be ~324 parses).
      const ratio = totalParseCount / nonEmptyLines;
      expect(totalParseCount).toBeLessThanOrEqual(Math.ceil(nonEmptyLines * 1.5));
      expect(ratio).toBeLessThanOrEqual(1.5);
    } finally {
      spy.mockRestore();
    }
  });
});
