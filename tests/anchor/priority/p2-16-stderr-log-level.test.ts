/**
 * Anchor Test: P2-16 stderr 不应每 chunk 一条 error 级日志
 *
 * 背景（review.md P2-16）：spawning-runner 的 stderr handler 对每个 chunk
 * 都调 getLogger().error(...)。多数 agent CLI 把进度/告警/废弃提示写到
 * stderr（非真实错误），按 error 级每 chunk 记一条淹没真实错误日志、污染
 * 日志面板。错误语义已在 non-zero-exit 路径统一上报（line ~526）。
 *
 * 修复：降级为 warn（保留诊断，不污染 error 级）。
 *
 * 这个 anchor 让 fake proc 的 stderr 连发多个 chunk，断言 mockLogger.error
 * 没有为 stderr chunk 被调用（应改走 warn）。真红 = 当前实现每 chunk 一条
 * error 日志。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { AgentEvent, SpawnOptions } from '../../../src/runner/types.js';
import { createMockProc } from '../../../tests/lib/mock-process.js';

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
    super({
      pidDir: '/tmp/p2-16-test',
      workspace: 'test',
      logTag: 'test-runner',
    });
    this.binary = 'fake-binary';
  }
  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake'];
  }
  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    return null;
  }
}

describe('P2-16: stderr is not logged at error level per chunk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_stderr_chunk_not_logged_as_error', async () => {
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });
    // Make stderr behave as a readable we can push to.
    const stderrReadable = new Readable({ read() {} });

    const mockProc = createMockProc({
      pid: 77001,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: stderrReadable,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') setTimeout(() => cb(0, null), 10);
      }),
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner();
    const runPromise = runner.run('hi', { cwd: '/tmp/p2-16' });
    // Drain the generator.
    for await (const _ of await runPromise) {
      void _;
    }

    // Emit several stderr chunks (agent progress/warnings, not real errors).
    stderrReadable.push(Buffer.from('warning: experimental feature\n'));
    stderrReadable.push(Buffer.from('progress: 50%\n'));
    stderrReadable.push(Buffer.from('deprecation: use --new-flag\n'));
    stderrReadable.push(null);

    // Allow handlers to flush.
    await new Promise((r) => setTimeout(r, 30));

    const errorCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes('[test-runner stderr]'),
    );

    // GREEN: stderr chunks are logged at warn level, NOT error. RED today:
    // each chunk produces one error-level log line.
    expect(errorCalls).toHaveLength(0);
  });
});
