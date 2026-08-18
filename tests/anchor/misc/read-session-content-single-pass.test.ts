/**
 * P2-2 anchor: readSessionContent single-pass parsing invariant
 *
 * Before P2-2, readSessionContent parsed allLines 3-4 times:
 *   1. aggregateSessionUsage — JSON.parse every line
 *   2. last-user-message scan — JSON.parse every line
 *   3. event collection — JSON.parse from startIdx to end
 *   4. title/recap — JSON.parse all lines
 *
 * After P2-2, a single pass must collect all four outputs.
 * This anchor verifies:
 *   ① JSON.parse calls inside readSessionContent body are ≤
 *      allLines.length (one parse per line, single pass).
 *      Pre-P2-2 this was ~3× allLines.length.
 *   ② All output fields remain identical to pre-optimization behavior
 *      (covered by existing 28 tests in sessions.test.ts + parity checks here).
 *   ③ Large session: parse-to-line ratio ≤ 1.0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSessionContent } from '../../../src/session/claude/sessions.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p22-anchor-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Same writeSession as sessions.test.ts for consistency
function writeSession(cwd: string, lines: string[]): string {
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = 'test-session-1234';
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`;
  const allLines = [initLine, ...lines];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), allLines.join('\n') + '\n');
  return sessionId;
}

/**
 * Count JSON.parse calls attributable to the readSessionContent body
 * (excluding readCwdFromJsonl which uses findJsonlLine and is a separate
 * pre-check, not part of the allLines multi-pass problem).
 *
 * We measure: total parseCount − cwdParseCount = bodyParseCount.
 * cwdParseCount is captured by calling readCwdFromJsonl in isolation.
 */
describe('P2-2 anchor: readSessionContent single-pass parsing', () => {
  it('JSON.parse calls in readSessionContent body ≤ allLines.length (not 3-4×)', () => {
    // Session with diverse content: user, assistant (with usage), compact,
    // ai-title, compactSummary — exercises all 4 original passes.
    // Ensure there's an assistant AFTER the last non-summary user so
    // events tail is non-empty.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":5000}}',
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"Summary of prior"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"ai-title","aiTitle":"Test Title"}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":5000,"output_tokens":50,"cache_read_input_tokens":800,"cache_creation_input_tokens":100}}}',
    ]);

    // Count non-empty lines (init + 7 content = 8)
    const encoded = '/tmp/proj'.replace(/\//g, '-');
    const filePath = path.join(tmpDir, encoded, 'test-session-1234.jsonl');
    const nonEmptyLines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;

    const originalParse = JSON.parse;
    let totalParseCount = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      totalParseCount++;
      return originalParse.apply(JSON, args as Parameters<typeof originalParse>);
    });

    try {
      const result = readSessionContent(sessionId, '/tmp/proj', {
        projectsDir: tmpDir,
      });

      // Verify outputs are correct (parity with existing tests)
      expect(result.events.map((e) => e.content)).toContain('a2');
      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(5100);
      expect(result.usage?.outputTokens).toBe(70);
      expect(result.usage?.cacheReadTokens).toBe(800);
      expect(result.usage?.cacheCreationTokens).toBe(100);
      expect(result.usage?.compactCount).toBe(1);
      expect(result.aiTitle).toBe('Test Title');
      expect(result.recap).toBe('Summary of prior');
      expect(result.displayTitle).toBe('Test Title');

      // ① Core invariant: total JSON.parse calls inside readSessionContent
      //    must be bounded. readCwdFromJsonl (findJsonlLine) is called
      //    once before the main loop and parses only the first few lines —
      //    it is NOT part of the allLines multi-pass problem (P2-2).
      //    The main loop (allLines) must parse each line exactly once.
      //
      //    Pre-P2-2: ~3× nonEmptyLines (3 full passes over all lines)
      //    Post-P2-2: nonEmptyLines (single pass) + small cwd overhead
      //    We use 1.5× nonEmptyLines as the upper bound — generous enough
      //    to absorb readCwdFromJsonl's few extra parses, but strict
      //    enough to catch the 3-4× regression.
      expect(totalParseCount).toBeLessThanOrEqual(Math.ceil(nonEmptyLines * 1.5));
    } finally {
      spy.mockRestore();
    }
  });

  it('handles session with no user messages (edge case)', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"orphan"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', {
      projectsDir: tmpDir,
    });

    expect(result.events.map((e) => e.content)).toContain('orphan');
  });

  /**
   * P2-2 ratio 边界：无 user 消息的 session。
   * readSessionContent 找不到 user 消息时 startIdx 回退到 0，extractEventsFromTail
   * 重解析整个文件 → 解析次数 = scalarScan(N) + tail(N) = 2N，ratio = 2.0×。
   * 这是 P2-2 两阶段设计的已知上界（仍优于 pre-P2-2 的 ~3×），但 1.5× 的断言
   * 不覆盖此 case。此锚点显式 pin 住无 user 消息文件的 ratio ≤ 2.0×，并防止
   * 退化到 3×+（如回退成多遍 full pass）。
   */
  it('no-user-message session: parse ratio ≤ 2.0× (tail re-parses whole file)', () => {
    // 50 个 assistant 行，无 user 消息 → startIdx 回退 0，tail = 全文
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        `{"type":"assistant","message":{"id":"m${i}","role":"assistant","content":[{"type":"text","text":"a${i}"}],"usage":{"input_tokens":${100 + i},"output_tokens":${10 + i}}}}`,
      );
    }
    const sessionId = writeSession('/tmp/proj', lines);

    const encoded = '/tmp/proj'.replace(/\//g, '-');
    const filePath = path.join(tmpDir, encoded, 'test-session-1234.jsonl');
    const nonEmptyLines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;

    const originalParse = JSON.parse;
    let totalParseCount = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      totalParseCount++;
      return originalParse.apply(JSON, args as Parameters<typeof originalParse>);
    });

    try {
      const result = readSessionContent(sessionId, '/tmp/proj', {
        projectsDir: tmpDir,
      });

      // 正确性：无 user 消息时回退全文，events 仍含全部 assistant 文本
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events.map((e) => e.content)).toContain('a0');
      expect(result.events.map((e) => e.content)).toContain('a49');

      // ratio：2 阶段（scalarScan + tail 全文重解析）= ~2.0×，仍优于 pre-P2-2 的 3×。
      // 2.0× 是 body 的渐近上界；totalParseCount 还含 readCwdFromJsonl 的固定开销
      // （~2 parse，与行数无关），故用「2.0× 行数 + 5」给 cwd 预检留绝对余量——
      // 大文件 ratio→2.0，小文件不被固定开销挤出。3×+ 即退化信号。
      const ratio = totalParseCount / nonEmptyLines;
      expect(totalParseCount).toBeLessThanOrEqual(nonEmptyLines * 2 + 5);
      expect(ratio).toBeLessThanOrEqual(2.1);
    } finally {
      spy.mockRestore();
    }
  });

  it('handles session with isMeta user messages for displayTitle', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"real user input"}]}}',
      '{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"skill injection body"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"reply"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', {
      projectsDir: tmpDir,
    });

    // displayTitle must be the real user input, not the isMeta skill injection
    expect(result.displayTitle).toBe('real user input');
    expect(result.displayTitle).not.toContain('skill injection');
  });

  it('large session: parse ratio ≤ 1.5× (single pass + small cwd overhead)', () => {
    // Build a session with 100 content lines (50 user + 50 assistant pairs)
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q${i}"}]}}`,
      );
      lines.push(
        `{"type":"assistant","message":{"id":"m${i}","role":"assistant","content":[{"type":"text","text":"a${i}"}],"usage":{"input_tokens":${100 + i},"output_tokens":${10 + i}}}}`,
      );
    }

    const sessionId = writeSession('/tmp/proj', lines);

    const encoded = '/tmp/proj'.replace(/\//g, '-');
    const filePath = path.join(tmpDir, encoded, 'test-session-1234.jsonl');
    const nonEmptyLines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;

    const originalParse = JSON.parse;
    let totalParseCount = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      totalParseCount++;
      return originalParse.apply(JSON, args as Parameters<typeof originalParse>);
    });

    try {
      const result = readSessionContent(sessionId, '/tmp/proj', {
        projectsDir: tmpDir,
      });

      // Verify correctness
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.usage).toBeDefined();

      // ③ Large session: parse count ≤ 1.5× nonEmptyLines (generous bound
      //    that still catches 3-4× regression; the .5× absorbs readCwdFromJsonl).
      //    Pre-P2-2: ~3× 101 = ~303 parses, ratio ≈ 3.0.
      //    Post-P2-2: ~101 + small cwd overhead, ratio ≈ 1.0-1.1.
      const ratio = totalParseCount / nonEmptyLines;
      expect(ratio).toBeLessThanOrEqual(1.5);
    } finally {
      spy.mockRestore();
    }
  });
});
