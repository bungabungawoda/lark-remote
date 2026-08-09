/**
 * Round 9 anchor (plan §2.1): CodexSessionReader.listSessions 负 offset
 * 必须 clamp 到 0，返回第一页而不是静默空页。
 *
 * 验证什么行为：
 *   new CodexSessionReader({ codexHome }).listSessions('/proj', { limit: 20, offset: -1 })
 *   返回 { sessions, total }：
 *   - total 是 cwd 精确匹配的全集大小（分页前）；
 *   - sessions 按 mtimeMs 降序取 [0, limit) —— 负 offset 等价于 offset 0
 *     （clamp 到第一页），与 router 层 resume.page 的 clamp 语义一致；
 *   - 绝不静默空页/尾页（当前 JS `slice(-1, 19)` 负 start 按数组长度解析：
 *     25 条 fixture 下为 (24, 19) → 空页；本 5 条 fixture 下为 (4, 5) →
 *     只返回尾部 1 条，第一页语义都被破坏）。
 *
 * 缺失会导致什么：
 *   当前实现 matched.slice(offset, offset + limit) 把负 offset 直接透传给
 *   Array.prototype.slice：负 start 被按数组长度解析（非 clamp 到 0），
 *   返回的是从末尾倒数的切片而非第一页。直接消费 reader 的调用方
 *   （auto-resume / 未来分页 caller）在负 offset 下拿不到第一页，
 *   total 仍是全集数，静默空页/尾页与 router 层 clamp 语义不一致。
 *
 * 依据（spec 原文）：
 *   - plan §2.1 分页区间定义 "[offset, offset+limit)" 隐含 offset 非负；
 *     reader 层未定义负 offset 语义是 spec gap（Round 8 探测结论）
 *   - router 既有 clamp：resume.page 已对负 offset clamp 到 0
 *     （tests/probe/resume-pagination-boundary-probes.test.ts 验证 pass）
 *   - Round 9 裁决：reader 层统一 `offset < 0 → 0`（不静默空页），
 *     并在 codex reader 上锁 anchor
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexSessionReader } from '../../../src/session/codex/index.js';
import { clearSessionIndexCache } from '../../../src/session/codex/rollout-reader.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codex-negoffset-'));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a minimal valid rollout file whose first line is a legal
 * `session_meta` JSONL record, then pin its mtime to `mtimeSec`.
 */
function writeRollout(sessionsDir: string, sessionId: string, mtimeSec: number): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const firstLine =
    `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"/proj",` +
    `"originator":"x"}}\n`;
  fs.writeFileSync(filePath, firstLine, 'utf-8');
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
}

describe('Round 9 anchor: codex reader negative offset clamps to first page', () => {
  it('test_anchor_codex_reader_negative_offset_clamps_to_first_page', () => {
    // 5 个匹配 /proj 的 rollout 文件，mtime 逐秒递增 → 排序确定，
    // anchor-sess-04 是 mtime 最新，必须出现在第一页首位。
    const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '31');
    const baseSec = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 5; i++) {
      const sessionId = `anchor-sess-${String(i).padStart(2, '0')}`;
      writeRollout(sessionsDir, sessionId, baseSec + i);
    }

    const reader = new CodexSessionReader({ codexHome: tmpDir });

    // offset: -1 → clamp 到 0：返回完整第一页（5 条），不静默空页。
    const negativeOne = reader.listSessions('/proj', { limit: 20, offset: -1 });
    expect(negativeOne.total).toBe(5);
    expect(negativeOne.sessions).toHaveLength(5);
    expect(negativeOne.sessions[0].sessionId).toBe('anchor-sess-04');

    // offset: -999 → 同样 clamp 到 0，与 -1 行为一致。
    const negativeFar = reader.listSessions('/proj', { limit: 20, offset: -999 });
    expect(negativeFar.total).toBe(5);
    expect(negativeFar.sessions).toHaveLength(5);
    expect(negativeFar.sessions[0].sessionId).toBe('anchor-sess-04');
  });
});
