/**
 * Anchor tests for SpawningRunner (spawn lifecycle base).
 *
 * W1.1 收窄后基类只承载 spawn 生命周期（spawnChild lead-in / stop /
 * killOrphan / 退出分发器 / 心跳），不再有 run() 主循环与 buildResultEvent
 * ——结果事件语义由唯一生产子类 ClaudeSession 自行构建（见
 * src/runner/claude/claude-runner.test.ts 的 nonzero-exit / 嗅探定性用例）。
 *
 * Spawn 编排语义钉（pid 文件生命周期、stderr 4000 截尾、ENOENT 文案、
 * 心跳 start/notify、win32 嗅探置位）经最小 spawnChild harness 驱动。
 */
import { describe, it, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { currentPlatform, isWin32 } from '../../../src/platform/select.js';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { SpawnOptions } from '../../../src/runner/types.js';
import type { SpawnHeartbeat } from '../../../src/runner/common/spawn-heartbeat.js';
import type { Terminator } from '../../../src/platform/terminator.js';
import { agentStopperRegistry } from '../../../src/platform/agent-stopper.js';
import { createMockProc } from '../../../tests/lib/mock-process.js';
import { mockLogger } from '../../lib/logger-mock.js';

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

vi.mock('../../../src/platform/spawn.js', () => ({
  useDetachedProcessGroup: vi.fn(() => true),
  spawnProcess: vi.fn(),
  mergeProcessEnv: vi.fn((base, overrides) => ({ ...base, ...overrides })),
  isWindowsCommandNotFoundLine: vi.fn(() => false),
}));

// node:child_process 的 mock 面必须是**宿主无关的**：win32 宿主上 createTerminator 选
// terminator-win32，它在构造期就取 `node:child_process.spawn` 作为 taskkill 的默认实现
// （posix 实现只用 process.kill，从不碰这些导出）；少给一个导出，vitest 的 mock Proxy
// 读取时直接抛「No "spawn" export is defined」，于是同一份用例在 macOS 绿、Windows 红。
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawnProcess as spawn } from '../../../src/platform/spawn.js';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// SpawnChild harness：最小子类，只实现 buildArgv，公开 spawnChild 供直调
// ---------------------------------------------------------------------------

class SpawnChildHarness extends SpawningRunner {
  constructor(opts: { binary?: string; pidDir?: string; agent?: string } = {}) {
    super({ workspace: 'test', pidDir: opts.pidDir, agent: opts.agent });
    this.binary = opts.binary ?? 'testbin';
  }

  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake-flag', 'marker'];
  }

  // ── 类型化测试访问器 ────────────────────────────────────────────
  async callSpawnChild(opts: SpawnOptions): Promise<ChildProcess> {
    return this.spawnChild(opts);
  }

  get testBinary(): string {
    return this.binary;
  }

  get testPidFilePath(): string {
    return this.pidFilePath;
  }

  get testSpawnHeartbeat(): SpawnHeartbeat {
    return this.spawnHeartbeat;
  }

  get testTerminator(): Terminator {
    return this.terminator;
  }

  get testCurrentProcess(): ChildProcess | null {
    return this.currentProcess;
  }

  set testCurrentProcess(proc: ChildProcess | null) {
    this.currentProcess = proc;
  }

  get testStoppedByUser(): boolean {
    return this.stoppedByUser;
  }

  get testSpawnStderr(): string {
    return this.spawnStderr;
  }

  get testCommandNotFoundSeen(): boolean {
    return this.commandNotFoundSeen;
  }

  createTestStreamReader(stdout: Readable): AsyncGenerator<unknown> {
    return this.createStreamReader(stdout);
  }

  /** 清理 spawnChild 副作用（心跳 + pid 文件），供用例收尾。 */
  async cleanupSpawnSideEffects(): Promise<void> {
    this.spawnHeartbeat.clear();
    await this.stop({ immediate: true });
  }
}

/**
 * 构造可被 vi.mocked(spawn).mockReturnValue 接受的 ChildProcess mock。
 *
 * 统一收敛到 tests/lib 的 createMockProc（无 cast）。
 */
function makeMockProc(
  opts: {
    pid?: number;
    stdout?: Readable | null;
    stderr?: unknown;
    close?: (event: string, cb: (...args: unknown[]) => void) => void;
  } = {},
): ReturnType<typeof spawn> {
  const stdout =
    opts.stdout === undefined
      ? new Readable({
          read() {
            this.push(null);
          },
        })
      : opts.stdout;
  return createMockProc({
    // 显式传 pid: undefined 表示「spawn 后拿不到 pid」（ENOENT 路径），
    // 不能 fallback 到默认 pid，否则 runner 走正常路径读 stdout 崩溃。
    pid: 'pid' in opts ? opts.pid : 99999,
    exitCode: null,
    signalCode: null,
    stdout,
    stderr: opts.stderr ?? { on: vi.fn(), destroy: vi.fn() },
    kill: vi.fn(),
    once: vi.fn(opts.close ?? (() => {})),
  });
}

// ---------------------------------------------------------------------------
// spawnChild spawn orchestration
// ---------------------------------------------------------------------------

describe('SpawningRunner.spawnChild() spawn orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of ['/tmp/spawning-runner-anchor-test', '/tmp/spawning-runner-anchor-test-r2']) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* dir may not exist */
      }
    }
  });

  it('test_anchor_spawning_runner_spawns_with_build_argv', async () => {
    const mockProc = makeMockProc({ pid: 99001 });
    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    await runner.callSpawnChild({ cwd: '/tmp/fake' });
    await runner.cleanupSpawnSideEffects();

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    const expectedBinary = runner.testBinary;
    expect(call[0]).toBe(expectedBinary);
    expect(call[1]).toEqual(['--fake-flag', 'marker']);
    expect(call[2]).toMatchObject({
      cwd: '/tmp/fake',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  });

  it('test_anchor_spawning_runner_writes_pid_file_after_spawn', async () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r2';
    fs.mkdirSync(pidDir, { recursive: true });
    const runner = new SpawnChildHarness({ binary: 'fake-binary', pidDir });
    const pidFilePath = runner.testPidFilePath;
    fs.rmSync(pidFilePath, { force: true });

    const mockProc = makeMockProc({ pid: 88888 });
    vi.mocked(spawn).mockReturnValue(mockProc);

    await runner.callSpawnChild({ cwd: '/tmp/fake' });

    expect(fs.existsSync(pidFilePath)).toBe(true);
    expect(fs.readFileSync(pidFilePath, 'utf-8')).toBe('88888');
    await runner.cleanupSpawnSideEffects();
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });

  it('test_anchor_spawning_runner_throws_spawn_child_error_on_pid_undefined', async () => {
    const mockProc = makeMockProc({
      pid: undefined,
      stdout: null,
      close: (event, cb) => {
        if (event === 'error') setTimeout(() => cb(new Error('spawn ENOENT')), 10);
      },
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    // P2-13: spawn 失败必须携带真实原因（此处 ENOENT），而非只给固定文案。
    await expect(runner.callSpawnChild({ cwd: '/tmp/fake' })).rejects.toThrow(
      /不可用.*spawn ENOENT/s,
    );
    expect(runner.testCurrentProcess).toBe(null);
  });

  it('test_anchor_spawning_runner_starts_heartbeat_after_spawn', async () => {
    const mockProc = makeMockProc({ pid: 66666 });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    const startSpy = vi.spyOn(runner.testSpawnHeartbeat, 'start');

    await runner.callSpawnChild({ cwd: '/tmp/r4' });

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy.mock.calls[0][0]).toEqual({
      pid: 66666,
      binary: runner.testBinary,
      cwd: '/tmp/r4',
    });
    await runner.cleanupSpawnSideEffects();
  });

  it('test_anchor_spawning_runner_notifies_heartbeat_on_first_stdout', async () => {
    // 单行后立即 EOF：read() 里不能无条件 push（会导致流无限生成挂死测试）。
    const stdout = new Readable({
      read() {
        this.push('{"type":"system","subtype":"init","session_id":"x","cwd":"/tmp","model":"m"}\n');
        this.push(null);
      },
    });

    const mockProc = makeMockProc({ pid: 55555, stdout });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    const notifySpy = vi.spyOn(runner.testSpawnHeartbeat, 'notifyStdout');

    await runner.callSpawnChild({ cwd: '/tmp/r5' });
    // stdout 'data' 事件异步触发；等待一拍让 once('data') 回调执行。
    await new Promise((r) => setTimeout(r, 10));

    expect(notifySpy).toHaveBeenCalledOnce();
    await runner.cleanupSpawnSideEffects();
  });

  it('test_anchor_spawning_runner_stderr_capped_at_4000_keeps_tail', async () => {
    const stderr = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from('H'.repeat(4500)));
          cb(Buffer.from('T'.repeat(500)));
        }
      }),
      destroy: vi.fn(),
    };

    const mockProc = makeMockProc({ pid: 22222, stderr });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    await runner.callSpawnChild({ cwd: '/tmp/r8' });

    // 4000 字节截尾：只保留尾部，前段 4500 个 H 不得留存。
    const stderrAccumulated = runner.testSpawnStderr;
    expect(stderrAccumulated).toContain('T'.repeat(500));
    expect(stderrAccumulated).not.toContain('H'.repeat(4500));
    expect(stderrAccumulated).not.toContain('H'.repeat(4000));
    await runner.cleanupSpawnSideEffects();
  });

  it('test_anchor_spawning_runner_sniff_line_sets_command_not_found_seen', async () => {
    const { isWindowsCommandNotFoundLine } = await import('../../../src/platform/spawn.js');
    const sniffMock = vi.mocked(isWindowsCommandNotFoundLine);
    sniffMock.mockImplementation((line: string) => line.includes('is not recognized'));

    const stderr = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from("'fake-binary' is not recognized as an internal or external command."));
        }
      }),
      destroy: vi.fn(),
    };

    const mockProc = makeMockProc({ pid: 11111, stderr });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    await runner.callSpawnChild({ cwd: '/tmp/fake' });

    // 嗅探命中只置嫌疑标记（双条件之一），不定性不杀进程（防误杀）。
    expect(runner.testCommandNotFoundSeen).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('command not found suspected'),
    );
    sniffMock.mockRestore();
    await runner.cleanupSpawnSideEffects();
  });
});

// ---------------------------------------------------------------------------
// P1-4 A2: createStreamReader enables backpressure by default
// ---------------------------------------------------------------------------

describe('P1-4 A2: createStreamReader enables backpressure by default', () => {
  test('test_anchor_create_stream_reader_default_backpressure_enabled', async () => {
    const readable = new Readable({ read() {} });
    const pauseCalls: number[] = [];
    const origPause = readable.pause.bind(readable);
    readable.pause = function () {
      pauseCalls.push(1);
      return origPause();
    };

    const runner = new SpawnChildHarness({ binary: 'echo' });
    const stream = runner.createTestStreamReader(readable);

    for (let i = 0; i < 1000; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }
    readable.push(null);

    for await (const _ of stream) {
      // drain all
    }

    expect(pauseCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SpawningRunner stoppedByUser state
// ---------------------------------------------------------------------------

describe('SpawningRunner stoppedByUser state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_anchor_stopped_by_user_initially_false', () => {
    const runner = new SpawnChildHarness({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });
    expect(runner.testStoppedByUser).toBe(false);
  });

  it('test_anchor_stop_sets_stopped_by_user_true_when_process_running', async () => {
    const runner = new SpawnChildHarness({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });

    const terminatorStopSpy = vi
      .spyOn(runner.testTerminator, 'stop')
      .mockResolvedValue({ requested: true, via: 'cooperative' });

    const fakeProc = createMockProc({
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
    });
    runner.testCurrentProcess = fakeProc;

    expect(runner.isRunning).toBe(true);
    expect(runner.testStoppedByUser).toBe(false);

    await runner.stop({ immediate: true });

    expect(runner.testStoppedByUser).toBe(true);
    expect(terminatorStopSpy).toHaveBeenCalledOnce();
  });

  it('test_anchor_stop_does_not_set_stopped_by_user_when_no_process', async () => {
    const runner = new SpawnChildHarness({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });

    expect(runner.testCurrentProcess).toBe(null);
    expect(runner.isRunning).toBe(false);
    expect(runner.testStoppedByUser).toBe(false);

    await runner.stop();

    expect(runner.testStoppedByUser).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpawningRunner stop / killOrphan / isRunning
// ---------------------------------------------------------------------------

describe('SpawningRunner stop / killOrphan / isRunning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_anchor_spawning_runner_stop_delegates_to_terminator_with_immediate', async () => {
    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r11',
    });

    const terminatorStopSpy = vi
      .spyOn(runner.testTerminator, 'stop')
      .mockResolvedValue({ requested: true, via: 'cooperative' });

    const fakeProc = createMockProc({
      pid: 24680,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
    });
    runner.testCurrentProcess = fakeProc;

    expect(runner.isRunning).toBe(true);

    await runner.stop({ immediate: true });

    expect(terminatorStopSpy).toHaveBeenCalledOnce();
    expect(terminatorStopSpy.mock.calls[0][0]).toBe(fakeProc);
    expect(terminatorStopSpy.mock.calls[0][1]).toEqual({ immediate: true });
  });

  it.skipIf(isWin32(currentPlatform))(
    'test_anchor_spawning_runner_kill_orphan_reads_pid_sends_sigterm_cleans_file',
    () => {
      const pidDir = '/tmp/spawning-runner-anchor-test-r12';
      fs.mkdirSync(pidDir, { recursive: true });

      const runner = new SpawnChildHarness({ binary: 'fake-binary', pidDir });

      const pidFilePath = runner.testPidFilePath;
      fs.rmSync(pidFilePath, { force: true });
      fs.writeFileSync(pidFilePath, '13579', 'utf-8');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(fs.existsSync(pidFilePath)).toBe(true);

      vi.mocked(execFileSync).mockReturnValue('fake-binary --some-flag');

      try {
        runner.killOrphan();

        expect(killSpy).toHaveBeenCalledWith(-13579, 'SIGTERM');
        expect(fs.existsSync(pidFilePath)).toBe(false);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it('test_anchor_spawning_runner_kill_orphan_silent_when_no_pid_file', () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r13';
    fs.mkdirSync(pidDir, { recursive: true });

    const runner = new SpawnChildHarness({ binary: 'fake-binary', pidDir });

    const pidFilePath = runner.testPidFilePath;

    fs.rmSync(pidFilePath, { force: true });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(fs.existsSync(pidFilePath)).toBe(false);

    try {
      runner.killOrphan();

      expect(fs.existsSync(pidFilePath)).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('test_anchor_spawning_runner_kill_orphan_cleans_file_and_returns_on_non_numeric_pid', () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r14';
    fs.mkdirSync(pidDir, { recursive: true });

    const runner = new SpawnChildHarness({ binary: 'fake-binary', pidDir });

    const pidFilePath = runner.testPidFilePath;
    fs.rmSync(pidFilePath, { force: true });
    fs.writeFileSync(pidFilePath, 'not-a-number', 'utf-8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(fs.existsSync(pidFilePath)).toBe(true);

    try {
      runner.killOrphan();

      expect(fs.existsSync(pidFilePath)).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('test_anchor_spawning_runner_is_running_reflects_process_state', () => {
    const runner = new SpawnChildHarness({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r15',
    });

    expect(runner.isRunning).toBe(false);

    const mockProc = createMockProc({ pid: 12345, exitCode: null, signalCode: null });
    runner.testCurrentProcess = mockProc;

    expect(runner.isRunning).toBe(true);

    mockProc.exitCode = 0;
    expect(runner.isRunning).toBe(false);

    mockProc.exitCode = null;
    mockProc.signalCode = 'SIGTERM';
    expect(runner.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 协议停止通道登记（design §3.3）
// ---------------------------------------------------------------------------

describe('SpawningRunner 协议停止通道登记', () => {
  const PID_DIR = '/tmp/spawning-runner-anchor-test';

  beforeEach(() => vi.clearAllMocks());

  it('test_anchor_spawning_runner_registers_stdin_close_stop_channel', async () => {
    // win32 上没有可拦截的跨进程 SIGTERM：不登记通道，优雅段恒被判「无通道」
    // 后直接树杀（不报错、无信号可查）；登记了却语义不对，则白等满 grace。
    // 这里钉住：子进程挂了 stdin 管道 + 声明了 agent → 按 agent+pid 登记一条
    // 「关 stdin」通道，且 stop 后注销（不留死 pid 条目）。
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    const endSpy = vi.spyOn(stdin, 'end');
    const mockProc = createMockProc({ pid: 99001, stdin, stdout: null });
    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({
      binary: 'claude',
      pidDir: PID_DIR,
      agent: 'claude',
    });
    await runner.callSpawnChild({ cwd: '/tmp/fake' });

    const stopper = agentStopperRegistry.get('claude', 99001);
    expect(stopper).toBeDefined();

    // 通道语义 = 关 stdin（cc-connect 已验证 claude 关 stdin 后干净退出并跑 Stop hooks）
    await stopper!(createMockProc({ pid: 99001, stdin }));
    expect(endSpy).toHaveBeenCalled();

    await runner.cleanupSpawnSideEffects();
    expect(agentStopperRegistry.get('claude', 99001)).toBeUndefined();
  });

  it('test_anchor_spawning_runner_skips_channel_without_agent_key', async () => {
    // 未声明 agent（如 `!` bash）= 该 agent 没有协议通道：**不登记**，让
    // Terminator 显式走「无通道 → 跳过优雅段 + 直接树杀」，而不是塞一条空通道
    // 让优雅段空转到 grace 超时。
    const mockProc = createMockProc({
      pid: 99002,
      stdin: new Writable({ write: (_c, _e, cb) => cb() }),
      stdout: null,
    });
    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({ binary: 'claude', pidDir: PID_DIR });
    await runner.callSpawnChild({ cwd: '/tmp/fake' });

    expect(agentStopperRegistry.has('claude', 99002)).toBe(false);

    await runner.cleanupSpawnSideEffects();
  });

  it('test_anchor_spawning_runner_skips_channel_without_stdin_pipe', async () => {
    // 子进程没挂 stdin（getStdio 默认 'ignore'）：关 stdin 无从谈起，
    // 照登一条空通道只会把「跳过优雅段」变成「空转满 grace」。
    const mockProc = createMockProc({ pid: 99003, stdin: null, stdout: null });
    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new SpawnChildHarness({ binary: 'claude', pidDir: PID_DIR, agent: 'claude' });
    await runner.callSpawnChild({ cwd: '/tmp/fake' });

    expect(agentStopperRegistry.has('claude', 99003)).toBe(false);

    await runner.cleanupSpawnSideEffects();
  });
});
