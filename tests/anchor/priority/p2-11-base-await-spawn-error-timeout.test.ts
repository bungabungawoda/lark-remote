/**
 * Anchor Test: P2-11 基类 awaitSpawnError 必须有限超时，不能永久挂起
 *
 * 背景（review.md P2-11）：SpawningRunner.awaitSpawnError 在 proc.pid === undefined
 * 时用 `proc.once('error', resolve)` 无限等待。Node 对 ENOENT/EACCES 保证发 'error'，
 * 但 kimi 的 override 注释明言 "sometimes fails silently without an 'error' event"——
 * 同类静默失败若发生在其他二进制，run() 永远挂起 → workspace 串行队列永不 settle →
 * 永久假死（/stop 也救不了：stopper.stop 在 pid===undefined 时直接 return）。
 *
 * 修复：把 kimi 的 5s race 上移到基类默认实现。
 *
 * 这个 anchor 用一个**永不发 'error' 事件的假 proc**直接调 awaitSpawnError（通过
 * TestRunner 子类暴露 protected hook），断言它在有限时间内 resolve(undefined)——
 * 真红 = 当前基类无限等待，测试会超时失败（vitest 默认 5s test timeout）。
 */
import { describe, it, expect, vi } from 'vitest';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { AgentEvent, SpawnOptions } from '../../../src/runner/types.js';
import { EventEmitter } from 'node:events';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

class TestRunner extends SpawningRunner {
  constructor() {
    super({
      binary: 'fake-agent',
      pidDir: '/tmp/p2-11-test',
      workspace: 'test',
      logTag: 'test-runner',
    });
  }
  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake'];
  }
  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    return null;
  }
  // Expose protected hook for testing.
  public callAwaitSpawnError(
    proc: import('node:child_process').ChildProcess,
  ): Promise<Error | undefined> {
    return this.awaitSpawnError(proc);
  }
}

describe('P2-11: SpawningRunner.awaitSpawnError finite timeout', () => {
  it('test_anchor_base_await_spawn_error_times_out_when_no_error_event', async () => {
    // A fake proc that NEVER emits 'error' — simulates silent spawn failure.
    const proc = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
    const runner = new TestRunner();

    // Must resolve (to undefined) within a finite bound, NOT hang forever.
    // Current base class: `proc.once('error', resolve)` → never resolves →
    // vitest test timeout (5s default) kills it = RED.
    const start = Date.now();
    const result = await runner.callAwaitSpawnError(proc);
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    // Bounded: must complete well under the test timeout. Use a generous 15s
    // ceiling (the race should be ~5s); the point is "not infinite".
    expect(elapsed).toBeLessThan(15000);
  }, 15000); // settle instead of the test harness killing it first. // Explicit test timeout > race timeout (5s) so the race can actually
});
