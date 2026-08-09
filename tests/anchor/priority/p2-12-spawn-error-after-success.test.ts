/**
 * Anchor Test: P2-12 spawn 成功后的 'error' 事件不能被误报为 success
 *
 * 背景（review.md P2-12）：completion promise 的 `proc.once('error')` 分支
 * `resolve({ code: null, signal: null })`；buildResultEvent 判定
 * `code===null && signal===null && !stoppedByUser` → 走 success 分支。spawn
 * 成功后的 'error'（如 kill 失败、管道破裂）虽罕见，一旦发生错误被静默吞成
 * 「成功」，用户看到 success 卡片但 agent 实际崩溃。
 *
 * 修复：error 分支 resolve `{ code: 1, signal: null }`（或显式标记），让
 * buildResultEvent 走 error 分支。
 *
 * 这个 anchor 用一个 spawn 成功（pid 存在）但随后 emit 'error' 的假 proc，
 * 断言最终 result event 的 subtype === 'error'。真红 = 当前 resolve
 * {code:null,signal:null} → subtype==='success'。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { AgentEvent, SpawnOptions } from '../../../src/runner/types.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
import { spawn } from 'node:child_process';

class TestRunner extends SpawningRunner {
  constructor() {
    super({ binary: 'fake-binary', pidDir: '/tmp/p2-12-test', workspace: 'test' });
  }
  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake'];
  }
  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    return null;
  }
}

describe('P2-12: spawn-success error event not reported as success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_spawn_error_after_success_yields_error_result', async () => {
    // stdout ends immediately (no events). The for-await loop drains, then
    // awaitCompletion resolves via the 'error' branch (fires before 'close').
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });

    // Mock ChildProcess: pid present (spawn SUCCEEDED), but emits 'error'
    // after spawn (e.g. kill failure, broken pipe). 'close' never fires so
    // the completion promise settles via the 'error' branch.
    const mockProc = {
      pid: 45678,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          // Fire the error after stdout drains so the for-await loop
          // completes first; the completion promise's error branch then
          // resolves { code: null, signal: null } (the bug under test).
          setTimeout(() => cb(new Error('post-spawn error: kill failed')), 10);
        }
        // 'close' deliberately NOT fired — the 'error' event settles completion.
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new TestRunner();
    const events: AgentEvent[] = [];
    for await (const event of runner.run('hi', { cwd: '/tmp/p2-12' })) {
      events.push(event);
    }

    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);
    const result = resultEvents[0] as { subtype?: string; errorMessage?: string };

    // RED today: subtype === 'success' (because completion error branch
    // resolves {code:null,signal:null} → buildResultEvent classifies as
    // success). GREEN: subtype === 'error'.
    expect(result.subtype).toBe('error');
    // The error must be surfaced, not silently swallowed as success.
    expect(typeof result.errorMessage).toBe('string');
    expect(result.errorMessage!.length).toBeGreaterThan(0);
  });
});
