/**
 * P1-19 anchors: claude/pi listSessions must be TTL-cached
 *
 * Every /resume page call rescans the whole project dir: readdir + per-file
 * stat + readCwdFromJsonl + summarizeSession (each file opened 2×; files
 * without a user message are fully read). Router flips pages repeatedly
 * (and clamps by re-calling), so each flip costs hundreds of ms of sync
 * event-loop blocking. codex already solved this with a 5s TTL index
 * (src/session/codex/rollout-reader.ts getSessionIndex); claude/pi never
 * got the same treatment.
 *
 * review.md §P1-19: "给 claude/pi 的列表路径加与 codex 相同的 TTL 缓存
 * （key = projectsDir/sessionsDir + dir mtime 或 5s TTL）。测试可断言：
 * 连续两次 resume.page 时 reader listSessions 调用次数（当前=2，加缓存后=1）"。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listClaudeSessions } from '../../../src/session/claude/sessions.js';
import { PiSessionReader } from '../../../src/session/pi/index.js';

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

function encodeProjectDir(cwd: string): string {
  return `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`;
}

/** claude 的目录编码：/ 与 _ 都替换为 -（见 src/session/claude/sessions.ts）。 */
function encodeClaudeDir(cwd: string): string {
  return cwd.replace(/\//g, '-').replace(/_/g, '-');
}

describe('P1-19 session list TTL cache', () => {
  it('test_anchor_claude_list_sessions_ttl_cached', () => {
    // ① 验证什么行为：5s TTL 内连续两次 listClaudeSessions 只扫描一次目录
    //    （readdirSync 一次），第二次命中缓存。
    // ② 缺失/错误会导致什么：每次 /resume 翻页全量重扫：readdir + 每文件
    //    2 次 open + 无 user 消息的文件全量读完（可达 5MB/文件），热目录 110
    //    文件 → 数百次同步 open + 数 MB 全 parse，事件循环阻塞数百 ms。
    // ③ 依据：review.md §P1-19「claude/pi listSessions 无任何缓存，每次
    //    /resume 翻页全目录重扫」。
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-19-claude-'));
    try {
      const realCwd = fs.realpathSync(projectDir);
      const dir = path.join(projectDir, encodeClaudeDir(realCwd));
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(dir, `sess-${i}.jsonl`),
          `{"type":"user","cwd":"${realCwd}","prompt":"hi ${i}","sessionId":"s${i}"}\n`,
          'utf-8',
        );
      }

      const spy = vi.spyOn(fs, 'readdirSync');
      listClaudeSessions(realCwd, { projectsDir: projectDir });
      const scansAfterFirst = spy.mock.calls.filter((c) => c[0] === dir).length;
      expect(scansAfterFirst).toBe(1);

      listClaudeSessions(realCwd, { projectsDir: projectDir });

      expect(spy.mock.calls.filter((c) => c[0] === dir).length).toBe(scansAfterFirst);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('test_anchor_pi_list_sessions_ttl_cached', () => {
    // ① 验证什么行为：5s TTL 内连续两次 PiSessionReader.listSessions 只扫描
    //    一次 sessions 目录（readdirSync 一次）。
    // ② 缺失/错误会导致什么：pi 单目录可上千文件，每次翻页数百次同步 open +
    //    全 parse，事件循环阻塞数百 ms（与 claude 同根）。
    // ③ 依据：review.md §P1-19「pi 同样 2 次 open/文件…claude/pi 没有跟进」。
    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-19-pi-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-19-pi-proj-'));
    try {
      const realCwd = fs.realpathSync(projectDir);
      const dir = path.join(piDir, 'sessions', encodeProjectDir(realCwd));
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(dir, `1700000000000_s${i}.jsonl`),
          `{"type":"session","id":"s${i}","cwd":"${realCwd}","provider":"p","modelId":"m"}\n`,
          'utf-8',
        );
      }

      const reader = new PiSessionReader({ piDir });
      const spy = vi.spyOn(fs, 'readdirSync');
      reader.listSessions(realCwd);
      const scansAfterFirst = spy.mock.calls.filter((c) => c[0] === dir).length;
      expect(scansAfterFirst).toBe(1);

      reader.listSessions(realCwd);

      expect(spy.mock.calls.filter((c) => c[0] === dir).length).toBe(scansAfterFirst);
    } finally {
      fs.rmSync(piDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
