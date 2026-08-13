import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KimiRunner } from './runner.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-kimi-runner-test-'));
  savedPath = prependPath(tmpDir);
});

afterEach(() => {
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createMockKimi(script: string): string {
  return writeMockBin(tmpDir, 'kimi', `#!/bin/bash\n${script}`);
}

// --- Constructor & defaults ---

describe('KimiRunner constructor', () => {
  it('defaults model to kimi-code/k3 and thinkingEffort to max', () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    const status = runner.getStatusInfo();
    expect(status.kind).toBe('kimi');
    expect(status.model).toBe('kimi-code/k3');
    expect(status.reasoning).toBe('max');
  });

  it('accepts custom model and thinkingEffort', () => {
    const runner = new KimiRunner({
      workspace: 'test',
      pidDir: tmpDir,
      model: 'kimi-code/k4',
      thinkingEffort: 'low',
    });
    const status = runner.getStatusInfo();
    expect(status.model).toBe('kimi-code/k4');
    expect(status.reasoning).toBe('low');
  });

  it('accepts custom completionTimeoutMs', () => {
    const runner = new KimiRunner({
      workspace: 'test',
      pidDir: tmpDir,
      completionTimeoutMs: 1000,
    });
    // awaitCompletion uses the timeout. Just ensure construction doesn't throw.
    expect(runner).toBeDefined();
  });

  it('provides a default sessionReader when none is injected', () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    expect(runner.sessionReader).toBeDefined();
    expect(typeof runner.sessionReader.listSessions).toBe('function');
    expect(typeof runner.sessionReader.getNewestSession).toBe('function');
    expect(typeof runner.sessionReader.readSessionContent).toBe('function');
    expect(typeof runner.sessionReader.isSessionActive).toBe('function');
  });

  it('exposes kind="kimi"', () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    expect(runner.kind).toBe('kimi');
  });
});

// --- pid getter ---

describe('KimiRunner.pid', () => {
  it('returns undefined when no process has been spawned', () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    expect(runner.pid).toBeUndefined();
  });

  it('returns the process pid when a process is running', async () => {
    createMockKimi(`
      echo '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"test","content":""}'
      exec sleep 10
    `);
    const runner = new KimiRunner({
      workspace: 'test',
      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    await new Promise((r) => setTimeout(r, 200));
    expect(runner.pid).toBeDefined();
    expect(typeof runner.pid).toBe('number');
    expect(runner.pid).toBeGreaterThan(0);

    await runner.stop();
    await runPromise.catch(() => {});
  });
});

// --- getStatusInfo ---

describe('KimiRunner.getStatusInfo', () => {
  it('returns kind, model, and reasoning', () => {
    const runner = new KimiRunner({
      workspace: 'test',
      pidDir: tmpDir,
      model: 'kimi-code/k3',
      thinkingEffort: 'max',
    });
    const info = runner.getStatusInfo();
    expect(info).toEqual({
      kind: 'kimi',
      model: 'kimi-code/k3',
      reasoning: 'max',
    });
  });
});

// --- buildArgv (tested via run() with mock binary that captures args) ---

describe('KimiRunner buildArgv', () => {
  it('includes -p <message> --output-format stream-json -m <model>', async () => {
    createMockKimi(`
      echo "$@" > ${tmpDir}/args.txt
      echo '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"test","content":""}'
    `);

    const runner = new KimiRunner({
      workspace: 'test',
      pidDir: tmpDir,
      model: 'kimi-code/k3',
    });
    for await (const _ of runner.run('hello world', { cwd: '/tmp' })) {
      // consume
    }

    const args = fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8');
    expect(args).toContain('-p');
    expect(args).toContain('hello world');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('-m');
    expect(args).toContain('kimi-code/k3');
  });

  it('includes -r <sessionId> when sessionId is provided', async () => {
    createMockKimi(`
      echo "$@" > ${tmpDir}/args.txt
      echo '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"test","content":""}'
    `);

    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    for await (const _ of runner.run('hello', { cwd: '/tmp', sessionId: 'sess-42' })) {
      // consume
    }

    const args = fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8');
    expect(args).toContain('-r');
    expect(args).toContain('sess-42');
  });

  it('omits -r when no sessionId is provided', async () => {
    createMockKimi(`
      echo "$@" > ${tmpDir}/args.txt
      echo '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"test","content":""}'
    `);

    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    const args = fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8');
    expect(args).not.toContain('-r');
  });
});

// --- awaitCompletion ---

describe('KimiRunner awaitCompletion', () => {
  it('returns immediately when process has already exited (exitCode !== null)', async () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir, completionTimeoutMs: 5000 });
    // Simulate already-exited process: exitCode=0, signalCode=null
    const proc = {
      pid: 12345,
      exitCode: 0,
      signalCode: null,
    } as unknown as ChildProcess;

    // awaitCompletion is protected; call it indirectly through a trick:
    // We access it via the instance using bracket notation.
    const result = await (runner as any).awaitCompletion(proc, new Promise(() => {}));
    expect(result).toEqual({ code: 0, signal: null });
  });

  it('returns immediately when process has signalCode !== null', async () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir, completionTimeoutMs: 5000 });
    const proc = {
      pid: 12345,
      exitCode: null,
      signalCode: 'SIGTERM',
    } as unknown as ChildProcess;

    const result = await (runner as any).awaitCompletion(proc, new Promise(() => {}));
    expect(result).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('returns completion result when process exits before timeout', async () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir, completionTimeoutMs: 5000 });
    const proc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess;

    // Completion promise resolves quickly
    const completion = Promise.resolve({ code: 0, signal: null });
    const result = await (runner as any).awaitCompletion(proc, completion);
    expect(result).toEqual({ code: 0, signal: null });
  });

  it('force-stops and returns SIGKILL on completion timeout', async () => {
    // Use a very short timeout for fast test execution
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir, completionTimeoutMs: 50 });
    const proc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess;

    // Completion promise that never resolves (simulates hung process)
    const neverResolving = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      () => {},
    );

    // The stopper needs to be mocked since we're using a fake ChildProcess
    // that doesn't have real signal handling.
    const stopperSpy = vi.spyOn((runner as any).stopper, 'stop').mockResolvedValue(undefined);

    mockLogger.warn.mockClear();

    const result = await (runner as any).awaitCompletion(proc, neverResolving);

    expect(result).toEqual({ code: null, signal: 'SIGKILL' });
    expect(stopperSpy).toHaveBeenCalledWith(proc, { immediate: true });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('completion timeout'));

    stopperSpy.mockRestore();
  });
});

// --- Integration: basic flow via run() ---

describe('KimiRunner integration', () => {
  it('test_anchor_basic_flow_yields_system_init_and_result', async () => {
    createMockKimi(`
      echo '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"test","content":""}'
    `);

    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Should yield: SystemInit + Result(success)
    const sysEvent = events.find((e) => e.type === 'system');
    expect(sysEvent).toBeDefined();
    expect((sysEvent as any).subtype).toBe('init');
    expect((sysEvent as any).session_id).toBe('s1');

    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect((resultEvent as any).subtype).toBe('success');
    expect(runner.isRunning).toBe(false);
  });

  it('test_anchor_nonzero_exit_yields_result_error', async () => {
    createMockKimi(`
      echo 'API error' >&2
      exit 1
    `);

    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect((resultEvent as any).subtype).toBe('error');
    expect((resultEvent as any).errorMessage).toMatch(/code=1/);
    expect(runner.isRunning).toBe(false);
  });

  it('test_anchor_spawn_failure_yields_auth_error_event', async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(tmpDir, 'no-bin');
    const runner = new KimiRunner({
      workspace: 'test',
      pidDir: tmpDir,
    });

    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }
    restorePath(saved);

    // §9.22: spawning-runner yields syntheticInitEvent + authErrorEvent (2 events)
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('system');
    const errEvent = events[1] as { type: string; subtype?: string; errorMessage?: string };
    expect(errEvent.type).toBe('result');
    expect(errEvent.subtype).toBe('error');
    expect(errEvent.errorMessage).toMatch(/不可用|not found|ENOENT/i);
    expect(runner.isRunning).toBe(false);
  });

  it('cleans up pid file after process exits', async () => {
    createMockKimi(`
      echo '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"test","content":""}'
    `);

    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    const pidFile = path.join(tmpDir, 'kimi.pid');

    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('killOrphan handles missing pid file gracefully', () => {
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });
    expect(() => runner.killOrphan()).not.toThrow();
  });
});
