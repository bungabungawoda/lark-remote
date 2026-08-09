/**
 * P2-3 anchor: summarizeSession / summarizePiSession 流式早停
 *
 * 原实现 summarizeSession / summarizePiSession 用 readJsonlLines 全量读整个文件
 * 只为取首条 user 消息。N 个文件 × 全量读 = 大量无用 I/O + parse。
 * 改用 findJsonlLine 流式早停后，首条 user 通常在前几行即可停，
 * N 次全量读 → N 次短读（大 session -99% I/O）。
 *
 * 红测试策略：
 *   spy readJsonlLines — listClaudeSessions / PiSessionReader.listSessions
 *   提取 summary 时若仍调用 readJsonlLines 则测试红（说明没走流式早停路径）。
 *   改后 findJsonlLine 路径不触发 readJsonlLines spy → 绿。
 *
 * 同时验证 summary 文本不变（功能等价回归）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as jsonlModule from '../../../src/session/common/jsonl.js';
import { listClaudeSessions } from '../../../src/session/claude/sessions.js';
import { PiSessionReader } from '../../../src/session/pi/sessions.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-p23-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Claude ──────────────────────────────────────────────────────────────────

/** Write a fake Claude session jsonl under <tmpDir>/<encodedCwd>/ */
function writeClaudeSession(cwd: string, userLines: string[], paddingLineCount: number): string {
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(tmpDir, 'claude', encoded);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = `sess-${Math.random().toString(36).slice(2, 8)}`;
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`;
  const allLines = [initLine, ...userLines];
  for (let i = 0; i < paddingLineCount; i++) {
    allLines.push(
      `{"type":"assistant","message":{"id":"m${i}","role":"assistant","content":[{"type":"text","text":"padding ${i}"}]}}`,
    );
  }
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), allLines.join('\n') + '\n');
  return sessionId;
}

describe('P2-3: summarizeSession uses streaming early-stop (claude)', () => {
  it('test_anchor_summarize_does_not_call_readJsonlLines', () => {
    const spy = vi.spyOn(jsonlModule, 'readJsonlLines');

    const cwd = '/tmp/p23-claude';
    const sessionId = writeClaudeSession(
      cwd,
      [
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first user input"}]}}',
      ],
      500,
    );

    const sessions = listClaudeSessions(cwd, { projectsDir: path.join(tmpDir, 'claude') });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
    expect(sessions[0].summary).toContain('first user input');

    expect(spy).not.toHaveBeenCalled();
  });

  it('test_anchor_summarize_early_stop_saves_io_on_multiple_files', () => {
    const spy = vi.spyOn(jsonlModule, 'readJsonlLines');

    const cwd = '/tmp/p23-claude-multi';
    writeClaudeSession(
      cwd,
      ['{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task A"}]}}'],
      200,
    );
    writeClaudeSession(
      cwd,
      ['{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task B"}]}}'],
      200,
    );
    writeClaudeSession(
      cwd,
      ['{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task C"}]}}'],
      200,
    );

    const sessions = listClaudeSessions(cwd, { projectsDir: path.join(tmpDir, 'claude') });
    expect(sessions).toHaveLength(3);
    expect(spy).not.toHaveBeenCalled();
  });

  it('test_anchor_summarize_fallback_when_no_user_message', () => {
    const spy = vi.spyOn(jsonlModule, 'readJsonlLines');

    const cwd = '/tmp/p23-claude-no-user';
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, 'claude', encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'no-user-sess';
    const lines = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"no user here"}]}}',
    ];
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const sessions = listClaudeSessions(cwd, { projectsDir: path.join(tmpDir, 'claude') });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('(无摘要)');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Pi ──────────────────────────────────────────────────────────────────────

/** Write a fake pi session jsonl under <tmpDir>/sessions/--<encodedCwd>--/ */
function writePiSession(cwd: string, userText: string, paddingLineCount: number): string {
  const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
  const dir = path.join(tmpDir, 'pi', 'sessions', `--${encodedCwd}--`);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = Math.random().toString(36).slice(2, 18);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${sessionId}.jsonl`;
  const allLines: string[] = [
    `{"type":"session","id":"${sessionId}","cwd":"${cwd}","provider":"glm","modelId":"glm-5.2"}`,
    `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${userText}"}]}}`,
  ];
  for (let i = 0; i < paddingLineCount; i++) {
    allLines.push(
      `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"padding ${i}"}]}}`,
    );
  }
  fs.writeFileSync(path.join(dir, filename), allLines.join('\n') + '\n');
  return sessionId;
}

describe('P2-3: summarizePiSession uses streaming early-stop (pi)', () => {
  it('test_anchor_pi_summarize_does_not_call_readJsonlLines', () => {
    const spy = vi.spyOn(jsonlModule, 'readJsonlLines');

    const cwd = '/tmp/p23-pi';
    writePiSession(cwd, 'first pi user input', 500);

    const reader = new PiSessionReader({ piDir: path.join(tmpDir, 'pi') });
    const result = reader.listSessions(cwd);

    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    expect(result.sessions[0].summary).toContain('first pi user input');

    expect(spy).not.toHaveBeenCalled();
  });

  it('test_anchor_pi_summarize_early_stop_saves_io_on_multiple_files', () => {
    const spy = vi.spyOn(jsonlModule, 'readJsonlLines');

    const cwd = '/tmp/p23-pi-multi';
    writePiSession(cwd, 'task A', 200);
    writePiSession(cwd, 'task B', 200);
    writePiSession(cwd, 'task C', 200);

    const reader = new PiSessionReader({ piDir: path.join(tmpDir, 'pi') });
    const result = reader.listSessions(cwd);

    expect(result.sessions.length).toBeGreaterThanOrEqual(3);
    expect(spy).not.toHaveBeenCalled();
  });

  it('test_anchor_pi_summarize_fallback_when_no_user_message', () => {
    const spy = vi.spyOn(jsonlModule, 'readJsonlLines');

    const cwd = '/tmp/p23-pi-no-user';
    const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
    const dir = path.join(tmpDir, 'pi', 'sessions', `--${encodedCwd}--`);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'no-user-pi';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${sessionId}.jsonl`;
    const lines = [
      `{"type":"session","id":"${sessionId}","cwd":"${cwd}","provider":"glm","modelId":"glm-5.2"}`,
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"no user here"}]}}',
    ];
    fs.writeFileSync(path.join(dir, filename), lines.join('\n') + '\n');

    const reader = new PiSessionReader({ piDir: path.join(tmpDir, 'pi') });
    const result = reader.listSessions(cwd);

    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    expect(result.sessions[0].summary).toBe('(无摘要)');
    expect(spy).not.toHaveBeenCalled();
  });
});
