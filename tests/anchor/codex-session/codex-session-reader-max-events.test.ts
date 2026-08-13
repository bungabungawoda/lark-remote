import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 4 - Anchor (Bug 模式)
 *
 * Target: CodexSessionReader.readSessionContent 必须支持 maxEvents 限制返回事件数。
 *
 * Importance: router.readSessionDisplayState 在 auto-resume 场景下传入
 *   `{ maxEvents: AUTO_RESUME_MAX_EVENTS }` 限制事件数，避免卡片负载过大。
 *   但 CodexSessionReader.readSessionContent 当前签名是 `(sessionId, _cwd)` ——
 *   直接丢弃第三个参数。结果：codex 会话的 auto-resume 卡片依赖
 *   enforceCardBudget 兜底（极端降级），而其他 agent 已经有 maxEvents 早期截断。
 *   project_memory 中的硬约束已写明：maxEvents 必须在所有 agent session reader 实现。
 *
 * Spec basis:
 *   - Design constraint "maxEvents parameter must be implemented for all agent
 *     session readers (not just claude)"
 *   - lessons learned "maxEvents参数仅在claude session实现导致非claude agent的
 *     auto-resume功能依赖enforceCardBudget兜底"
 *   - src/runner/index.ts AgentSessionReader 接口签名:
 *     `readSessionContent(sessionId, cwd, opts?: { maxEvents?: number }): SessionContent`
 *
 * Pyramid: L1 (unit) — 直接调用 reader，验证事件数 <= maxEvents
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

import { CodexSessionReader } from '../../../src/session/codex/sessions.js';
import { readCodexSessionContent } from '../../../src/session/codex/rollout-reader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-maxevents-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 写一个 codex rollout 文件，包含 N 个 user+assistant 消息对（即 2N 个事件）。
 */
function writeRolloutWithMessages(sessionId: string, pairs: number): void {
  const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '15');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const lines: string[] = [
    `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"/tmp/proj","originator":"lark-remote"}}`,
  ];
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
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
}

describe('CodexSessionReader maxEvents - anchor', () => {
  it('test_anchor_readCodexSessionContent_honors_maxEvents', () => {
    // 5 pairs = 10 events (5 user + 5 assistant)
    const sessionId = '019f-maxevents-direct';
    writeRolloutWithMessages(sessionId, 5);

    const content = readCodexSessionContent(sessionId, {
      codexHome: tmpDir,
      maxEvents: 3,
    });

    // 必须截断到 <= 3 个事件（与 claude 一致的 soft cap 语义：可能在 message
    // 边界稍超，但 codex 的 event 粒度已经是 message，所以严格 <= maxEvents）
    expect(content.events.length).toBeLessThanOrEqual(3);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_readCodexSessionContent_without_maxEvents_returns_all', () => {
    const sessionId = '019f-maxevents-no-limit';
    writeRolloutWithMessages(sessionId, 4);

    const content = readCodexSessionContent(sessionId, { codexHome: tmpDir });

    // 不传 maxEvents 时返回全部 8 个事件
    expect(content.events.length).toBe(8);
  });

  it('test_anchor_codex_session_reader_forwards_maxEvents', () => {
    // 验证 CodexSessionReader 类（不是底层函数）正确转发 maxEvents
    const sessionId = '019f-maxevents-reader';
    writeRolloutWithMessages(sessionId, 6); // 12 events total

    const reader = new CodexSessionReader({ codexHome: tmpDir });
    const content = reader.readSessionContent(sessionId, '/tmp/proj', {
      maxEvents: 4,
    });

    // reader 必须转发 maxEvents 给底层 readCodexSessionContent
    expect(content.events.length).toBeLessThanOrEqual(4);
    expect(content.events.length).toBeGreaterThan(0);
  });

  it('test_anchor_codex_session_reader_without_opts_returns_all', () => {
    const sessionId = '019f-maxevents-reader-nolimit';
    writeRolloutWithMessages(sessionId, 3); // 6 events total

    const reader = new CodexSessionReader({ codexHome: tmpDir });
    // 不传 opts（与现有调用方兼容）
    const content = reader.readSessionContent(sessionId, '/tmp/proj');

    expect(content.events.length).toBe(6);
  });
});
