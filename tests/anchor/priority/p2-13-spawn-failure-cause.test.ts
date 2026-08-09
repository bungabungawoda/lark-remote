/**
 * Anchor Test: P2-13 spawn 失败 errorMessage 必须包含真实原因
 *
 * 背景（review.md P2-13）：任何 spawn 失败（EMFILE、ENOMEM、EACCES、cwd 不存在）
 * 都 yield 固定文案「命令不可用（未找到或不可执行）」，对非 ENOENT 的错误类型
 * 严重误导——用户以为没装二进制，实际可能是 fd 耗尽或 cwd 无效。
 *
 * 修复：spawnErr 非空时把 spawnErr.message 拼进 errorMessage。
 *
 * 这个 anchor 让 awaitSpawnError 返回一个 EMFILE 错误（非 ENOENT），断言
 * errorMessage 含真实原因文本。真红 = 当前固定文案不含 "EMFILE"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { AgentEvent, SpawnOptions } from '../../../src/runner/types.js';
import type { ChildProcess } from 'node:child_process';

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
      binary: 'fake-binary',
      pidDir: '/tmp/p2-13-test',
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
    const mockProc = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stdout: null,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error(realCause)), 5);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    } as unknown as ChildProcess;

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner();
    const events: AgentEvent[] = [];
    for await (const event of runner.run('hi', { cwd: '/tmp/p2-13' })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      { subtype?: string; errorMessage?: string } | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe('error');
    // RED today: errorMessage is the fixed "命令不可用（未找到或不可执行）..."
    // text with NO mention of EMFILE. GREEN: errorMessage includes the real
    // cause text ("EMFILE" / "too many open files") so the user is not
    // misdiagnosed into reinstalling the binary when the real problem is fd
    // exhaustion / permissions / bad cwd.
    expect(result!.errorMessage).toMatch(/EMFILE|too many open files/);
  });
});
