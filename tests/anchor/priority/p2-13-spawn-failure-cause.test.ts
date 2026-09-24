/**
 * Anchor Test: P2-13 spawn 失败 errorMessage 必须包含真实原因
 *
 * 背景（review.md P2-13）：任何 spawn 失败（EMFILE、ENOMEM、EACCES、cwd 不存在）
 * 都 yield 固定文案「命令不可用（未找到或不可执行）」，对非 ENOENT 的错误类型
 * 严重误导——用户以为没装二进制，实际可能是 fd 耗尽或 cwd 无效。
 *
 * 修复：spawnErr 非空时把 spawnErr.message 拼进 errorMessage。
 *
 * 这个 anchor 让 awaitSpawnError 返回一个 EMFILE 错误（非 ENOENT），直调
 * spawnChild 断言 SpawnChildError 携带真实原因文本。守住的失败模式：固定文案不含
 * "EMFILE"。
 *
 * W1.1 备注：基类 run() 收窄后 spawn 失败的消费方是 ClaudeSession（捕获
 * SpawnChildError → authErrorEvent），本 anchor 直调 spawnChild 钉住基类
 * spawnChild 的错误文案语义。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { SpawnOptions } from '../../../src/runner/types.js';
import { PassThrough } from 'node:stream';
import { createMockProc } from '../../../tests/lib/mock-process.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);
vi.mock('../../../src/platform/spawn.js', () => ({
  useDetachedProcessGroup: vi.fn(() => true),
  spawnProcess: vi.fn(),
  mergeProcessEnv: vi.fn((base, overrides) => ({ ...base, ...overrides })),
  isWindowsCommandNotFoundLine: vi.fn(() => false),
}));
import { spawnProcess as spawn } from '../../../src/platform/spawn.js';

class TestRunner extends SpawningRunner {
  constructor() {
    super({
      pidDir: '/tmp/p2-13-test',
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

describe('P2-13: spawn failure errorMessage includes real cause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_spawn_failure_error_message_includes_real_cause', async () => {
    // A spawn failure where the underlying error is EMFILE (fd exhaustion),
    // NOT ENOENT (binary missing). The mock proc has pid===undefined and
    // emits 'error' with a real cause the runner must surface.
    const realCause = 'spawn EMFILE: too many open files';
    const mockProc = createMockProc({
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stderr: new PassThrough(),
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error(realCause)), 5);
        }
      }),
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner();

    // RED today: errorMessage is the fixed "命令不可用（未找到或不可执行）..."
    // text with NO mention of EMFILE. GREEN: SpawnChildError message includes
    // the real cause text ("EMFILE" / "too many open files") so the user is
    // not misdiagnosed into reinstalling the binary when the real problem is
    // fd exhaustion / permissions / bad cwd.
    await expect(runner.callSpawnChild({ cwd: '/tmp/p2-13' })).rejects.toThrow(
      /EMFILE|too many open files/,
    );
  });
});
