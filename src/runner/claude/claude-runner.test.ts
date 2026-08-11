import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from './index.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let savedPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runner-test-'));
  savedPath = prependPath(tmpDir);
});

afterEach(() => {
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Create a mock claude script that outputs JSONL.
function createMockClaude(script: string): string {
  return writeMockBin(tmpDir, 'claude', `#!/bin/bash\n${script}`);
}

describe('ClaudeRunner', () => {
  it('test_anchor_nonzero_exit_rejects_with_stderr_summary', async () => {
    createMockClaude(`
      echo 'authentication failed' >&2
      exit 7
    `);
    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });

    // run() yields a unified result event on non-zero exit instead of
    // throwing. The bridge accepts both thrown errors and yielded error-result
    // events; the latter carries richer diagnostic info (exit code + stderr
    // tail) without leaking pid files.
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);
    const result = resultEvents[0] as { subtype?: string; errorMessage?: string };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toMatch(/code=7/);
    expect(result.errorMessage).toContain('authentication failed');
  });

  it('spawns claude with correct arguments', async () => {
    createMockClaude(`
      echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
      echo '{"type":"result","subtype":"success","session_id":"s1"}'
    `);

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // run() ALWAYS yields a final buildResultEvent after the stream ends
    // (even on code=0). So the mock's own success-result is now followed
    // by the base class's synthesized success-result. Both are valid result
    // events; we assert the system event arrived and at least one result
    // arrived.
    expect(events[0].type).toBe('system');
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    expect(runner.isRunning).toBe(false);
  });

  it('includes --resume when sessionId provided', async () => {
    createMockClaude(`
      echo "$@" > ${tmpDir}/args.txt
      echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
      echo '{"type":"result","subtype":"success","session_id":"s1"}'
    `);

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp', sessionId: 's1' })) {
      events.push(event);
    }

    const args = fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8');
    expect(args).toContain('--resume');
    expect(args).toContain('s1');
  });

  it('throws if already running', async () => {
    // Mock outputs init then blocks. `exec sleep` replaces the bash process
    // so SIGTERM from stop() kills a single process and closes stdout; a
    // bare `sleep` would be a child holding the fd open, hanging the consumer.
    createMockClaude(`
      echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
      exec sleep 10
    `);

    const runner = new ClaudeRunner({
      workspace: 'test',

      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 200));

    await expect(
      (async () => {
        for await (const _ of runner.run('hello2', { cwd: '/tmp' })) {
          // consume
        }
      })(),
    ).rejects.toThrow('already running');

    await runner.stop();
    await runPromise;
  });

  it('stop kills the process', async () => {
    createMockClaude(`
      echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
      exec sleep 60
    `);

    const runner = new ClaudeRunner({
      workspace: 'test',

      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    // Wait for process to start
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.isRunning).toBe(true);

    await runner.stop();
    expect(runner.isRunning).toBe(false);

    await runPromise;
  });

  it('cleans up pid file after process exits', async () => {
    createMockClaude(`
      echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
      echo '{"type":"result","subtype":"success","session_id":"s1"}'
    `);

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    const pidFile = path.join(tmpDir, 'claude-test.pid');

    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('killOrphan kills leftover process', async () => {
    // Create a long-running process that IS this runner's orphan (identity
    // matches runner.binary). P1-10: killOrphan must verify the pid's process
    // identity before killing — an unrelated process (e.g. recycled pid)
    // must never be SIGTERM'd. The mock is spawned detached so it is the
    // leader of its own process group (group-kill semantics).
    const mockBin = path.join(tmpDir, 'mock-claude');
    fs.writeFileSync(mockBin, '#!/bin/bash\nsleep 60\n', { mode: 0o755 });
    const orphan = spawn(mockBin, [], { detached: true });
    const pid = orphan.pid!;

    const pidFile = path.join(tmpDir, 'claude-test.pid');
    fs.writeFileSync(pidFile, String(pid), 'utf-8');

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    runner.killOrphan();

    // Wait for process to actually exit (SIGTERM takes a moment)
    const exitPromise = new Promise<void>((resolve) => {
      orphan.on('exit', () => resolve());
    });
    await exitPromise;

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('killOrphan handles missing pid file gracefully', () => {
    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    expect(() => runner.killOrphan()).not.toThrow();
  });

  it('killOrphan handles stale pid file (process gone)', () => {
    const pidFile = path.join(tmpDir, 'claude-test.pid');
    fs.writeFileSync(pidFile, '999999999', 'utf-8');

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    runner.killOrphan();

    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

// --- Logging probes (regression: 2026-06-20 spawn logs missing) ---

function callsAt(
  level: 'debug' | 'info' | 'warn' | 'error',
  predicate: (first: unknown) => boolean,
): unknown[][] {
  return mockLogger[level].mock.calls.filter((call) => predicate(call[0]));
}

describe('ClaudeRunner logging probes', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('logs spawn + pid file write on happy path (regression: these were missing in production log)', async () => {
    createMockClaude(`
      echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
      echo '{"type":"result","subtype":"success","session_id":"s1"}'
    `);

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    for await (const _ of runner.run('hello', { cwd: '/tmp', sessionId: 's1' })) {
      // consume
    }

    // 1. Spawn log: includes pid, binary, cwd, sessionId
    const spawnLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[claude-runner] spawn pid='),
    );
    expect(spawnLogs.length).toBe(1);
    const spawnMsg = String(spawnLogs[0]?.[0]);
    expect(spawnMsg).toContain('binary=claude');
    expect(spawnMsg).toContain('cwd=/tmp');
    expect(spawnMsg).toContain('sessionId=s1');

    // 2. Pid file write log
    const pidLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[claude-runner] wrote pid file'),
    );
    expect(pidLogs.length).toBe(1);
    expect(String(pidLogs[0]?.[0])).toContain('.pid=');

    // No error logs on happy path
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('logs non-zero exit with stderr summary before throwing', async () => {
    createMockClaude(`
      echo 'authentication failed' >&2
      exit 7
    `);

    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    // run() yields a result event instead of throwing. Consume the generator
    // to completion; the non-zero-exit log is emitted from run()'s body
    // before the result event is yielded.
    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    const exitLogs = callsAt(
      'error',
      (m) => typeof m === 'string' && m.includes('[claude-runner] non-zero exit'),
    );
    expect(exitLogs.length).toBe(1);
    expect(String(exitLogs[0]?.[0])).toContain('code=7');
    expect(String(exitLogs[0]?.[0])).toContain('authentication failed');
  });

  it('logs SIGTERM when stop() is called on a running process', async () => {
    createMockClaude('exec sleep 60');
    const runner = new ClaudeRunner({
      workspace: 'test',

      pidDir: tmpDir,
      stopGraceMs: 100,
    });

    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    // Wait for process to actually start
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.isRunning).toBe(true);

    await runner.stop();

    // Check ProcessStopper logs (now delegate stop logic)
    const sigtermLogs = callsAt(
      'debug',
      (m) => typeof m === 'string' && m.includes('[process-stopper] sending SIGTERM'),
    );
    expect(sigtermLogs.length).toBe(1);

    await runPromise.catch(() => {});
  });

  it('fires spawn-stage stalled WARN when no stdout arrives within the heartbeat window', async () => {
    // 确定性版本：fake timers 只冻结 setTimeout/clearTimeout（心跳唯一依赖），
    // 真实子进程 I/O 照常推进。spawn + pid 文件 + heartbeat.start() 在生成器
    // 首个挂起点之前全部同步执行，因此 flush 微任务后 pid 必已就位；随后
    // 手动推进时钟越过窗口即触发 WARN——不依赖真实墙钟上 spawn 快慢。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Mock claude: spawns, never emits stdout (simulates OAuth hang / stdio fd misroute)
      createMockClaude(`exec sleep 60`);

      const runner = new ClaudeRunner({
        workspace: 'test',

        pidDir: tmpDir,
        spawnHeartbeatMs: 50,
      });

      const runPromise = (async () => {
        for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
          // consume
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      expect(runner.pid).toBeGreaterThan(0);

      // Advance past the heartbeat window — deterministic, no wall-clock wait.
      await vi.advanceTimersByTimeAsync(50);

      const stalled = callsAt(
        'warn',
        (m) => typeof m === 'string' && m.includes('[claude-runner] spawn stage stalled'),
      );
      expect(stalled.length).toBeGreaterThanOrEqual(1);
      expect(String(stalled[0]?.[0])).toContain('pid=');

      // immediate stop 不经过 grace setTimeout，fake timers 下安全
      await runner.stop({ immediate: true });
      await runPromise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT fire spawn-stage stalled when first stdout arrives in time', async () => {
    // 确定性版本：心跳定时器被冻结，等真实 stdout I/O 送达首个事件后再推进
    // 时钟——首个事件到达时 notifyStdout() 必然已清掉定时器，推进任意远超窗口
    // 的时间都不会误报 WARN。断言与真实进程/真实时钟的先后顺序彻底解耦。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Mock: emit one stdout line immediately, then sleep
      createMockClaude(`
        echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
        exec sleep 60
      `);

      const runner = new ClaudeRunner({
        workspace: 'test',

        pidDir: tmpDir,
        spawnHeartbeatMs: 50,
      });

      let resolveFirstEvent!: () => void;
      const firstEvent = new Promise<void>((resolve) => {
        resolveFirstEvent = resolve;
      });
      const runPromise = (async () => {
        for await (const e of runner.run('hello', { cwd: '/tmp' })) {
          if (e.type === 'system') {
            resolveFirstEvent();
            // 不 return：保持生成器存活，避免 run() 的 finally 提前 clear()
            // 心跳定时器，否则「notifyStdout 未接线」的回归会被 teardown 掩盖。
          }
        }
      })();

      await firstEvent;

      // stdout observed → timer cleared; advancing far past the window must
      // produce no WARN.
      await vi.advanceTimersByTimeAsync(10_000);

      const stalled = callsAt(
        'warn',
        (m) => typeof m === 'string' && m.includes('[claude-runner] spawn stage stalled'),
      );
      expect(stalled.length).toBe(0);

      await runner.stop({ immediate: true });
      await runPromise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop({ immediate: true }) sends SIGTERM and SIGKILL back-to-back without waiting grace', async () => {
    // Mock that ignores SIGTERM — only SIGKILL can kill it. With a 30s grace
    // window, stop() without immediate would wait 30s. With immediate, must
    // resolve well under that.
    createMockClaude(`
      trap '' TERM
      exec sleep 60
    `);
    const runner = new ClaudeRunner({
      workspace: 'test',

      pidDir: tmpDir,
      stopGraceMs: 30_000,
    });

    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.isRunning).toBe(true);

    const t0 = Date.now();
    await runner.stop({ immediate: true });
    const elapsed = Date.now() - t0;

    // Must complete in well under the grace window
    expect(elapsed).toBeLessThan(5_000);
    expect(runner.isRunning).toBe(false);

    await runPromise.catch(() => {});

    // Confirm both signals were sent
    const sigtermLogs = callsAt(
      'debug',
      (m) => typeof m === 'string' && m.includes('sending SIGTERM'),
    );
    expect(sigtermLogs.length).toBeGreaterThanOrEqual(1);
    expect(String(sigtermLogs[sigtermLogs.length - 1]?.[0])).toContain('immediate=true');
  });
});

// ClaudeRunner implements AgentRunner (kind/sessionReader).
describe('ClaudeRunner AgentRunner adaptation', () => {
  it('exposes kind="claude"', () => {
    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    expect(runner.kind).toBe('claude');
  });

  it('provides a default ClaudeSessionReader when none is injected', () => {
    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
    // The default reader is a ClaudeSessionReader; we only verify it exists
    // and has the expected method shape (structural AgentSessionReader).
    expect(runner.sessionReader).toBeDefined();
    expect(typeof runner.sessionReader.listSessions).toBe('function');
    expect(typeof runner.sessionReader.getNewestSession).toBe('function');
    expect(typeof runner.sessionReader.readSessionContent).toBe('function');
    expect(typeof runner.sessionReader.isSessionActive).toBe('function');
  });
});

it('yields_error_event_when_binary_not_found', async () => {
  // SpawningRunner hard-codes the 'claude' binary name; simulate ENOENT by
  // pointing PATH at a directory that contains no claude executable.
  const saved = process.env.PATH;
  process.env.PATH = path.join(tmpDir, 'no-bin');
  try {
    const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });

    const events = [];
    for await (const event of runner.run('hello', { cwd: tmpDir })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    const result = events[0];
    if (result.type !== 'result') throw new Error('expected result event');
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toMatch(/不可用|not found|ENOENT/i);
    expect(runner.isRunning).toBe(false);
  } finally {
    restorePath(saved);
  }
});
