import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentSessionReader } from '../../../src/runner/index.js';
import { ClaudeSessionReader } from '../../../src/session/claude/index.js';
import { OpencodeSessionReader } from '../../../src/session/opencode/index.js';
import { PiSessionReader } from '../../../src/session/pi/index.js';

/**
 * Red Agent - Anchor (Bug 模式)
 *
 * Target: ClaudeSessionReader / OpencodeSessionReader / PiSessionReader 的
 *   readSessionContent 必须接受并转发 maxEvents，与 CodexSessionReader 对齐。
 *
 * Importance: router.readSessionDisplayState 在 auto-resume 场景下传入
 *   `{ maxEvents: AUTO_RESUME_MAX_EVENTS }` 限制事件数，避免卡片负载过大。
 *   但这三个 reader 当前签名是 `(sessionId, cwd)` —— 第三个参数被默默丢弃。
 *   结果：claude/opencode/pi 会话的 auto-resume 加载整个会话，maxEvents 失效，
 *   只能靠下游 enforceCardBudget 兜底（截断不准、可能丢近期事件）。
 *
 * Spec basis:
 *   - CLAUDE.md 硬约束 "session reader 必须转发 maxEvents 参数"
 *   - project_memory "maxEvents parameter must be implemented for all agent
 *     session readers (not just claude)"
 *   - src/runner/index.ts AgentSessionReader 接口签名:
 *     `readSessionContent(sessionId, cwd, opts?: { maxEvents?: number }): SessionContent`
 *   - CodexSessionReader 已正确转发（codex-sessions.ts），本测试对称补全其余三个。
 *
 * Pyramid: L1 (unit) — 直接调用 reader，验证事件数 <= maxEvents
 *
 * NOTE: 三个 reader 的方法当前签名缺 opts，TS 允许实现方法参数少于接口声明，
 *   所以 opts 在运行时被丢弃。通过 `AgentSessionReader` 接口类型调用让测试
 *   typecheck 通过，运行时验证 maxEvents 是否真的被转发。
 */

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxevents-fwd-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// ClaudeSessionReader
// ============================================================

function writeClaudeSession(cwd: string, sessionId: string, assistantCount: number): void {
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
    `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"question"}]}}`,
  ];
  for (let i = 0; i < assistantCount; i++) {
    lines.push(
      `{"type":"assistant","message":{"id":"m${i}","role":"assistant","content":[{"type":"text","text":"answer ${i}"}]}}`,
    );
  }
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

describe('ClaudeSessionReader maxEvents forwarding - anchor', () => {
  it('test_anchor_claude_reader_forwards_maxEvents', () => {
    const cwd = '/tmp/proj-claude-max';
    // catch-up tail = 6 assistant events (lastUserIdx+1 起，不含 user)
    writeClaudeSession(cwd, 'sess-claude-max', 6);
    const reader: AgentSessionReader = new ClaudeSessionReader({ projectsDir: tmpDir });

    const content = reader.readSessionContent('sess-claude-max', cwd, { maxEvents: 3 });

    // 底层 claude-sessions 已支持 maxEvents（软上限，每 message 单 block 时严格 <=）
    expect(content.events.length).toBeLessThanOrEqual(3);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_claude_reader_without_opts_returns_all', () => {
    const cwd = '/tmp/proj-claude-all';
    writeClaudeSession(cwd, 'sess-claude-all', 5);
    const reader: AgentSessionReader = new ClaudeSessionReader({ projectsDir: tmpDir });

    const content = reader.readSessionContent('sess-claude-all', cwd);

    // 不传 opts：返回全部 5 个 assistant 事件（向后兼容）
    expect(content.events.length).toBe(5);
  });
});

// ============================================================
// OpencodeSessionReader
// ============================================================

function makeOpencodeExport(cwd: string, assistantCount: number): string {
  const messages: unknown[] = [
    { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'question' }] },
  ];
  for (let i = 0; i < assistantCount; i++) {
    messages.push({
      info: { role: 'assistant', time: { created: i + 2 } },
      parts: [{ type: 'text', text: `answer ${i}` }],
    });
  }
  return JSON.stringify({ info: { directory: cwd, title: 'test' }, messages });
}

describe('OpencodeSessionReader maxEvents forwarding - anchor', () => {
  it('test_anchor_opencode_reader_forwards_maxEvents', () => {
    const cwd = fs.realpathSync(tmpDir);
    // catch-up tail = 1 user + 6 assistant = 7 events
    const exportJson = makeOpencodeExport(cwd, 6);
    const reader: AgentSessionReader = new OpencodeSessionReader({
      captureExport: () => exportJson,
    });

    const content = reader.readSessionContent('sess-oc-max', cwd, { maxEvents: 3 });

    expect(content.events.length).toBeLessThanOrEqual(3);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_opencode_reader_without_opts_returns_all', () => {
    const cwd = fs.realpathSync(tmpDir);
    // catch-up tail = 1 user + 5 assistant = 6 events
    const exportJson = makeOpencodeExport(cwd, 5);
    const reader: AgentSessionReader = new OpencodeSessionReader({
      captureExport: () => exportJson,
    });

    const content = reader.readSessionContent('sess-oc-all', cwd);

    expect(content.events.length).toBe(6);
  });
});

// ============================================================
// PiSessionReader
// ============================================================

function writePiSession(
  piDir: string,
  cwd: string,
  sessionId: string,
  assistantCount: number,
): void {
  const sessionsDir = path.join(piDir, 'sessions');
  // Encode cwd to pi's directory name format: --<cwd-with-/->- -
  const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
  const dir = path.join(sessionsDir, `--${encodedCwd}--`);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionPath = path.join(dir, `${timestamp}_${sessionId}.jsonl`);
  const ts = Date.now();
  const lines: string[] = [
    JSON.stringify({ type: 'session', id: sessionId, cwd, version: 3, timestamp: ts }),
    JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'question', timestamp: ts },
    }),
  ];
  for (let i = 0; i < assistantCount; i++) {
    lines.push(
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `answer ${i}` }],
          timestamp: ts + i,
        },
      }),
    );
  }
  fs.writeFileSync(sessionPath, lines.join('\n') + '\n');
}

describe('PiSessionReader maxEvents forwarding - anchor', () => {
  it('test_anchor_pi_reader_forwards_maxEvents', () => {
    const piDir = path.join(tmpDir, 'pi-agent');
    const cwd = '/tmp/proj-pi-max';
    // catch-up tail = 6 assistant events (lastUserIdx+1 起，不含 user)
    writePiSession(piDir, cwd, 'sess-pi-max', 6);
    const reader: AgentSessionReader = new PiSessionReader({ piDir });

    const content = reader.readSessionContent('sess-pi-max', cwd, { maxEvents: 3 });

    expect(content.events.length).toBeLessThanOrEqual(3);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_pi_reader_without_opts_returns_all', () => {
    const piDir = path.join(tmpDir, 'pi-agent');
    const cwd = '/tmp/proj-pi-all';
    writePiSession(piDir, cwd, 'sess-pi-all', 5);
    const reader: AgentSessionReader = new PiSessionReader({ piDir });

    const content = reader.readSessionContent('sess-pi-all', cwd);

    expect(content.events.length).toBe(5);
  });
});
