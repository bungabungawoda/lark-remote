import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, AgentStatusInfo } from '../types.js';
import { ConnectionBasedRunner } from './connection-based-runner.js';

vi.mock('../../logger/index.js', async () =>
  (await import('../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * 最小 ConnectionBasedRunner 子类：记录基类对连接生命周期 hook 的调用，
 * 驱动 executeTurn 的完整 run → finally 链路。
 */
class TestRunner extends ConnectionBasedRunner<unknown> {
  calls = {
    notifyIdle: 0,
    disposeConnections: 0,
    releaseConnection: 0,
  };

  protected get logTag(): string {
    return 'test-connection-runner';
  }
  protected get turnTimeoutErrorMessage(): string {
    return 'test timeout';
  }
  protected get turnInterruptedErrorMessage(): string {
    return 'test interrupted';
  }
  protected currentSessionId(): string | null {
    return 'test-session';
  }
  getStatusInfo(): AgentStatusInfo {
    return { kind: 'codex', model: 'test-model' };
  }
  protected shouldDeferStop(): boolean {
    return !this.currentTurnId;
  }
  protected async cancelCurrentTurn(): Promise<void> {}
  protected async setupTurn(): Promise<void> {
    // setup 完成即推入 result 事件，让 consumeTurn 立即收尾（模拟一轮即刻完成的 turn）。
    this.pushEvents([
      { type: 'result', subtype: 'success', session_id: 'test-session' } as unknown as AgentEvent,
    ]);
  }
  protected clearTurnState(): void {}
  protected async releaseConnection(): Promise<void> {
    this.calls.releaseConnection++;
  }
  protected notifyIdle(): void {
    this.calls.notifyIdle++;
  }
  protected async disposeConnections(): Promise<void> {
    this.calls.disposeConnections++;
  }
}

function makeRunner(): TestRunner {
  // @ts-expect-error 测试 stub 的 sessionReader 只需满足类型形参
  return new TestRunner({ kind: 'codex', sessionReader: {} });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cbr-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function drainRun(runner: TestRunner): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runner.run('hello', { cwd: tmpDir })) {
    events.push(ev);
  }
  return events;
}

describe('ConnectionBasedRunner orphan self-disposal (2026-10-11)', () => {
  it('normal run end arms idle timer (notifyIdle), does NOT dispose connections', async () => {
    // 基线：lifetime=workspace 的长驻连接跨 run 复用，run 结束只挂 idle timer。
    const runner = makeRunner();
    const events = await drainRun(runner);
    expect(events.some((e) => e.type === 'result')).toBe(true);
    expect(runner.calls.notifyIdle).toBe(1);
    expect(runner.calls.disposeConnections).toBe(0);
  });

  it('markOrphaned(): run end disposes connections eagerly instead of notifyIdle', async () => {
    // 2026-10-11 事故：bridge 缓存层（interruptCurrentRun / clearRunners 竞态）
    // evict runner 时，若一个 run 刚拿走该实例，其后续创建的长驻连接会脱管——
    // 不被任何 slot 托管、进程残留到 idle TTL 才回收，期间持有 agent 侧会话
    // 写锁（codex "thread already has an active writer"）。
    //
    // 守卫：evictRunnerSlot 调 markOrphaned() 后，该实例上（无论何时启动的）
    // run 结束时必须主动 disposeConnections，而不是挂 idle timer。
    const runner = makeRunner();
    runner.markOrphaned();
    await drainRun(runner);
    expect(runner.calls.disposeConnections).toBeGreaterThanOrEqual(1);
    expect(runner.calls.notifyIdle).toBe(0);
  });

  it('orphan self-disposal survives multiple runs on the same evicted instance', async () => {
    // 除名实例可能被竞态引用后连跑多个 run（每次 acquire 重建连接）。
    // orphaned 标记必须持续生效：每个 run 结束都收掉当时的连接。
    const runner = makeRunner();
    runner.markOrphaned();
    await drainRun(runner);
    await drainRun(runner);
    expect(runner.calls.disposeConnections).toBe(2);
    expect(runner.calls.notifyIdle).toBe(0);
  });
});

/**
 * waitForEvents 的兜底定时器必须在唤醒时清理。
 * 旧实现只 resolve、不 clearTimeout，高频事件下 timer 会持续堆积到 30s。
 */
class WaitingRunner extends TestRunner {
  protected async setupTurn(): Promise<void> {}

  /** Simulate an incoming non-terminal event (wakes the wait loop). */
  poke(): void {
    this.pushEvents([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'tick' }] },
      } as unknown as AgentEvent,
    ]);
  }

  /** Emit the terminal result so the run can finish. */
  finish(): void {
    this.pushEvents([
      { type: 'result', subtype: 'success', session_id: 'test-session' } as unknown as AgentEvent,
    ]);
  }
}

describe('ConnectionBasedRunner wait timer cleanup', () => {
  it('test_anchor_acp_wait_timer_cleared_on_wake', async () => {
    vi.useFakeTimers();
    try {
      // @ts-expect-error 测试 stub 的 sessionReader 只需满足类型形参
      const runner = new WaitingRunner({ kind: 'codex', sessionReader: {} });
      const iter = runner.run('hi', { cwd: tmpDir });

      await iter.next(); // synthetic init
      let pending = iter.next(); // enters waitForEvents
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      for (let i = 0; i < 5; i++) {
        runner.poke();
        await pending; // yields the poked event
        pending = iter.next(); // waits again
        await vi.advanceTimersByTimeAsync(0);
      }

      // 每次唤醒都清掉旧 timer：只有当前这一轮等待的 1 个。
      expect(vi.getTimerCount()).toBe(1);

      runner.finish();
      await pending; // yields result
      const end = await iter.next();
      expect(end.done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
