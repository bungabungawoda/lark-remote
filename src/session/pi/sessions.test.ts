import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiSessionReader } from '../../session/pi/sessions.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-pi-session-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Encode cwd to pi's directory name format: --<cwd-with-/->-.
 * Mirrors projectDirForCwd in sessions.ts.
 */
function encodeCwd(cwd: string): string {
  const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
  return `--${encodedCwd}--`;
}

/**
 * Write a pi session JSONL file into the correct directory structure.
 * Returns the file path.
 */
function writeSessionFile(
  sessionId: string,
  cwd: string,
  lines: unknown[],
  opts?: { mtime?: Date },
): string {
  const sessionsDir = path.join(tmpDir, 'sessions');
  const dir = path.join(sessionsDir, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${timestamp}_${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  if (opts?.mtime) {
    fs.utimesSync(filePath, opts.mtime.getTime() / 1000, opts.mtime.getTime() / 1000);
  }
  return filePath;
}

/**
 * Write a pi session JSONL file WITHOUT trailing newline.
 * Returns the file path.
 */
function writeSessionFileNoTrailingNewline(
  sessionId: string,
  cwd: string,
  lines: unknown[],
): string {
  const sessionsDir = path.join(tmpDir, 'sessions');
  const dir = path.join(sessionsDir, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${timestamp}_${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

describe('PiSessionReader', () => {
  it('test_anchor_list_sessions_filters_by_cwd_via_scan', () => {
    const now = new Date();
    writeSessionFile(
      'sess-a',
      '/tmp/proj1',
      [
        { type: 'session', id: 'sess-a', cwd: '/tmp/proj1', model: 'glm-5.2' },
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'Session A' }] },
        },
      ],
      { mtime: now },
    );
    writeSessionFile(
      'sess-b',
      '/tmp/proj1',
      [
        { type: 'session', id: 'sess-b', cwd: '/tmp/proj1', model: 'glm-5.2' },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'B' }] } },
      ],
      { mtime: new Date(Date.now() - 3600000) },
    );
    writeSessionFile(
      'sess-c',
      '/tmp/proj2',
      [
        { type: 'session', id: 'sess-c', cwd: '/tmp/proj2', model: 'glm-5.2' },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'C' }] } },
      ],
      { mtime: now },
    );

    const reader = new PiSessionReader({ piDir: tmpDir });
    const sessions = reader.listSessions('/tmp/proj1');

    expect(sessions.total).toBe(2);
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions[0].sessionId).toBe('sess-a');
    expect(sessions.sessions[0].summary).toBe('Session A');
    expect(sessions.sessions[1].sessionId).toBe('sess-b');
  });

  it('test_anchor_read_session_content_returns_catch_up_tail', () => {
    const sessionId = 'sess-content';
    const cwd = '/tmp/test';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'second question' }] },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.events.length).toBeGreaterThan(0);
    const textEvent = content.events.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent!.content).toContain('second answer');
  });

  it('test_anchor_read_session_content_no_trailing_newline', () => {
    const sessionId = 'sess-no-newline';
    const cwd = '/tmp/no-newline';
    writeSessionFileNoTrailingNewline(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'last line no newline' }] },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    const textEvent = content.events.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent!.content).toContain('last line no newline');
  });

  it('test_anchor_directory_scan_works_without_session_db', () => {
    // No session-db.json at all — pure directory scan should find sessions.
    const cwd = '/tmp/scan-test';
    const sessionId = 'scan-sess-1';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'scanned' }] } },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const sessions = reader.listSessions(cwd);

    expect(sessions.total).toBeGreaterThanOrEqual(1);
    expect(sessions.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it('test_anchor_is_session_active_by_mtime', () => {
    const sessionId = 'sess-active';
    const cwd = '/tmp/active';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    expect(reader.isSessionActive(sessionId, cwd)).toBe(true);

    // Old session should be inactive: write the file with stale mtime.
    const oldSessionId = 'sess-old';
    const staleTime = new Date(Date.now() - 2 * 3600000);
    writeSessionFile(
      oldSessionId,
      cwd,
      [
        { type: 'session', id: oldSessionId, cwd, model: 'glm-5.2' },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'old' }] } },
      ],
      { mtime: staleTime },
    );
    expect(reader.isSessionActive(oldSessionId, cwd)).toBe(false);
  });

  it('test_anchor_not_found_returns_empty_events', () => {
    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent('nonexistent', '/tmp/none');
    expect(content.events).toHaveLength(0);
  });

  it('test_anchor_tool_call_content_blocks_extracted', () => {
    const sessionId = 'sess-tools';
    const cwd = '/tmp/tools';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'read file' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/tmp/foo' } }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'tool',
          content: [
            { type: 'toolResult', toolCallId: 'c1', content: 'file content', isError: false },
          ],
        },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    const toolUseEvent = content.events.find((e) => e.type === 'tool_use');
    expect(toolUseEvent).toBeDefined();
    expect(toolUseEvent!.content).toContain('read');

    const toolResultEvent = content.events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!.content).toContain('file content');
  });

  it('test_anchor_error_message_shows_error_details', () => {
    const sessionId = 'sess-error';
    const cwd = '/tmp/error-test';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage:
            '403 Authentication failed: Remote validation failed, message: The requested model does not exist or the model name is incorrect',
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    const errorEvent = content.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.content).toContain('❌');
    expect(errorEvent!.content).toContain('403 Authentication failed');
  });

  it('test_anchor_successful_assistant_message_not_treated_as_error', () => {
    const sessionId = 'sess-success';
    const cwd = '/tmp/success-test';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          stopReason: 'stop',
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    const textEvent = content.events.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent!.content).toContain('hi there');

    const errorEvent = content.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeUndefined();
  });

  // =============================================================================
  // displayTitle: skill-injection compression (regression 2026-07-13)
  // =============================================================================

  it('displayTitle compresses skill injection to skill:<name> + trailing input', () => {
    const sessionId = 'sess-skill';
    const cwd = '/tmp/skill';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'do something first' }] },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<skill name="code-cleaner" location="/home/user/.agents/skills/code-cleaner/SKILL.md">\n# Code Cleaner\n...several KB of skill body...\n</skill>\n\nthen commit & push',
            },
          ],
        },
      },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.displayTitle).toBe('skill:code-cleaner then commit & push');
    expect(content.displayTitle).not.toContain('<skill');
    expect(content.displayTitle).not.toContain('# Code Cleaner');
  });

  it('displayTitle compresses pure skill injection (no trailing input) to skill:<name>', () => {
    const sessionId = 'sess-skill-pure';
    const cwd = '/tmp/skill-pure';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<skill name="doc-reader" location="/x/SKILL.md">\n## Steps\nRead the full document\n</skill>',
            },
          ],
        },
      },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.displayTitle).toBe('skill:doc-reader');
    expect(content.displayTitle).not.toContain('Steps');
  });

  it('displayTitle leaves plain user input unchanged', () => {
    const sessionId = 'sess-plain';
    const cwd = '/tmp/plain';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'fix this bug for me' }] },
      },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.displayTitle).toBe('fix this bug for me');
  });

  // =============================================================================
  // Usage extraction tests
  // =============================================================================

  it('test_extracts_usage_from_assistant_messages', () => {
    const sessionId = 'sess-usage';
    const cwd = '/tmp/usage';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.inputTokens).toBe(1000);
    expect(content.usage!.outputTokens).toBe(200);
    expect(content.usage!.contextLength).toBe(1000);
  });

  it('test_extracts_total_tokens_and_cache_from_assistant_usage', () => {
    const sessionId = 'sess-total';
    const cwd = '/tmp/total';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 500, output: 20, cacheRead: 100, cacheWrite: 30, totalTokens: 650 },
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);
    expect(content.usage).toBeDefined();
    expect(content.usage!.inputTokens).toBe(500);
    expect(content.usage!.outputTokens).toBe(20);
    expect(content.usage!.cacheReadTokens).toBe(100);
    expect(content.usage!.cacheCreationTokens).toBe(30);
    expect(content.usage!.totalTokens).toBe(650);
  });

  it('test_extracts_cumulative_usage_across_multiple_runs', () => {
    const sessionId = 'sess-cum';
    const cwd = '/tmp/cum';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'q1' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'a1' }],
        },
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'q2' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 500, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 620 },
          content: [{ type: 'text', text: 'a2' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);
    expect(content.usage).toBeDefined();
    expect(content.usage!.inputTokens).toBe(500);
    expect(content.usage!.outputTokens).toBe(20);
    expect(content.usage!.cumulativeInputTokens).toBe(1500); // 1000 + 500
    expect(content.usage!.cumulativeOutputTokens).toBe(220); // 200 + 20
  });

  it('test_extracts_compact_count_from_compaction_entries', () => {
    const sessionId = 'sess-compact';
    const cwd = '/tmp/compact';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task 1' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 10000, output: 500, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'done with task 1' }],
        },
      },
      {
        type: 'compaction',
        timestamp: '2025-12-08T23:22:54.411Z',
        summary: '# Context Checkpoint',
        firstKeptEntryIndex: 5,
        tokensBefore: 50000,
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task 2' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 8000, output: 300, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'done with task 2' }],
        },
      },
      {
        type: 'compaction',
        timestamp: '2025-12-08T23:54:21.502Z',
        summary: '# Context Checkpoint 2',
        firstKeptEntryIndex: 10,
        tokensBefore: 80000,
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task 3' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'done with task 3' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.compactCount).toBe(2);
    expect(content.usage!.contextLength).toBe(5000);
  });

  it('test_extracts_cache_tokens', () => {
    const sessionId = 'sess-cache';
    const cwd = '/tmp/cache';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 300 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.cacheReadTokens).toBe(500);
    expect(content.usage!.cacheCreationTokens).toBe(300);
  });

  // =============================================================================
  // Real wire-format anchor (2026-07-30)
  // =============================================================================

  it('test_anchor_real_pi_compaction_wire_format_recognized', () => {
    const sessionId = 'sess-real-compact';
    const cwd = '/tmp/real-compact';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.1' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 180000, output: 500, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'working' }],
        },
      },
      {
        type: 'compaction',
        id: 'a1b2c3d4',
        parentId: 'e5f6a7b8',
        timestamp: '2026-07-22T00:21:59.867Z',
        summary: '\n\n## Goal\nImplement the feature',
        firstKeptEntryId: 'c9d0e1f2',
        tokensBefore: 190000,
        details: {
          readFiles: ['/fake/read/a.ts', '/fake/read/b.ts'],
          modifiedFiles: ['/fake/mod/a.ts'],
        },
        fromHook: false,
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'after compact' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.compactCount).toBe(1);
    expect(content.usage!.contextLength).toBe(2000);
  });

  it('test_no_compact_count_when_no_compaction_entries', () => {
    const sessionId = 'sess-no-compact';
    const cwd = '/tmp/no-compact';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.compactCount).toBeUndefined();
  });

  it('test_context_length_uses_last_turn_when_no_compaction', () => {
    const sessionId = 'sess-context';
    const cwd = '/tmp/context';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 10000, output: 1000, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'response 1' }],
        },
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'response 2' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.contextLength).toBe(2000);
    expect(content.usage!.inputTokens).toBe(2000);
    expect(content.usage!.outputTokens).toBe(500);
  });

  // =============================================================================
  // Token usage: last turn vs cumulative (regression fix for cache token display)
  // =============================================================================

  it('test_cache_read_tokens_returns_last_turn_not_cumulative', () => {
    const sessionId = 'sess-cache-last';
    const cwd = '/tmp/cache-last';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'turn 1' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'resp 1' }],
        },
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'turn 2' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1500, output: 150, cacheRead: 50000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'resp 2' }],
        },
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'turn 3' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 2000, output: 200, cacheRead: 70000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'resp 3' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.cacheReadTokens).toBe(70000);
    expect(content.usage!.inputTokens).toBe(2000);
    expect(content.usage!.outputTokens).toBe(200);
  });

  it('test_cache_tokens_after_compaction_uses_post_compaction_value', () => {
    const sessionId = 'sess-cache-compact';
    const cwd = '/tmp/cache-compact';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'before compact' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 50000, output: 1000, cacheRead: 80000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'resp before' }],
        },
      },
      {
        type: 'compaction',
        timestamp: '2025-12-08T23:22:54.411Z',
        summary: '# Context Checkpoint',
        tokensBefore: 90000,
      },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'after compact' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 100, cacheRead: 60000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'resp after' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.cacheReadTokens).toBe(60000);
    expect(content.usage!.contextLength).toBe(61000); // 1000 + 60000 + 0
  });

  it('test_zero_cache_read_returns_zero', () => {
    const sessionId = 'sess-cache-zero';
    const cwd = '/tmp/cache-zero';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.cacheReadTokens).toBe(0);
  });

  it('test_context_length_includes_cache_after_compaction', () => {
    const sessionId = 'sess-compact-new-turn';
    const cwd = '/tmp/compact-new-turn';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'before' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 80000, output: 1000, cacheRead: 100000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'done' }],
        },
      },
      {
        type: 'compaction',
        timestamp: '2025-12-08T23:22:54.411Z',
        summary: '# Context Checkpoint',
        tokensBefore: 181000,
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'after' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 100, output: 50, cacheRead: 5000, cacheWrite: 0 },
          content: [{ type: 'text', text: 'new turn' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.contextLength).toBe(5100); // 100+5000+0
  });

  it('test_context_length_includes_cache_in_normal_turn', () => {
    const sessionId = 'sess-cache-normal';
    const cwd = '/tmp/cache-normal';
    writeSessionFile(sessionId, cwd, [
      { type: 'session', id: sessionId, cwd, model: 'glm-5.2' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          usage: { input: 100, output: 50, cacheRead: 9000, cacheWrite: 1000 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ]);

    const reader = new PiSessionReader({ piDir: tmpDir });
    const content = reader.readSessionContent(sessionId, cwd);

    expect(content.usage).toBeDefined();
    expect(content.usage!.contextLength).toBe(10100); // 100+9000+1000
  });
});
