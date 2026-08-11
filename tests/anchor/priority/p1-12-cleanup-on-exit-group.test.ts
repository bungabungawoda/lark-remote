/**
 * Anchor Test: P1-12 — cleanupOnExit() 必须杀整个进程组
 *
 * ① 验证什么行为：
 *   bridge 退出/重启时的进程级清理（cleanupOnExit，SIGINT/SIGTERM/exit 分发）
 *   必须杀掉 agent 进程的整个进程组——agent 启动的后台子进程（如工具调用起的
 *   `sleep 300 &`）不能 reparent 成孤儿继续运行。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前 cleanupOnExit 只 `this.currentProcess.kill('SIGTERM')` 杀组长。spawn
 *   用 detached:true，agent 是进程组组长；组长死后组内其他进程被 reparent 继续
 *   运行（bridge 退出时 agent 正在跑的 npm run dev、长编译等子进程变成孤儿），
 *   且 pid 文件已被 unlink，后续 killOrphan 也追不回来（review §P1-12 前因
 *   后果）。ProcessStopper 存在就是为了 kill(-pid) 组杀，exit handler 却绕开了它。
 *
 * ③ 依据：review.md §P1-12「exit handler 与 kimi 超时兜底只杀单 pid，不杀进程
 *   组 → 子进程孤儿化」+ 失败用例（mock：`sleep 300 & exec sleep 300`，清理后
 *   组内无存活进程）；修复建议「cleanup 统一改用 process.kill(-proc.pid, ...)
 *   或复用 this.stopper.stop(proc, ...)」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from '../../../src/runner/claude/index.js';
import { prependPath, restorePath, writeMockBin } from '../../lib/path-mock.js';

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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P1-12: cleanupOnExit kills whole process group', () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  const spawnedPids = new Set<number>();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-12-exit-anchor-'));
    savedPath = prependPath(tmpDir);
  });

  afterEach(() => {
    restorePath(savedPath);
    for (const pid of spawnedPids) {
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
    spawnedPids.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_cleanup_on_exit_kills_whole_group', async () => {
    const childPidFile = path.join(tmpDir, 'child.pid');
    writeMockBin(
      tmpDir,
      'claude',
      `#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"m"}'
sleep 300 &
echo $! > "${childPidFile}"
exec sleep 300
`,
    );

    const runner = new ClaudeRunner({
      workspace: 'test',
      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const iter = runner.run('hello', { cwd: '/tmp' });
    const first = await iter.next();
    expect(first.done).toBe(false);

    const pidFilePath = path.join(tmpDir, 'claude-test.pid');
    const leaderPid = Number(fs.readFileSync(pidFilePath, 'utf-8'));
    expect(leaderPid).toBeGreaterThan(0);
    spawnedPids.add(leaderPid);
    await waitFor(() => fs.existsSync(childPidFile), 3000);
    const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'));
    spawnedPids.add(childPid);

    // 触发进程级清理（SIGINT/SIGTERM/exit 分发器最终都调 cleanupOnExit）
    runner.cleanupOnExit();

    // 当前 bug：只杀组长（sleep 300 & 后台子进程 reparent 存活）→ waitFor 超时 → RED
    await waitFor(() => !isAlive(leaderPid) && !isAlive(childPid), 5000);
    expect(isAlive(leaderPid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(fs.existsSync(pidFilePath)).toBe(false);

    await iter.return(undefined);
    spawnedPids.delete(leaderPid);
    spawnedPids.delete(childPid);
  });
});
