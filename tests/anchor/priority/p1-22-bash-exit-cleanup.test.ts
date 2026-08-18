/**
 * Anchor Test: P1-22 — BashProcessRunner 必须注册进程级 exit 清理并组杀
 *
 * ① 验证什么行为：
 *   运行中的 bash runner（`!` 命令）必须注册到进程级 exit 分发器；bridge
 *   退出/重启（SIGINT/SIGTERM/exit）时分发器调 cleanupOnExit() 必须杀掉 bash
 *   的整个进程组——`sleep 300 &` 后台子进程不能 reparent 成孤儿继续运行。
 *   run() 结束后 runner 必须从分发器移除（与 agent runner 槽位淘汰对齐，防
 *   P1-1 类监听器/集合泄漏）。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前 BashProcessRunner 全文件无 killOrphan/registerExitHandlers/cleanupOnExit
 *   ——`!sleep 3600` 运行中 bridge /restart 或 SIGTERM → bash 及其整组子进程被
 *   孤儿化，无人回收（review §P1-22 前因后果）。5 个 agent runner 都有 exit
 *   cleanup，bash 路径是唯一裸奔者。
 *
 * ③ 依据：review.md §P1-22「BashProcessRunner 无 exit 清理钩子，bridge 退出
 *   时 ! 进程孤儿化」+ 修复建议「给 BashProcessRunner 加与 agent runner 对齐
 *   的组杀 cleanup」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BashProcessRunner } from '../../../src/runner/bash/index.js';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import { waitForOrThrow } from '../../lib/wait-for.js';

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

describe('P1-22: bash runner exit cleanup', () => {
  let tmpDir: string;
  const spawnedPids = new Set<number>();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-22-bash-exit-'));
  });

  afterEach(() => {
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

  it('test_anchor_bash_runner_registers_exit_cleanup_and_kills_group', async () => {
    const leaderPidFile = path.join(tmpDir, 'leader.pid');
    const childPidFile = path.join(tmpDir, 'child.pid');
    const before = SpawningRunner.getRegisteredExitHandlerCount();

    const runner = new BashProcessRunner();
    const iter = runner.run(
      `echo start; echo $$ > "${leaderPidFile}"; sleep 300 & echo $! > "${childPidFile}"; exec sleep 300`,
      { cwd: tmpDir },
    );
    const first = await iter.next();
    expect(first.done).toBe(false);

    // 运行中的 bash runner 必须已注册到进程级 exit 分发器（当前实现无注册 → RED）
    expect(SpawningRunner.getRegisteredExitHandlerCount()).toBe(before + 1);

    const leaderPid = Number(fs.readFileSync(leaderPidFile, 'utf-8'));
    expect(leaderPid).toBeGreaterThan(0);
    spawnedPids.add(leaderPid);
    await waitForOrThrow(() => fs.existsSync(childPidFile), 3000);
    const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'));
    spawnedPids.add(childPid);

    // 触发进程级清理（分发器最终都调 cleanupOnExit）→ 必须组杀
    runner.cleanupOnExit();
    await waitForOrThrow(() => !isAlive(leaderPid) && !isAlive(childPid), 5000);
    expect(isAlive(leaderPid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);

    // run() 自然结束（exit 事件）后必须从分发器移除，集合回到基线
    await iter.next(); // exit 事件
    await iter.next(); // done
    expect(SpawningRunner.getRegisteredExitHandlerCount()).toBe(before);
  });
});
