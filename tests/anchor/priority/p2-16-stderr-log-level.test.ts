/**
 * Anchor Test: P2-16 stderr 不应每 chunk 一条 error 级日志
 *
 * 背景（review.md P2-16）：spawning-runner 的 stderr handler 对每个 chunk
 * 都调 getLogger().error(...)。多数 agent CLI 把进度/告警/废弃提示写到
 * stderr（非真实错误），按 error 级每 chunk 记一条淹没真实错误日志、污染
 * 日志面板。错误语义已在 non-zero-exit 路径统一上报。
 *
 * 修复：降级为 warn（保留诊断，不污染 error 级）。
 *
 * 这个 anchor 让 mock proc 的 stderr 连发多个 chunk，直调 spawnChild 后断言
 * mockLogger.error 没有为 stderr chunk 被调用（应改走 warn）。真红 = 当前
 * 实现每 chunk 一条 error 日志。
 *
 * W1.1 备注：spawnChild 保留 stderr handler，本 anchor 直调 spawnChild 钉住
 * 其日志级别语义。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { SpawnOptions } from '../../../src/runner/types.js';
import { Readable } from 'node:stream';
import { createMockProc } from '../../../tests/lib/mock-process.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));
vi.mock('../../../src/platform/spawn.js', () => ({
  spawnProcess: vi.fn(),
  mergeProcessEnv: vi.fn((base, overrides) => ({ ...base, ...overrides })),
  isWindowsCommandNotFoundLine: vi.fn(() => false),
}));
import { spawnProcess as spawn } from '../../../src/platform/spawn.js';

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
  // Expose protected hook for testing.
  public callSpawnChild(opts: SpawnOptions): Promise<import('node:child_process').ChildProcess> {
    return this.spawnChild(opts);
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
      once: vi.fn(),
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner();
    await runner.callSpawnChild({ cwd: '/tmp/p2-16' });

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
    const warnCalls = mockLogger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('[test-runner stderr]'),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(3);
  });
});
