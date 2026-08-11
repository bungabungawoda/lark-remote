/**
 * Anchor Test: P1-11 — run() 生成器被消费者提前关闭时不得留下孤儿进程
 *
 * ① 验证什么行为：
 *   消费者在 for-await 循环体内抛错（触发生成器 .return()）时，run() 的
 *   finally 必须把仍在运行的子进程杀掉——进程退出 + pid 文件清理都不能少。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前 run() 的 finally 只做 bookkeeping（currentProcess=null + unlink pid
 *   文件），不杀进程。bridge 的 for-await 循环体内任何异常（cardSession.push
 *   flush 抛错、sessionStore 磁盘写失败等）→ 隐式 .return() → 子进程继续运行，
 *   而 stop() 够不到（currentProcess 已 null）、killOrphan 够不到（pid 文件已
 *   删）、exit handler 够不到（同一字段）——杀不到、等不死、看不见的黑洞进程；
 *   且 jsonl-stream 的 data 监听器还挂着，stdout 满后子进程永久阻塞（review
 *   §P1-11 前因后果）。
 *
 * ③ 依据：review.md §P1-11「run() 生成器被消费者提前关闭时，子进程变成不可
 *   追踪的孤儿黑洞」+ 原失败用例（循环体内 throw，进程必须被 kill）；
 *   修复建议「run() 的 finally 中，若 this.currentProcess 仍存活则
 *   await this.stopper.stop(proc, { immediate: true }) 再清理」。
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

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P1-11: run() early close must not orphan the child process', () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-11-orphan-anchor-'));
    savedPath = prependPath(tmpDir);
  });

  afterEach(() => {
    restorePath(savedPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_run_early_close_kills_child_process', async () => {
    // side pid 文件由 mock 自己写（$$ 在 exec 前后同一 pid），避免与 run() finally
    // 会 unlink 的 runner pid 文件竞争读取窗口
    const sidePidFile = path.join(tmpDir, 'side.pid');
    writeMockBin(
      tmpDir,
      'claude',
      `#!/bin/bash
echo $$ > "${sidePidFile}"
echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"m"}'
exec sleep 60
`,
    );

    const runner = new ClaudeRunner({
      workspace: 'test',
      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const iter = runner.run('hello', { cwd: '/tmp' });

    // 模拟 bridge 循环体异常：for-await 在第一个事件处抛错 → 隐式调用生成器
    // .return() → run() finally 必须把仍在运行的子进程杀掉
    try {
      for await (const _event of iter) {
        throw new Error('consumer exploded');
      }
    } catch {
      // 预期：消费者异常被捕获，但子进程绝不能因此变成孤儿
    }

    // mock 在输出首个事件前已写 $$；循环体抛错后进程要么被杀（修复后）要么存活
    // （当前 bug）
    await waitFor(() => fs.existsSync(sidePidFile), 3000);
    const leaderPid = Number(fs.readFileSync(sidePidFile, 'utf-8'));
    expect(leaderPid).toBeGreaterThan(0);

    // 当前 bug：finally 只清 bookkeeping，sleep 60 进程存活 → waitFor 超时 → RED
    await waitFor(() => !isAlive(leaderPid), 3000);
    expect(isAlive(leaderPid)).toBe(false);
  });
});
