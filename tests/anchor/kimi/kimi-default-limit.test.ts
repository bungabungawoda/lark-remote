/**
 * A7 anchor: kimi listSessions 默认 limit=20（与其他 agent 对齐），total 为真实总数
 *
 * 行为：不传 opts（或 opts.limit 为 undefined）时，KimiSessionReader.listSessions
 * 返回 cwd 精确匹配、按 mtime desc 排序后的最多 20 条 session，且 total 为分页前
 * 的真实全集大小（这里 fixture 共 15 条，应全部返回）。
 *
 * 缺失后果：当前实现 `sessions.slice(0, opts?.limit ?? 10)` 在无 limit 时截到 10
 * 条——第 11+ 个 kimi session 在 /resume 默认页中永远不可见，且 total 语义与其他
 * agent（默认 20）行为分裂；若绿方只改 slice 不保证 total，断言同样拦住。
 *
 * spec 依据：docs/architecture/resume-pagination-plan.md §2.1
 *   "kimi 默认 limit 10 → 20，与其他 agent 对齐"；§1.3
 *   "kimi | 默认 limit=10，与其他 agent 的 20 不一致"。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// Import after mocks are in place so kimi sessions.ts picks up the mocked logger.
const { KimiSessionReader } = await import('../../../src/session/kimi/index.js');

describe('A7: kimi listSessions default limit', () => {
  it('test_anchor_kimi_list_sessions_default_limit_20', () => {
    const SESSION_COUNT = 15;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-a7-kimi-proj-'));
    const kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-a7-kimi-'));
    try {
      const realCwd = fs.realpathSync(projectDir);
      const sessionIds: string[] = [];
      const indexLines: string[] = [];

      for (let i = 0; i < SESSION_COUNT; i++) {
        const sessionId = `kimi-sess-${String(i).padStart(2, '0')}`;
        const sessionDir = path.join(kimiDir, 'sessions', sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessionDir, 'state.json'),
          JSON.stringify({
            createdAt: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
            updatedAt: new Date(Date.UTC(2026, 6, 1, 0, i, 1)).toISOString(),
            title: `kimi session ${i}`,
            isCustomTitle: true,
            workDir: realCwd,
            lastPrompt: `prompt ${i}`,
          }),
          'utf-8',
        );
        sessionIds.push(sessionId);
        indexLines.push(JSON.stringify({ sessionId, sessionDir, workDir: realCwd }));
      }

      // <kimiDir>/session_index.jsonl — one JSON entry per session (real layout
      // consumed by scanSessionIndex).
      fs.writeFileSync(
        path.join(kimiDir, 'session_index.jsonl'),
        indexLines.join('\n') + '\n',
        'utf-8',
      );

      const reader = new KimiSessionReader(kimiDir);
      // No opts at all: default limit must be 20, so all 15 fixture sessions
      // are returned. Current default 10 slices to 10 -> RED.
      const result = reader.listSessions(projectDir);

      expect(result.sessions).toHaveLength(SESSION_COUNT);
      expect(result.total).toBe(SESSION_COUNT);
      expect(result.sessions.map((s) => s.sessionId).sort()).toEqual([...sessionIds].sort());
    } finally {
      fs.rmSync(kimiDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
