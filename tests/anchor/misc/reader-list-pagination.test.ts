/**
 * A2 anchor: PiSessionReader.listSessions 返回 {sessions, total}，支持 offset 分页。
 *
 * 验证行为：`listSessions(cwd, { limit, offset })` 返回 `{ sessions, total }`，
 * sessions 为按 mtime desc 排序后 `[offset, offset+limit)` 切片，total 为分页前
 * cwd 精确匹配的全集大小。用真实文件系统 fixture（5 个 pi session jsonl +
 * 不同的 mtime），断言三页：page1（limit 2）取最新 2 条；page2（offset 2）取
 * 第 3、4 新（与 page1 无重复无遗漏）；page3（offset 4）末页 1 条为最旧。
 *
 * 缺失会导致：plan §2.1 新契约要求 `total`（真实总数）与 `offset` 切片，当前
 * 实现返回 `AgentSession[]`——`page1.total` 为 undefined，router 无法实现
 * `/resume` 分页栏的"共 N 个会话"与"第 x/y 页"；若只补 total 不实现 offset，
 * page2/page3 的无重复/末页断言仍会拦住。
 *
 * 依据 spec：docs/architecture/resume-pagination-plan.md §2.1
 *   "listSessions(cwd, opts?: { limit?: number; offset?: number }):
 *    { sessions: AgentSession[]; // mtime desc 排序后的 [offset, offset+limit) 切片
 *      total: number;            // cwd 精确匹配的全集大小（分页前） }"
 * §2.3 "N 为 reader 返回的真实总数"；§4.2 "其余 4 个 reader 单测：接口签名适配 +
 * total 断言"。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

describe('A2: AgentSessionReader.listSessions paginated contract (pi)', () => {
  it('test_anchor_pi_reader_list_sessions_paginated_with_total', () => {
    const cwd = '/tmp/resume-paging-proj';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-a2-pi-'));
    try {
      const reader = new PiSessionReader({ piDir: tmpDir });
      const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
      const sessionsDir = path.join(tmpDir, 'sessions', `--${encodedCwd}--`);
      fs.mkdirSync(sessionsDir, { recursive: true });

      // 5 个 session，mtime t1 < t2 < ... < t5（t5 最新）。ids[i-1] 对应 t_i。
      const baseTime = Date.parse('2026-07-01T00:00:00Z');
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const sessionId = `00000000-0000-4000-8000-00000000000${i}`;
        const mtime = new Date(baseTime + i * 60_000);
        const timestamp = mtime.toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(sessionsDir, `${timestamp}_${sessionId}.jsonl`);
        const lines = [
          `{"type":"session","id":"${sessionId}","cwd":"${cwd}","provider":"glm","modelId":"glm-5.2"}`,
          `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"task ${i}"}]}}`,
        ];
        fs.writeFileSync(filePath, lines.join('\n') + '\n');
        fs.utimesSync(filePath, mtime, mtime);
        ids.push(sessionId);
      }

      // 最新 -> 最旧: ids[4], ids[3], ids[2], ids[1], ids[0]
      const page1 = reader.listSessions(cwd, { limit: 2 });
      expect(page1.total).toBe(5);
      expect(page1.sessions).toHaveLength(2);
      expect(page1.sessions[0].sessionId).toBe(ids[4]);

      const page2 = reader.listSessions(cwd, { limit: 2, offset: 2 });
      expect(page2.total).toBe(5);
      // [offset, offset+limit) = [2, 4) → 下标 2、3，即第 3、4 新：ids[2], ids[1]
      expect(page2.sessions.map((s) => s.sessionId)).toEqual([ids[2], ids[1]]);

      const page3 = reader.listSessions(cwd, { limit: 2, offset: 4 });
      expect(page3.total).toBe(5);
      expect(page3.sessions).toHaveLength(1);
      expect(page3.sessions[0].sessionId).toBe(ids[0]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
