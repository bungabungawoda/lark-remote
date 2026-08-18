/**
 * `/restart` waitForPreviousInstance 等待语义（live pid / 20s 超时）。
 * spec: restart 自重启方案 §3/§6.4/§7.5
 *
 * 本文件不 mock node:child_process：需要真实短命子进程验证轮询等待。
 * 不 spawn bridge 本身（§7.7 测试约定），只 spawn 一个几百毫秒的辅助进程。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { RESTART_WAIT_PID_ENV, waitForPreviousInstance } from '../../../src/restart.js';
import { sleep } from '../../lib/wait-for.js';

afterEach(() => {
  vi.useRealTimers();
  delete process.env[RESTART_WAIT_PID_ENV];
});

describe('waitForPreviousInstance 等待语义', () => {
  it('test_anchor_wait_for_previous_instance_polls_live_pid_until_death', async () => {
    // 验证行为：env 指向活 pid 时 waitForPreviousInstance 不立即返回，
    //   而是轮询等待 pid 死亡后才 resolve（交接协议的等待窗口）。
    // 缺失/错误会导致：子进程不等待旧进程释放锁就抢锁 → 撞锁退出，重启失败。
    // spec 依据：方案 §2「子进程轮询 process.kill(oldPid, 0) 直到旧进程死」。
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      expect(child.pid).toBeGreaterThan(0);
      process.env[RESTART_WAIT_PID_ENV] = String(child.pid);

      let settled = false;
      const p = waitForPreviousInstance();
      p.catch(() => {});
      p.then(() => {
        settled = true;
      });

      // 活 pid 时至少等待数轮 poll（100ms × 3），不得立即返回
      await sleep(350);
      expect(settled).toBe(false);

      // 杀死子进程 → 等待应立即结束
      child.kill();
      await p;
      expect(settled).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('test_anchor_wait_for_previous_instance_timeout_warns_and_continues', async () => {
    // 验证行为：活 pid 持续存活时，等待至 20s 超时后 resolve（告警后继续），
    //   让锁 acquire 兜底，不永久挂死。
    // 缺失/错误会导致：旧进程卡死不退时子进程永久等待 → 重启链挂死。
    // spec 依据：方案 §2「100ms 轮询、20s 超时，超时仍继续走正常 acquire」+ §7.5。
    vi.useFakeTimers();
    process.env[RESTART_WAIT_PID_ENV] = String(process.pid); // 测试进程本身，一直存活

    const p = waitForPreviousInstance();
    p.catch(() => {});

    // 推进到超时阈值前后：19.9s 仍不应结束，20.1s 后应结束
    await vi.advanceTimersByTimeAsync(19_900);
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await Promise.resolve(); // 微任务 flush
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(settled).toBe(true);
  });
});
