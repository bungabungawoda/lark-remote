/**
 * codex/claude session 内容读取：主线程优先、多主文件取最新、maxEvents、
 * 真实快照 token 口径、claude tail-only 读取。
 *
 * 合并自 codex-main-thread-session / codex-multi-main-thread-newest /
 * codex-session-reader-max-events / codex-real-session-snapshot /
 * claude-read-session-content-tail。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexSessionReader } from '../../../src/session/codex/index.js';
import {
  clearSessionIndexCache,
  listCodexRollouts,
  readCodexSessionContent,
} from '../../../src/session/codex/rollout-reader.js';
import { metaLine, writeRolloutLines } from '../../lib/codex-rollout-fixture.js';
import { encodeClaudeProjectDir } from '../../lib/session-fixtures.js';

const { state } = vi.hoisted(() => ({
  state: {
    scriptedReaddir: new Map<string, string[]>(),
  },
}));

const { jsonlSpy } = vi.hoisted(() => ({
  jsonlSpy: {
    readJsonlLines: vi.fn(),
    readLastJsonlLine: vi.fn(),
    findJsonlLine: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((p: unknown, ...args: unknown[]) => {
      const key = String(p);
      const scripted = state.scriptedReaddir.get(key);
      if (scripted !== undefined) return scripted;
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof actual.readdirSync,
  };
});

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

const SESSION_ID = 'sess-multi';
const T_MAIN_MS = Date.parse('2026-08-01T12:00:00.000Z');
const T_SUB_MS = T_MAIN_MS + 3_600_000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-read-'));
  clearSessionIndexCache();
  jsonlSpy.readJsonlLines.mockClear();
  jsonlSpy.readLastJsonlLine.mockClear();
  jsonlSpy.findJsonlLine.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  state.scriptedReaddir.clear();
});

/** 写一个 claude session jsonl：<projectsDir>/<encoded-cwd>/<sessionId>.jsonl。 */
function writeClaudeSession(
  cwd: string,
  lines: string[],
  sessionId = 'test-session-1234',
): { sessionId: string; filePath: string } {
  const encoded = encodeClaudeProjectDir(cwd);
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":${JSON.stringify(cwd)},"model":"opus"}`;
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, [initLine, ...lines].join('\n') + '\n');
  return { sessionId, filePath };
}

/** 写一个 codex rollout，包含 N 个 user+assistant 消息对（2N 个事件）。 */
function writeRolloutWithMessages(sessionId: string, pairs: number): void {
  const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '15');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const lines: string[] = [metaLine(sessionId, '/tmp/proj', { originator: 'lark-remote' })];
  for (let i = 0; i < pairs; i++) {
    lines.push(
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"user msg ${i}"}]},"timestamp":"2026-07-15T10:00:0${i}.000Z"}`,
    );
    lines.push(
      `{"type":"event_msg","payload":{"type":"user_message","message":"user msg ${i}"},"timestamp":"2026-07-15T10:00:0${i}.000Z"}`,
    );
    lines.push(
      `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"assistant reply ${i}"}]},"timestamp":"2026-07-15T10:00:0${i}.500Z"}`,
    );
  }
  writeRolloutLines(sessionsDir, `rollout-${sessionId}.jsonl`, lines);
}

describe('codex session content read', () => {
  it('test_anchor_codex_read_session_content_prefers_main_thread_file', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const yearDir = path.join(sessionsDir, '2026');
    const monthDir = path.join(yearDir, '08');
    const dayDir = path.join(monthDir, '01');

    // 主线程文件：per-turn last=165/1363/445568/447096；累计 total=244381/256385/107833472/108334238
    writeRolloutLines(
      dayDir,
      'rollout-main-thread.jsonl',
      [
        metaLine(SESSION_ID, '/proj', {
          id: SESSION_ID,
          thread_source: 'user',
          originator: 'codex_exec',
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'main session message' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'main assistant reply' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 445733,
                cached_input_tokens: 445568,
                output_tokens: 1363,
                total_tokens: 447096,
              },
              total_token_usage: {
                input_tokens: 108077853,
                cached_input_tokens: 107833472,
                output_tokens: 256385,
                total_tokens: 108334238,
              },
            },
          },
        }),
      ],
      T_MAIN_MS,
    );

    // subagent 线程文件：同一 session_id，thread_source='subagent'，mtime 更新。
    writeRolloutLines(
      dayDir,
      'rollout-subagent-thread.jsonl',
      [
        metaLine(SESSION_ID, '/proj', {
          id: 'thread-sub-1',
          parent_thread_id: SESSION_ID,
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { depth: 1 } } },
          originator: 'codex_exec',
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'subagent thread message' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'subagent assistant reply' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 55469,
                cached_input_tokens: 55424,
                output_tokens: 95,
                total_tokens: 55564,
              },
              total_token_usage: {
                input_tokens: 856554,
                cached_input_tokens: 816640,
                output_tokens: 6838,
                total_tokens: 863392,
              },
            },
          },
        }),
      ],
      T_SUB_MS,
    );

    // 脚本化遍历顺序：主线程先、subagent 后。
    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(yearDir, ['08']);
    state.scriptedReaddir.set(monthDir, ['01']);
    state.scriptedReaddir.set(dayDir, [
      'rollout-main-thread.jsonl',
      'rollout-subagent-thread.jsonl',
    ]);

    const content = readCodexSessionContent(SESSION_ID, { codexHome: tmpDir });
    const usage = content.usage;

    // 内容来自主线程文件
    expect(content.displayTitle).toBe('main session message');
    expect(content.events.some((e) => e.content === 'main assistant reply')).toBe(true);
    expect(content.events.some((e) => e.content === 'subagent assistant reply')).toBe(false);

    // per-turn（last_token_usage 推导）来自主文件
    expect(usage?.inputTokens).toBe(165); // 445733 - 445568
    expect(usage?.outputTokens).toBe(1363);
    expect(usage?.cacheReadTokens).toBe(445568);
    expect(usage?.totalTokens).toBe(447096);
    expect(usage?.contextLength).toBe(445733);

    // 累计（total_token_usage 推导）来自主文件
    expect(usage?.cumulativeInputTokens).toBe(244381); // 108077853 - 107833472
    expect(usage?.cumulativeOutputTokens).toBe(256385);
    expect(usage?.cumulativeCacheReadTokens).toBe(107833472);
    expect(usage?.cumulativeTotalTokens).toBe(108334238);
  });

  it('test_anchor_codex_multi_main_thread_newest_mtime_wins', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const yearDir = path.join(sessionsDir, '2026');
    const monthDir = path.join(yearDir, '08');
    const dayDir = path.join(monthDir, '01');
    const T_OLD_MS = Date.parse('2026-08-01T10:00:00.000Z');
    const T_NEW_MS = Date.parse('2026-08-01T13:00:00.000Z');

    const writeMain = (fileName: string, title: string, mtimeMs: number) =>
      writeRolloutLines(
        dayDir,
        fileName,
        [
          metaLine(SESSION_ID, '/proj', {
            id: SESSION_ID,
            thread_source: 'user',
            originator: 'codex_exec',
          }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: title } }),
        ],
        mtimeMs,
      );
    // 新主文件遍历在前、旧主文件遍历在后（后写覆盖会让旧文件取胜）。
    writeMain('rollout-new.jsonl', 'newer main title', T_NEW_MS);
    writeMain('rollout-old.jsonl', 'older main title', T_OLD_MS);

    state.scriptedReaddir.set(sessionsDir, ['2026']);
    state.scriptedReaddir.set(yearDir, ['08']);
    state.scriptedReaddir.set(monthDir, ['01']);
    state.scriptedReaddir.set(dayDir, ['rollout-new.jsonl', 'rollout-old.jsonl']);

    const content = readCodexSessionContent(SESSION_ID, { codexHome: tmpDir });
    expect(content.displayTitle).toBe('newer main title');
  });

  // ── maxEvents ──────────────────────────────────────────────────────
  it('test_anchor_readCodexSessionContent_honors_maxEvents', () => {
    const sessionId = '019f-maxevents-direct';
    writeRolloutWithMessages(sessionId, 5); // 10 events

    const content = readCodexSessionContent(sessionId, { codexHome: tmpDir, maxEvents: 3 });
    expect(content.events.length).toBeLessThanOrEqual(3);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_readCodexSessionContent_without_maxEvents_returns_all', () => {
    const sessionId = '019f-maxevents-no-limit';
    writeRolloutWithMessages(sessionId, 4);

    const content = readCodexSessionContent(sessionId, { codexHome: tmpDir });
    expect(content.events.length).toBe(8);
  });

  it('test_anchor_codex_session_reader_forwards_maxEvents', () => {
    const sessionId = '019f-maxevents-reader';
    writeRolloutWithMessages(sessionId, 6); // 12 events

    const reader = new CodexSessionReader({ codexHome: tmpDir });
    const content = reader.readSessionContent(sessionId, '/tmp/proj', { maxEvents: 4 });
    expect(content.events.length).toBeLessThanOrEqual(4);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_codex_session_reader_without_opts_returns_all', () => {
    const sessionId = '019f-maxevents-reader-nolimit';
    writeRolloutWithMessages(sessionId, 3); // 6 events

    const reader = new CodexSessionReader({ codexHome: tmpDir });
    const content = reader.readSessionContent(sessionId, '/tmp/proj');
    expect(content.events.length).toBe(6);
  });

  // ── 真实快照 ───────────────────────────────────────────────────────
  it('test_anchor_codex_real_session_read_resolves_main_thread_file', () => {
    const FIXTURE_ROOT = path.resolve(process.cwd(), 'tests', 'fixtures', 'codex-token-scope');
    const MAIN_SID = 'aaaaaaaa-1111-2222-3333-444444444444';
    const content = readCodexSessionContent(MAIN_SID, { codexHome: FIXTURE_ROOT });
    const u = content.usage;

    expect(u?.inputTokens).toBe(238);
    expect(u?.outputTokens).toBe(660);
    expect(u?.cacheReadTokens).toBe(470912);
    expect(u?.totalTokens).toBe(471810);
    expect(u?.contextLength).toBe(471150);

    expect(u?.cumulativeInputTokens).toBe(571972);
    expect(u?.cumulativeOutputTokens).toBe(274449);
    expect(u?.cumulativeCacheReadTokens).toBe(119504896);
    expect(u?.cumulativeTotalTokens).toBe(120351317);

    expect(content.displayTitle).toBeTruthy();
  });

  it('test_anchor_codex_real_session_list_dedupes_to_main_thread', () => {
    const FIXTURE_ROOT = path.resolve(process.cwd(), 'tests', 'fixtures', 'codex-token-scope');
    const MAIN_SID = 'aaaaaaaa-1111-2222-3333-444444444444';
    const MAIN_CWD = '/home/user/project';
    const result = listCodexRollouts({ codexHome: FIXTURE_ROOT, cwd: MAIN_CWD, limit: 50 });

    const matches = result.entries.filter((e) => e.threadId === MAIN_SID);
    expect(matches).toHaveLength(1);
  });

  // ── claude tail-only 读取 ──────────────────────────────────────────
  it('test_anchor_p2_5_claude_read_session_content_no_full_slurp', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q${i}"}]}}`,
      );
      lines.push(
        `{"type":"assistant","message":{"id":"m${i}","role":"assistant","content":[{"type":"text","text":"a${i}"}],"usage":{"input_tokens":${100 + i},"output_tokens":${10 + i}}}}`,
      );
    }
    const { sessionId, filePath } = writeClaudeSession('/tmp/proj', lines);

    const nonEmpty = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    expect(nonEmpty).toBe(101);

    jsonlSpy.readJsonlLines.mockClear();
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.map((e) => e.content)).toContain('a49');

    // catch-up 路径不得整文件 slurp（tail-only）。
    const slurpCalls = jsonlSpy.readJsonlLines.mock.calls.filter((call) => call[0] === filePath);
    expect(slurpCalls).toHaveLength(0);
  });

  it('test_anchor_p2_5_claude_read_session_content_parity', () => {
    const { sessionId } = writeClaudeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":5000}}',
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"Summary of prior"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"ai-title","aiTitle":"Test Title"}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":5000,"output_tokens":50,"cache_read_input_tokens":800,"cache_creation_input_tokens":100}}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });

    expect(result.events.map((e) => e.content)).toContain('a2');
    expect(result.events.map((e) => e.content)).not.toContain('a1');

    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(5000);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.cacheReadTokens).toBe(800);
    expect(result.usage?.cacheCreationTokens).toBe(100);
    expect(result.usage?.compactCount).toBe(1);
    expect(result.usage?.contextLength).toBe(5900);
    expect(result.usage?.totalTokens).toBe(5000 + 50 + 800 + 100);
    expect(result.usage?.cumulativeInputTokens).toBe(5100);
    expect(result.usage?.cumulativeOutputTokens).toBe(70);
    expect(result.usage?.cumulativeCacheReadTokens).toBe(800);
    expect(result.usage?.cumulativeCacheCreationTokens).toBe(100);

    expect(result.aiTitle).toBe('Test Title');
    expect(result.displayTitle).toBe('Test Title');
    expect(result.recap).toBe('Summary of prior');
  });
});
