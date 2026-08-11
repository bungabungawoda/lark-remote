/**
 * Anchor Test: P1-10 — killOrphan() 必须做进程身份校验（pid 复用防护）
 *
 * ① 验证什么行为：
 *   当 pid 文件里的 pid 对应的进程身份与 runner.binary 不匹配时（典型场景：
 *   bridge 崩溃残留 pid 文件后系统回收复用了该 pid，现在属于一个无关进程），
 *   killOrphan() 不得向该进程发任何信号，同时把陈旧的 pid 文件自愈清除。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前实现只做 `process.kill(pid, 0)` 存活探测就直接 SIGTERM。pid 复用在
 *   macOS/Linux 上完全可能发生，被杀掉的可以是任何同 uid 的无关进程——bridge
 *   崩溃重启的瞬间就可能误杀用户的其他进程（review §P1-10 前因后果）。本测试
 *   用真实无关进程（sleep）写进 pid 文件模拟 pid 复用。
 *
 * ③ 依据：review.md §P1-10「killOrphan() 无进程身份校验：pid 复用时 SIGTERM
 *   无关进程」+ 原失败用例（写一个存活无关进程的 pid 进 pid 文件，killOrphan
 *   不得杀它）；修复建议「SIGTERM 前读取 ps -p <pid> -o comm= 校验 binary 名
 *   匹配 this.binary」（本项目落地为 `-o command=` 全命令行匹配，因为 agent
 *   二进制可能是 bash wrapper，comm 只会显示解释器名）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from '../../../src/runner/claude/index.js';

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

describe('P1-10: killOrphan process identity verification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-10-identity-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_kill_orphan_does_not_kill_unrelated_process_on_pid_reuse', async () => {
    // 无关进程：真实的 sleep，与 runner.binary（mock-agent）身份不匹配
    const innocent = spawn('sleep', ['60'], { detached: true });
    const pid = innocent.pid!;
    try {
      const runner = new ClaudeRunner({
        workspace: 'test',
        pidDir: tmpDir,
      });
      const pidFilePath = path.join(tmpDir, 'claude-test.pid');
      // 模拟 pid 复用：陈旧 pid 文件里的 pid 现在属于一个无关进程
      fs.writeFileSync(pidFilePath, String(pid), 'utf-8');

      runner.killOrphan();

      // 给信号落地留出窗口。当前 bug：直接 SIGTERM 无关进程 → 200ms 后已死 → RED
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(pid, 0)).not.toThrow();
      // 陈旧 pid 文件应被自愈清除（身份不匹配 = 我们的进程早已不在，文件是垃圾）
      expect(fs.existsSync(pidFilePath)).toBe(false);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });
});
