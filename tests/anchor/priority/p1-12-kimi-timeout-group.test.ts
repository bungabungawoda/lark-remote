/**
 * Anchor Test: P1-12 — kimi awaitCompletion 超时兜底必须杀进程组
 *
 * ① 验证什么行为：
 *   KimiRunner 的 5s 完成超时兜底（kimi 在 stdout 关闭后仍挂死时的强制终止）
 *   必须杀掉整个进程组——agent 启动的后台子进程不能 reparent 成孤儿。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前 awaitCompletion 超时分支只 `process.kill(proc.pid!, 'SIGKILL')` 杀本体。
 *   spawn 用 detached:true，agent 是进程组组长；组长死后组内子进程（kimi 工具
 *   调用起的子进程）被 reparent 继续运行——这正是该文件注释声称要防的 "hang"
 *   场景的半成品处理（review §P1-12 前因后果）。
 *
 * ③ 依据：review.md §P1-12「kimi 挂死触发 5s 超时后 process.kill(proc.pid!,
 *   'SIGKILL') 同样只杀本体」；修复建议「kimi 兜底统一改用
 *   process.kill(-proc.pid, ...) 或复用 this.stopper.stop(proc, ...)」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KimiRunner } from '../../../src/runner/kimi/index.js';

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

/** 暴露受保护的 awaitCompletion 钩子，直接构造 5s 超时路径（不必等真实挂死）。 */
class ExposedKimiRunner extends KimiRunner {
  public awaitCompletionExposed(
    proc: ChildProcess,
    completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.awaitCompletion(proc, completion);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P1-12: kimi completion timeout kills whole group', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-12-kimi-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_kimi_timeout_fallback_kills_whole_group', async () => {
    const childPidFile = path.join(tmpDir, 'child.pid');
    // 真实挂死进程：组长 exec sleep 300 + 同组后台子进程 sleep 300 &
    const proc = spawn('bash', ['-c', `sleep 300 & echo $! > "${childPidFile}"; exec sleep 300`], {
      detached: true,
    });
    const leaderPid = proc.pid!;
    try {
      await waitFor(() => fs.existsSync(childPidFile), 3000);
      const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'));

      const kimi = new ExposedKimiRunner({
        workspace: 'test',
        binary: '/bin/true',
        pidDir: tmpDir,
      });
      vi.useFakeTimers();
      try {
        // completion 永不 resolve（模拟挂死），只能靠 5s 超时兜底；fake timers
        // 把 5000ms 立即推进，不需要真实等待
        const resultPromise = kimi.awaitCompletionExposed(
          proc,
          new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}),
        );
        await vi.advanceTimersByTimeAsync(5000);
        const result = await resultPromise;
        expect(result.signal).toBe('SIGKILL');
      } finally {
        vi.useRealTimers();
      }

      // 当前 bug：只杀组长，后台子进程存活 → waitFor 超时 → RED
      await waitFor(() => !isAlive(leaderPid) && !isAlive(childPid), 3000);
      expect(isAlive(leaderPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      try {
        process.kill(-leaderPid, 'SIGKILL');
      } catch {
        /* already dead */
      }
      try {
        process.kill(leaderPid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });
});
