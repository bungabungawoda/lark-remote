import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeSessionReader } from '../../session/opencode/sessions.js';
import { currentPlatform } from '../../platform/select.js';
import { STALE_MS } from '../common/constants.js';
import { rmRf } from '../../../tests/lib/tmp-cleanup.js';

// Mock spawnProcessSync（生产代码用 cross-spawn 收口执行 opencode CLI，
// win32 上 execFileSync 无法解析 npm .cmd 垫片）
vi.mock('../../platform/spawn.js', async () => ({
  ...(await vi.importActual('../../platform/spawn.js')),
  spawnProcessSync: vi.fn(),
}));

import { spawnProcessSync } from '../../platform/spawn.js';

// spawnProcessSync 返回 SpawnSyncReturns<string|Buffer>；helper 把 stdout 文本
// 包装成成功结果，替换旧 execFileSync 直返字符串的 mock 形态。
function mockSpawnResult(stdout: string): void {
  vi.mocked(spawnProcessSync).mockReturnValue({
    status: 0,
    stdout,
    stderr: '',
  } as unknown as ReturnType<typeof spawnProcessSync>);
}
import { TOOL_RESULT_MAX_BYTES, DEFAULT_TRUNCATE_SUFFIX } from '../../common/truncate.js';

// Helper: build a minimal valid opencode export JSON payload.
function buildExportJson(opts: {
  id?: string;
  title?: string;
  directory: string;
  messages?: Array<{
    role: 'user' | 'assistant';
    parts: Array<Record<string, unknown>>;
  }>;
}): string {
  return JSON.stringify({
    info: {
      id: opts.id ?? 'ses_test',
      title: opts.title ?? '',
      directory: opts.directory,
      time: { created: 1, updated: 2 },
    },
    messages: (opts.messages ?? []).map((m, i) => ({
      info: {
        role: m.role,
        id: `m${i}`,
        sessionID: opts.id ?? 'ses_test',
        time: { created: i + 1 },
      },
      parts: m.parts,
    })),
  });
}

// Helper: build a minimal valid v2 `session export` payload. v2 flattens
// messages to `{type,text,content}` and moves cwd under `info.location`.
function buildV2ExportJson(opts: {
  title?: string;
  directory: string;
  messages: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    info: {
      id: 'ses_v2',
      title: opts.title ?? '',
      location: { directory: opts.directory },
      time: { created: 1, updated: 2 },
    },
    messages: opts.messages,
  });
}

describe('OpencodeSessionReader - L1: empty output handling', () => {
  let reader: OpencodeSessionReader;

  beforeEach(() => {
    vi.clearAllMocks();
    reader = new OpencodeSessionReader({ cacheTtlMs: 0 });
  });

  it('handles empty string output from opencode session list gracefully', () => {
    // opencode session list returns empty string (0 bytes) when no sessions exist
    mockSpawnResult('');

    const sessions = reader.listSessions('/tmp/empty-dir');

    expect(sessions).toEqual({ sessions: [], total: 0 });
    // Should NOT throw SyntaxError: Unexpected end of JSON input
    expect(spawnProcessSync).toHaveBeenCalled();
  });

  it('handles whitespace-only output from opencode session list gracefully', () => {
    // Some edge cases might produce whitespace-only output
    mockSpawnResult('   \n  \n  ');

    const sessions = reader.listSessions('/tmp/empty-dir');

    expect(sessions).toEqual({ sessions: [], total: 0 });
  });

  it('parses valid JSON array output normally', () => {
    // Use a real temp dir so realpath resolves consistently. Production receives
    // a realpath from SessionStore (cwd stored as realpath-resolved),
    // and opencode's `directory` field is the same realpath — the filter at
    // listSessions:127 compares e.directory === realpath(cwd). A non-existent
    // path makes realpath fall back to the unresolved form (no symlink rewrite),
    // which then mismatches the fixture's `directory` and the filter drops it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-list-'));
    try {
      const resolvedCwd = fs.realpathSync(tmpDir);
      const validJson = JSON.stringify([
        {
          id: 'ses_123',
          title: 'Test session',
          updated: Date.now(),
          created: Date.now(),
          projectId: 'proj_1',
          directory: resolvedCwd,
        },
      ]);
      mockSpawnResult(validJson);

      const sessions = reader.listSessions(tmpDir);

      expect(sessions.total).toBe(1);
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0].sessionId).toBe('ses_123');
      expect(sessions.sessions[0].summary).toBe('Test session');
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('throws on corrupt JSON (failure distinct from empty)', () => {
    // CLI 返回不可解析输出是真实读取失败，必须上抛让 router 显示
    // 「读取失败」；旧契约静默返回 [] 与「真空」不可区分。
    mockSpawnResult('not valid json{{{');

    expect(() => reader.listSessions('/tmp/test')).toThrow(/读取失败/);
  });

  it('passes cwd to opencode session list command', () => {
    mockSpawnResult('[]');

    reader.listSessions('/home/user/project');

    // 整包选项逐字锁死：maxBuffer 回落到默认 1MiB 会让大会话列表 ENOBUFS → 静默
    // 变成「没有 session」，timeout 与 windowsHide 同理只在出错时才看得见。
    expect(spawnProcessSync).toHaveBeenCalledWith(
      'opencode',
      ['session', 'list', '--format', 'json', '--max-count', '10000', '--standalone'],
      {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
        cwd: '/home/user/project',
        windowsHide: true,
      },
    );
  });

  // Stale-cwd coverage gap (closed): when the persisted cwd no longer exists on
  // disk (dir deleted after /cd), the production reader must NOT throw and must
  // return []. Two real-path failure modes arise from the deleted dir:
  //   ① execFileSync itself throws (Node chdir ENOENT before spawn) — caught at
  //     fetchSessionList's try/catch (sessions.ts:411) → [].
  //   ② The CLI somehow returns a session whose `directory` is the resolved
  //     (realpath) form while realpath(cwd) fell back to the unresolved form —
  //     the filter at sessions.ts:127 correctly drops it → [].
  // Both must end in [] without surfacing an error to the user.

  it('returns [] without throwing when cwd does not exist (execFileSync ENOENT)', () => {
    // Real Node behavior: execFileSync with a non-existent cwd throws ENOENT
    // (chdir fails before spawn). Simulate that so the test does not depend on
    // a real opencode binary being absent/present on the host.
    vi.mocked(spawnProcessSync).mockReturnValue({
      status: null,
      error: Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }),
    } as unknown as ReturnType<typeof spawnProcessSync>);

    const sessions = reader.listSessions('/tmp/opencode-stale-enoent');

    expect(sessions).toEqual({ sessions: [], total: 0 });
  });

  it('returns [] when realpath falls back but CLI returns a resolved-directory session', () => {
    // cwd does not exist → realpath(cwd) falls back to the unresolved form,
    // but opencode returns a session whose `directory` is a different path.
    // The filter at sessions.ts:129 must drop it rather than leak a session
    // that does not belong to this cwd.
    //
    // On macOS /tmp resolves to /private/tmp, providing a natural mismatch.
    // On Linux /tmp resolves to /tmp, so we use two clearly different
    // non-existent paths to make the test platform-independent.
    const staleCwd = '/tmp/opencode-stale-unresolved';
    const differentDirectory = '/tmp/opencode-stale-resolved';
    const validJson = JSON.stringify([
      {
        id: 'ses_stray',
        title: 'stray session',
        updated: Date.now(),
        created: Date.now(),
        projectId: 'proj_1',
        directory: differentDirectory,
      },
    ]);
    mockSpawnResult(validJson);

    const sessions = reader.listSessions(staleCwd);

    expect(sessions).toEqual({ sessions: [], total: 0 });
    // Ensure the filter (not the CLI throw) is what excluded it: CLI was called
    // and returned data, yet no session survived the directory match.
    expect(spawnProcessSync).toHaveBeenCalled();
  });
});

describe('OpencodeSessionReader - L1/L2/L3: large/corrupt export handling', () => {
  const cwd = '/synth/opencode-export-test'; // non-existent -> realpath falls back to itself

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // readSessionContent must use the captureExport seam and parse large
  // exports correctly. The injected seam returns the full payload.
  it('L1: parses a huge export and returns events + aiTitle (not not_found)', () => {
    const bigOutput = 'x'.repeat(2_000_000); // 2MB tool_result
    const raw = buildExportJson({
      id: 'ses_big',
      title: 'big session',
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool',
              callID: 'c1',
              tool: 'Bash',
              state: { status: 'completed', input: { command: 'ls' }, output: bigOutput },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => raw,
    });
    const content = r.readSessionContent('ses_big', cwd);
    expect(content.aiTitle).toBe('big session');
    expect(content.events.length).toBeGreaterThan(0);
  });

  // transport: the DEFAULT captureExport must route stdout to a file fd
  // (not 'pipe'), which bypasses opencode's pipe truncation for large output.
  it('L1: default captureExport routes stdout to a file fd (not a pipe)', () => {
    mockSpawnResult('');
    const r = new OpencodeSessionReader({ cacheTtlMs: 0 });
    // execFileSync is mocked (writes nothing), so the temp file is empty -> ''.
    const out = r.captureExport('ses_tr');
    expect(out).toBe('');
    expect(spawnProcessSync).toHaveBeenCalledWith(
      'opencode',
      ['session', 'export', '--standalone', 'ses_tr'],
      // stdout 走文件 fd，stderr 仍是 pipe，所以 maxBuffer 也要拉起；
      // opencode 是 npm .cmd 垫片，windowsHide 关掉会闪控制台。
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }),
    );
    const opts = vi.mocked(spawnProcessSync).mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(opts).sort()).toEqual(
      ['encoding', 'maxBuffer', 'stdio', 'timeout', 'windowsHide'].sort(),
    );
    expect(Array.isArray(opts.stdio)).toBe(true);
    const stdio = opts.stdio as unknown[];
    expect(stdio[0]).toBe('ignore'); // stdin ignored
    expect(typeof stdio[1]).toBe('number'); // stdout -> file fd (NOT 'pipe')
    expect(stdio[2]).toBe('pipe'); // stderr still captured
  });

  it('L1: falls back to v1 top-level export when session export is unavailable', () => {
    vi.mocked(spawnProcessSync)
      .mockReturnValueOnce({
        status: 1,
        stdout: 'DESCRIPTION\n  OpenCode command line interface\n',
        stderr: '',
      } as unknown as ReturnType<typeof spawnProcessSync>)
      .mockReturnValueOnce({
        status: 1,
        stdout: 'DESCRIPTION\n  OpenCode command line interface\n',
        stderr: '',
      } as unknown as ReturnType<typeof spawnProcessSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
      } as unknown as ReturnType<typeof spawnProcessSync>);

    const r = new OpencodeSessionReader({ cacheTtlMs: 0 });
    r.captureExport('ses_v1');

    const calls = vi.mocked(spawnProcessSync).mock.calls;
    expect(calls[0]![1]).toEqual(['session', 'export', '--standalone', 'ses_v1']);
    expect(calls[1]![1]).toEqual(['session', 'export', 'ses_v1']);
    expect(calls[2]![1]).toEqual(['export', 'ses_v1']);
  });

  it('L1: does not retry the v1 export command for a missing session', () => {
    vi.mocked(spawnProcessSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Session not found: ses_missing',
    } as unknown as ReturnType<typeof spawnProcessSync>);

    const r = new OpencodeSessionReader({ cacheTtlMs: 0 });
    expect(r.captureExport('ses_missing')).toBe('');

    const calls = vi.mocked(spawnProcessSync).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toEqual(['session', 'export', '--standalone', 'ses_missing']);
    expect(calls[1]![1]).toEqual(['session', 'export', 'ses_missing']);
  });

  it('L1: v2 export maps flat messages, tool results, and message-level tokens', () => {
    const raw = buildV2ExportJson({
      title: 'v2 title',
      directory: cwd,
      messages: [
        { id: 'm0', type: 'system', time: { created: 1 }, text: 'SYSTEM-PROMPT' },
        { id: 'm1', type: 'user', time: { created: 2 }, text: 'hello' },
        {
          id: 'm2',
          type: 'assistant',
          time: { created: 3 },
          agent: 'build',
          content: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'answer' },
          ],
          tokens: {
            input: 10,
            output: 5,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
        },
        { id: 'm3', type: 'user', time: { created: 4 }, text: 'second' },
        {
          id: 'm4',
          type: 'assistant',
          time: { created: 5 },
          agent: 'build',
          content: [
            {
              type: 'tool',
              id: 'call_1',
              name: 'bash',
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                content: [{ type: 'text', text: '/repo' }],
              },
            },
            { type: 'text', text: 'ok' },
          ],
          tokens: {
            input: 20,
            output: 4,
            reasoning: 0,
            cache: { read: 6, write: 2 },
          },
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => raw,
    });

    const content = r.readSessionContent('ses_v2', cwd);

    expect(content.aiTitle).toBe('v2 title');
    expect(content.displayTitle).toBe('second');
    expect(content.events.map((e) => e.type)).toEqual(['text', 'tool_use', 'tool_result', 'text']);
    expect(content.events[0]!.content).toBe('second');
    expect(JSON.parse(content.events[1]!.content)).toEqual({
      id: 'call_1',
      name: 'bash',
      input: { command: 'pwd' },
    });
    expect(content.events[2]!.content).toBe('/repo');
    expect(content.events[3]!.content).toBe('ok');
    expect(content.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      // §9.21: contextLength 含末轮 output（input 20 + output 4 + cacheRead 6 + cacheWrite 2）
      contextLength: 32,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
      totalTokens: 32,
      cumulativeInputTokens: 30,
      cumulativeOutputTokens: 9,
      cumulativeCacheReadTokens: 9,
      cumulativeCacheCreationTokens: 3,
      cumulativeTotalTokens: 53,
    });
  });

  it('L1: v2 error tool results surface state.error.message', () => {
    const raw = buildV2ExportJson({
      directory: cwd,
      messages: [
        { id: 'm1', type: 'user', time: { created: 1 }, text: 'run' },
        {
          id: 'm2',
          type: 'assistant',
          time: { created: 2 },
          content: [
            {
              type: 'tool',
              id: 'call_err',
              name: 'bash',
              state: {
                status: 'error',
                input: { command: 'false' },
                content: [],
                error: { type: 'unknown', message: 'command failed' },
              },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => raw,
    });

    const content = r.readSessionContent('ses_v2', cwd);

    expect(content.events.map((e) => e.type)).toEqual(['text', 'tool_use', 'tool_result']);
    expect(content.events[2]!.content).toBe('command failed');
  });

  // a pathological tool_result output is pre-folded at event-build time,
  // reusing the shared truncateUtf8 primitive + 已截断 suffix.
  it('L2: folds a huge tool_result content via truncateUtf8 (bounded + 已截断)', () => {
    const huge = 'x'.repeat(100_000);
    const raw = buildExportJson({
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool',
              callID: 'c1',
              tool: 'Bash',
              state: { status: 'completed', input: { command: 'ls' }, output: huge },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => raw,
    });
    const content = r.readSessionContent('ses_test', cwd);
    const toolResults = content.events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    const c = toolResults[0]!.content;
    expect(c).toContain(DEFAULT_TRUNCATE_SUFFIX);
    // bounded well below the original 100KB and within budget + suffix
    expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_BYTES + Buffer.byteLength(DEFAULT_TRUNCATE_SUFFIX, 'utf8'),
    );
    expect(c.length).toBeLessThan(huge.length);
  });

  it('L3: empty output -> truly missing', () => {
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => '',
    });
    const content = r.readSessionContent('ses_missing', cwd);
    expect(content.events).toEqual([]);
  });

  it('L3: captureExport throws -> empty events', () => {
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => {
        throw new Error('spawn ENOENT');
      },
    });
    const content = r.readSessionContent('ses_err', cwd);
    expect(content.events).toEqual([]);
  });
});

describe('OpencodeSessionReader - usage extraction (ccusage-aligned)', () => {
  const cwd = '/synth/usage-test';

  it('extracts cache.write as cacheCreationTokens and tokens.total as totalTokens', () => {
    // Real OpenCode shape: total = input + output + cache.read + cache.write + reasoning.
    // ccusage maps cache.write -> cacheCreationTokens, tokens.total -> totalTokens
    // (reasoning folded into the display total via max()).
    const json = buildExportJson({
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'done' },
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: {
                total: 13393,
                input: 13240,
                output: 3,
                reasoning: 50,
                cache: { read: 0, write: 100 },
              },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => json,
    });
    const content = r.readSessionContent('ses_test', cwd);
    expect(content.usage).toBeDefined();
    expect(content.usage!.cacheCreationTokens).toBe(100); // cache.write (was dropped)
    expect(content.usage!.cacheReadTokens).toBe(0); // cache.read
    expect(content.usage!.totalTokens).toBe(13393); // tokens.total (was dropped)
    expect(content.usage!.inputTokens).toBe(13240);
    expect(content.usage!.outputTokens).toBe(3);
  });

  it('exposes cumulative input/output summed across all step-finish parts', () => {
    const json = buildExportJson({
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'q1' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'a1' },
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: {
                total: 300,
                input: 200,
                output: 50,
                reasoning: 0,
                cache: { read: 0, write: 50 },
              },
            },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: 'q2' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'a2' },
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: {
                total: 13393,
                input: 13240,
                output: 3,
                reasoning: 50,
                cache: { read: 0, write: 100 },
              },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => json,
    });
    const content = r.readSessionContent('ses_cum', cwd);
    expect(content.usage).toBeDefined();
    // per-turn = last step-finish (overwrites): input=13240, output=3
    expect(content.usage!.inputTokens).toBe(13240);
    expect(content.usage!.outputTokens).toBe(3);
    // cumulative = sum across all step-finish: input=200+13240=13440, output=50+3=53
    expect(content.usage!.cumulativeInputTokens).toBe(13440);
    expect(content.usage!.cumulativeOutputTokens).toBe(53);
  });

  it('falls back to the last non-empty step-finish when the final step has zero tokens', () => {
    // Regression: a long autonomous run can end on a degenerate final step (the
    // model is cut off mid-reasoning) whose step-finish reports all-zero tokens.
    // Trusting it wipes out the run's real per-turn usage (contextLength/input/
    // output/total all render 0 on the Run card). Per-turn usage must fall back
    // to the last step-finish that actually consumed tokens.
    const json = buildExportJson({
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'do the refactor' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'step done' },
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: {
                total: 492529,
                input: 656,
                output: 97,
                reasoning: 0,
                cache: { read: 491776, write: 0 },
              },
            },
          ],
        },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'the mock feeds stderr asynchronously...' },
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => json,
    });
    const content = r.readSessionContent('ses_degenerate', cwd);
    expect(content.usage).toBeDefined();
    // per-turn falls back to the last non-empty step, not the zero-token stub.
    expect(content.usage!.inputTokens).toBe(656);
    expect(content.usage!.outputTokens).toBe(97);
    expect(content.usage!.totalTokens).toBe(492529);
    expect(content.usage!.contextLength).toBe(656 + 97 + 491776); // §9.21: 含末轮 output
    // cumulative still sums everything; the zero stub contributes nothing.
    expect(content.usage!.cumulativeInputTokens).toBe(656);
    expect(content.usage!.cumulativeTotalTokens).toBe(492529);
  });

  it('still reports cumulative tokens when no step carries a usable total', () => {
    // 每条 step 的 total 都是 0（per-turn 无从取值）但 input 有数：这类不一致
    // 报文下 per-turn 留 0，累计口径仍然要报出来，不能整块 usage 消失。
    const json = buildExportJson({
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: { total: 0, input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => json,
    });
    const content = r.readSessionContent('ses_cumulative_only', cwd);

    expect(content.usage!.inputTokens).toBe(0);
    expect(content.usage!.cumulativeInputTokens).toBe(5);
  });

  // 一次 run = N 次模型请求（工具往返），卡片"本 run"必须是这 N 条之和。
  // 只取末条会把多步 run 低报（实测一条 25 请求的 run：input 20,040 显示成 543、
  // output 10,358 显示成 1,250）。
  it('v2: sums every model request of the last turn (one assistant message = one request)', () => {
    const json = buildV2ExportJson({
      directory: cwd,
      messages: [
        { id: 'm1', type: 'user', time: { created: 1 }, text: 'do the refactor' },
        {
          id: 'm2',
          type: 'assistant',
          time: { created: 2 },
          content: [{ type: 'text', text: 'step 1' }],
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        },
        {
          id: 'm3',
          type: 'assistant',
          time: { created: 3 },
          content: [{ type: 'text', text: 'step 2' }],
          tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 6, write: 2 } },
        },
      ],
    });
    const r = new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => json });

    const content = r.readSessionContent('ses_v2_multi_step', cwd);

    expect(content.usage).toMatchObject({
      inputTokens: 30, // 10 + 20
      outputTokens: 9, // 5 + 4
      cacheReadTokens: 9, // 3 + 6
      cacheCreationTokens: 3, // 1 + 2
      totalTokens: 53, // (10+5+2+3+1) + (20+4+0+6+2)
      // contextLength 仍是末次请求的窗口水位，不求和。
      contextLength: 20 + 4 + 6 + 2,
      cumulativeInputTokens: 30,
      cumulativeOutputTokens: 9,
    });
  });

  // idle 是 opencode 自带的 turn 结束标记（真实 export 里每个 idle 前一条是
  // assistant、后一条是 user/synthetic/system）。上一个 turn 的消耗必须排除，
  // 否则长会话里"本 run"会随历史不断膨胀。
  it('v2: turn boundary is the last idle message, earlier turns excluded', () => {
    const json = buildV2ExportJson({
      directory: cwd,
      messages: [
        { id: 'm1', type: 'user', time: { created: 1 }, text: 'old turn' },
        {
          id: 'm2',
          type: 'assistant',
          time: { created: 2 },
          content: [{ type: 'text', text: 'old answer' }],
          tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 9000, write: 0 } },
        },
        { id: 'm3', type: 'idle', time: { created: 3 }, outcome: 'succeeded' },
        { id: 'm4', type: 'user', time: { created: 4 }, text: 'new turn' },
        {
          id: 'm5',
          type: 'assistant',
          time: { created: 5 },
          content: [{ type: 'text', text: 'part 1' }],
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
        },
        {
          id: 'm6',
          type: 'assistant',
          time: { created: 6 },
          content: [{ type: 'text', text: 'part 2' }],
          tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 200, write: 0 } },
        },
        { id: 'm7', type: 'idle', time: { created: 7 }, outcome: 'succeeded' },
      ],
    });
    const r = new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => json });

    const content = r.readSessionContent('ses_v2_turns', cwd);

    expect(content.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 9,
      cacheReadTokens: 300,
      totalTokens: 339, // (10+5+100) + (20+4+200)
      contextLength: 20 + 4 + 200,
      cumulativeInputTokens: 1030,
      cumulativeCacheReadTokens: 9300,
    });
  });

  // 自动续跑：shell 完成事件会写 synthetic 消息另起一个 turn，ACP prompt 的
  // user 消息可能晚于该 turn 的第一条 assistant（实测 08:07:18 早于 08:07:24）。
  // 中间没有 idle 就属于同一个 turn，必须一起计入。
  it('v2: a synthetic turn start followed by the user prompt stays in one turn', () => {
    const json = buildV2ExportJson({
      directory: cwd,
      messages: [
        { id: 'm1', type: 'user', time: { created: 1 }, text: 'previous' },
        {
          id: 'm2',
          type: 'assistant',
          time: { created: 2 },
          content: [{ type: 'text', text: 'previous answer' }],
          tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 5000, write: 0 } },
        },
        { id: 'm3', type: 'idle', time: { created: 3 }, outcome: 'succeeded' },
        { id: 'm4', type: 'synthetic', time: { created: 4 }, text: 'shell finished' },
        {
          id: 'm5',
          type: 'assistant',
          time: { created: 5 },
          content: [{ type: 'text', text: 'checking the run' }],
          tokens: { input: 96, output: 201, reasoning: 164, cache: { read: 279040, write: 0 } },
        },
        { id: 'm6', type: 'user', time: { created: 6 }, text: 'also probe the network' },
        {
          id: 'm7',
          type: 'assistant',
          time: { created: 7 },
          content: [{ type: 'text', text: 'done' }],
          tokens: { input: 738, output: 158, reasoning: 2562, cache: { read: 279040, write: 0 } },
        },
        { id: 'm8', type: 'idle', time: { created: 8 }, outcome: 'succeeded' },
      ],
    });
    const r = new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => json });

    const content = r.readSessionContent('ses_v2_synthetic', cwd);

    expect(content.usage).toMatchObject({
      inputTokens: 96 + 738,
      outputTokens: 201 + 158,
      cacheReadTokens: 279040 + 279040,
      totalTokens: 96 + 201 + 164 + 279040 + (738 + 158 + 2562 + 279040),
      contextLength: 738 + 158 + 279040,
    });
  });

  it('v2: a zero-token trailing message does not wipe the turn sum', () => {
    const json = buildV2ExportJson({
      directory: cwd,
      messages: [
        { id: 'm1', type: 'user', time: { created: 1 }, text: 'run' },
        {
          id: 'm2',
          type: 'assistant',
          time: { created: 2 },
          content: [{ type: 'text', text: 'real step' }],
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
        },
        {
          id: 'm3',
          type: 'assistant',
          time: { created: 3 },
          content: [{ type: 'reasoning', text: 'cut off mid-reasoning' }],
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    });
    const r = new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => json });

    const content = r.readSessionContent('ses_v2_degenerate', cwd);

    expect(content.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      contextLength: 10 + 5 + 100,
    });
  });

  // v1 没有 idle 标记，turn 边界只有"最后一条 user 消息"；同一 turn 内多个
  // step-finish（step 粒度）同样要相加。
  it('v1: sums every step-finish part of the last turn', () => {
    const json = buildExportJson({
      directory: cwd,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'old turn' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: {
                total: 9000,
                input: 8000,
                output: 500,
                reasoning: 0,
                cache: { read: 0, write: 500 },
              },
            },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: 'new turn' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'step-finish',
              reason: 'tool_calls',
              tokens: {
                total: 100,
                input: 60,
                output: 20,
                reasoning: 0,
                cache: { read: 0, write: 20 },
              },
            },
          ],
        },
        {
          role: 'assistant',
          parts: [
            {
              type: 'step-finish',
              reason: 'stop',
              tokens: {
                total: 300,
                input: 200,
                output: 50,
                reasoning: 0,
                cache: { read: 0, write: 50 },
              },
            },
          ],
        },
      ],
    });
    const r = new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => json });

    const content = r.readSessionContent('ses_v1_multi_step', cwd);

    expect(content.usage).toMatchObject({
      inputTokens: 260, // 60 + 200
      outputTokens: 70, // 20 + 50
      cacheCreationTokens: 70, // 20 + 50
      totalTokens: 400, // 100 + 300
      contextLength: 200 + 50 + 0 + 50, // 末次请求水位，不求和
      cumulativeInputTokens: 8260,
    });
  });
});

// isSessionActive 此前零直测：/active 与 auto-resume 每次都要问它「这条会话还在跑吗」，
// 判错的表现是活跃会话被漏掉、或早已结束的会话被当成还在跑。
describe('OpencodeSessionReader - isSessionActive', () => {
  let reader: OpencodeSessionReader;
  let tmpDir: string;
  /** entry.directory 要和 production 的 realpath(cwd) 一致，所以落在真实目录上。 */
  let directory: string;

  beforeEach(() => {
    vi.clearAllMocks();
    reader = new OpencodeSessionReader({ cacheTtlMs: 0 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-active-'));
    directory = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    rmRf(tmpDir);
  });

  function mockSessionList(entries: Array<Record<string, unknown>>): void {
    mockSpawnResult(
      JSON.stringify(
        entries.map((e) => ({
          id: 'ses_target',
          title: 't',
          created: 0,
          projectId: 'p',
          updated: Date.now(),
          directory,
          ...e,
        })),
      ),
    );
  }

  it('treats a session updated within the stale window as active', () => {
    mockSessionList([{}]);

    expect(reader.isSessionActive('ses_target', tmpDir)).toBe(true);
  });

  it('treats a session older than the stale window as inactive', () => {
    mockSessionList([{ updated: Date.now() - STALE_MS - 1000 }]);

    expect(reader.isSessionActive('ses_target', tmpDir)).toBe(false);
  });

  it('does not match a session that belongs to another directory', () => {
    mockSessionList([{ directory: '/other/project' }]);

    expect(reader.isSessionActive('ses_target', tmpDir)).toBe(false);
  });

  it('does not match another session of the same directory', () => {
    mockSessionList([{ id: 'ses_other' }]);

    // id 与 directory 是 AND：只按 directory 命中就会拿别人的 updated 判活。
    expect(reader.isSessionActive('ses_target', tmpDir)).toBe(false);
  });

  it('returns false instead of throwing when the CLI read fails', () => {
    // listSessions 侧的契约是「失败上抛、与真空可区分」；isSessionActive
    // 相反：它只用来判活，读不到就当作不活跃，不能让 /active 整页挂掉。
    mockSpawnResult('not valid json{{{');

    expect(reader.isSessionActive('ses_target', tmpDir)).toBe(false);
  });
});

// displayTitle 是 /active 列表与恢复卡上给看的那一行标题，此前零直测。
describe('OpencodeSessionReader - displayTitle', () => {
  const cwd = '/synth/title-test';

  function read(
    messages: Array<{ role: 'user' | 'assistant'; parts: Array<Record<string, unknown>> }>,
  ): {
    displayTitle?: string;
  } {
    const r = new OpencodeSessionReader({
      cacheTtlMs: 0,
      captureExport: () => buildExportJson({ directory: cwd, messages }),
    });
    return r.readSessionContent('ses_title', cwd);
  }

  it('uses the first text part of the last user message', () => {
    const content = read([
      { role: 'user', parts: [{ type: 'text', text: 'old task' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'old reply' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'current task' },
          { type: 'text', text: 'appended note' },
        ],
      },
    ]);

    // 「首个」写错成「末个」时标题会变成补充说明，看起来仍然是正常文本。
    expect(content.displayTitle).toBe('current task');
  });

  it('falls back to the first user text when the tail has none', () => {
    const content = read([
      { role: 'user', parts: [{ type: 'text', text: 'old task' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'old reply' }] },
      // 最后一条 user 只有 step 事件、没有正文：catch-up 尾巴里取不到标题。
      { role: 'user', parts: [{ type: 'step-start' }] },
    ]);

    expect(content.displayTitle).toBe('old task');
  });
});

// ---------------------------------------------------------------------------
// readSessionContent cwd 判等（review 2026-10-07 samePath 收口回归锚）
//
// 修复前用裸 `data.info.directory !== realCwd`，而 listSessions 走 samePath：
// opencode 自行记录的 directory 形态（大小写/尾分隔符）与 realpath(cwd) 不
// 逐字符一致时，会话列得出却读空。linux 是大小写敏感 FS、samePath 在 linux
// 严格相等，形态变体用例只对 darwin/win32 有意义，故 skipIf(linux)。
// ---------------------------------------------------------------------------
describe('readSessionContent cwd 判等（samePath 收口）', () => {
  it.skipIf(currentPlatform === 'linux')(
    'export 的 directory 仅差大小写/尾分隔符时仍能读出内容',
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cwd-key-'));
      try {
        const resolved = fs.realpathSync(tmpDir);
        const raw = buildExportJson({
          id: 'ses_var',
          directory: resolved.toUpperCase() + '/',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        });
        const r = new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => raw });
        const content = r.readSessionContent('ses_var', tmpDir);
        expect(content.events.length).toBeGreaterThan(0);
      } finally {
        rmRf(tmpDir);
      }
    },
  );
});
