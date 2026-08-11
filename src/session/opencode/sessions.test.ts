import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeSessionReader } from '../../session/opencode/sessions.js';

// Mock execFileSync
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import { TOOL_RESULT_MAX_BYTES, DEFAULT_TRUNCATE_SUFFIX } from '../../card/text-truncate.js';

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

describe('OpencodeSessionReader - L1: empty output handling', () => {
  let reader: OpencodeSessionReader;

  beforeEach(() => {
    vi.clearAllMocks();
    reader = new OpencodeSessionReader({ cacheTtlMs: 0 });
  });

  it('handles empty string output from opencode session list gracefully', () => {
    // opencode session list returns empty string (0 bytes) when no sessions exist
    vi.mocked(execFileSync).mockReturnValue('');

    const sessions = reader.listSessions('/tmp/empty-dir');

    expect(sessions).toEqual({ sessions: [], total: 0 });
    // Should NOT throw SyntaxError: Unexpected end of JSON input
    expect(execFileSync).toHaveBeenCalled();
  });

  it('handles whitespace-only output from opencode session list gracefully', () => {
    // Some edge cases might produce whitespace-only output
    vi.mocked(execFileSync).mockReturnValue('   \n  \n  ');

    const sessions = reader.listSessions('/tmp/empty-dir');

    expect(sessions).toEqual({ sessions: [], total: 0 });
  });

  it('parses valid JSON array output normally', () => {
    // Use a real temp dir so realpath resolves consistently. Production receives
    // a realpath from SessionStore (CLAUDE.md: cwd stored as realpath-resolved),
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
      vi.mocked(execFileSync).mockReturnValue(validJson);

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

  it('throws on corrupt JSON (P1-15: failure distinct from empty)', () => {
    // P1-15：CLI 返回不可解析输出是真实读取失败，必须上抛让 router 显示
    // 「读取失败」；旧契约静默返回 [] 与「真空」不可区分（review §P1-15）。
    vi.mocked(execFileSync).mockReturnValue('not valid json{{{');

    expect(() => reader.listSessions('/tmp/test')).toThrow(/读取失败/);
  });

  it('passes cwd to opencode session list command', () => {
    vi.mocked(execFileSync).mockReturnValue('[]');

    reader.listSessions('/home/user/project');

    expect(execFileSync).toHaveBeenCalledWith(
      'opencode',
      ['session', 'list', '--format', 'json'],
      expect.objectContaining({
        cwd: '/home/user/project',
      }),
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
    vi.mocked(execFileSync).mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error(
        "spawn opencode ENOENT: chdir '/tmp/opencode-stale-enoent'",
      );
      err.code = 'ENOENT';
      throw err;
    });

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
    vi.mocked(execFileSync).mockReturnValue(validJson);

    const sessions = reader.listSessions(staleCwd);

    expect(sessions).toEqual({ sessions: [], total: 0 });
    // Ensure the filter (not the CLI throw) is what excluded it: CLI was called
    // and returned data, yet no session survived the directory match.
    expect(execFileSync).toHaveBeenCalled();
  });
});

describe('OpencodeSessionReader - L1/L2/L3: large/corrupt export handling', () => {
  const cwd = '/synth/opencode-export-test'; // non-existent -> realpath falls back to itself

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // L1: readSessionContent must use the captureExport seam and parse large
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

  // L1 transport: the DEFAULT captureExport must route stdout to a file fd
  // (not 'pipe'), which bypasses opencode's pipe truncation for large output.
  it('L1: default captureExport routes stdout to a file fd (not a pipe)', () => {
    vi.mocked(execFileSync).mockReturnValue(null as unknown as string);
    const r = new OpencodeSessionReader({ cacheTtlMs: 0 });
    // execFileSync is mocked (writes nothing), so the temp file is empty -> ''.
    const out = (r as unknown as { captureExport: (id: string) => string }).captureExport('ses_tr');
    expect(out).toBe('');
    expect(execFileSync).toHaveBeenCalledWith(
      'opencode',
      ['export', 'ses_tr'],
      expect.objectContaining({ timeout: 30000 }),
    );
    const opts = vi.mocked(execFileSync).mock.calls[0]![2] as Record<string, unknown>;
    expect(Array.isArray(opts.stdio)).toBe(true);
    const stdio = opts.stdio as unknown[];
    expect(stdio[0]).toBe('ignore'); // stdin ignored
    expect(typeof stdio[1]).toBe('number'); // stdout -> file fd (NOT 'pipe')
    expect(stdio[2]).toBe('pipe'); // stderr still captured
  });

  // L2: a pathological tool_result output is pre-folded at event-build time,
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
});
