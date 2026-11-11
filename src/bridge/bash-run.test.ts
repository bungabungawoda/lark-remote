/**
 * BashRunLifecycle.getActiveBashRuns 行为测试：/active 只列仍在 running 的 `!` run，
 * run 收尾后登记表清空、不再上报。用挂起的 mock BashProcessRunner 把 run 停在
 * 在途状态，避免 spawn 任何真实进程。
 */
import { describe, it, expect, vi } from 'vitest';

const { gate } = vi.hoisted(() => ({
  gate: { release: undefined as undefined | (() => void) },
}));

vi.mock('../runner/bash/runner.js', () => ({
  BashProcessRunner: class {
    async *run() {
      yield { type: 'stdout', content: 'partial output' };
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      yield { type: 'exit', content: '', exitCode: 0 };
    }
    async stop(): Promise<void> {}
    get isRunning(): boolean {
      return true;
    }
  },
}));

vi.mock('../card/bash-card-session.js', () => ({
  capBashOutput: (value: string) => value,
  BashCardSession: class {
    currentState = { terminal: 'running' };
    async start(): Promise<void> {}
    async update(): Promise<void> {}
    async finish(terminal: string): Promise<void> {
      this.currentState.terminal = terminal;
    }
    async settle(): Promise<string> {
      return 'sent';
    }
  },
}));

import { BashRunLifecycle } from './bash-run.js';

const CWD = '/tmp/lark-bash-run-test';

function makeLifecycle(): BashRunLifecycle {
  return new BashRunLifecycle({
    connector: {} as never,
    sessionStore: { get: () => ({ cwd: CWD }) } as never,
    resolveCwd: () => CWD,
    sendResult: async () => true,
    finishTurnReactions: () => {},
  });
}

describe('BashRunLifecycle.getActiveBashRuns', () => {
  it('列出正在运行的 `!` run，收尾后不再出现在 /active', async () => {
    const lifecycle = makeLifecycle();
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };
    const running = lifecycle.executeBash('sleep 10', ctx);

    await vi.waitFor(() => {
      expect(lifecycle.getActiveBashRuns()).toHaveLength(1);
      expect(gate.release).toBeTypeOf('function');
    });
    const [active] = lifecycle.getActiveBashRuns();
    expect(active).toMatchObject({
      cwd: CWD,
      userId: 'u1',
      chatId: 'c1',
      command: 'sleep 10',
      terminal: 'running',
    });
    expect(active.runId).toBeTruthy();

    gate.release?.();
    await running;

    expect(lifecycle.getActiveBashRuns()).toEqual([]);
  });
});
