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

describe('P1-16 kimi listSessions mtime source', () => {
  it('test_anchor_kimi_list_sorts_by_wire_mtime_not_dir_mtime', () => {
    // ① 验证什么行为：同一 cwd 下多个 kimi session 时，listSessions 按真实
    //    活跃度（agents/main/wire.jsonl 的 mtime，kimi 运行中持续追加的文件）
    //    降序排序，getNewestSession 返回真正最新活跃的 session。
    // ② 缺失/错误会导致什么：目录 mtime 只在「创建/删除/重命名条目」时更新，
    //    追加写 wire.jsonl 不更新目录 mtime → 排序失真；更严重的是
    //    getNewestSession（/cd 后自动 resume）会选中一个实际上更久没动的
    //    session 自动恢复，把用户恢复到过期的会话。
    // ③ 依据：review.md §P1-16「session 目录的 mtime 只在目录内『创建/删除/
    //    重命名条目』时更新；kimi 运行中追加写 agents/main/wire.jsonl 不会更新
    //    目录 mtime…修复建议：listSessions 改 stat …wire.jsonl 的 mtime，
    //    不存在时回退目录 mtime」。
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-16-kimi-proj-'));
    const kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-16-kimi-'));
    try {
      const realCwd = fs.realpathSync(projectDir);
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      // sessionA：目录 mtime 新（目录内新建过条目），但 wire.jsonl 一小时没动
      // sessionB：wire.jsonl 刚追加过（真实活跃），目录 mtime 却是一小时前
      const sessionA = path.join(kimiDir, 'sessions', 'sessionA');
      const sessionB = path.join(kimiDir, 'sessions', 'sessionB');
      for (const [sessionDir, label] of [
        [sessionA, 'A'],
        [sessionB, 'B'],
      ] as const) {
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
        fs.writeFileSync(
          path.join(sessionDir, 'state.json'),
          JSON.stringify({
            createdAt: new Date(now - 86_400_000).toISOString(),
            updatedAt: new Date(now).toISOString(),
            title: `session ${label}`,
            isCustomTitle: true,
            workDir: realCwd,
            lastPrompt: `prompt ${label}`,
          }),
          'utf-8',
        );
        fs.writeFileSync(
          path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
          `{"type":"turn.prompt","time":${now}}\n`,
          'utf-8',
        );
      }

      // 反向 mtime：A 的 wire 旧、目录新；B 的 wire 新、目录旧。
      // 注意 fs.utimesSync 的 atime/mtime 参数单位是秒（或 Date），传毫秒会被
      // 钳制到 APFS 最大值 → 排序退化为 tie-break，失去「目录 vs wire」判别力。
      const nowSec = now / 1000;
      const oneHourAgoSec = oneHourAgo / 1000;
      fs.utimesSync(
        path.join(sessionA, 'agents', 'main', 'wire.jsonl'),
        oneHourAgoSec,
        oneHourAgoSec,
      );
      fs.utimesSync(path.join(sessionB, 'agents', 'main', 'wire.jsonl'), nowSec, nowSec);
      fs.utimesSync(sessionA, nowSec, nowSec);
      fs.utimesSync(sessionB, oneHourAgoSec, oneHourAgoSec);

      fs.writeFileSync(
        path.join(kimiDir, 'session_index.jsonl'),
        [
          JSON.stringify({ sessionId: 'sessionA', sessionDir: sessionA, workDir: realCwd }),
          JSON.stringify({ sessionId: 'sessionB', sessionDir: sessionB, workDir: realCwd }),
        ].join('\n') + '\n',
        'utf-8',
      );

      const reader = new KimiSessionReader(kimiDir);
      const { sessions, total } = reader.listSessions(realCwd);

      expect(total).toBe(2);
      expect(sessions[0]?.sessionId).toBe('sessionB');
      expect(reader.getNewestSession(realCwd)?.sessionId).toBe('sessionB');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(kimiDir, { recursive: true, force: true });
    }
  });
});
