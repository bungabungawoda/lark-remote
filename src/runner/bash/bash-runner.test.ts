import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { BashProcessRunner } from './index.js';
import { describePosix } from '../../../tests/lib/platform.js';
import { ShellUnavailableError, type ShellBackend } from '../../platform/shell.js';
import type { Terminator } from '../../platform/terminator.js';

// 明确依赖 POSIX 原语（真实 bash + nohup/disown），win32 上跳过（§10.2）
describePosix('BashProcessRunner', () => {
  let runner: BashProcessRunner;

  beforeEach(() => {
    runner = new BashProcessRunner();
  });

  afterEach(async () => {
    if (runner.isRunning) {
      await runner.stop({ immediate: true });
    }
  });

  it('should exit immediately for nohup background command', async () => {
    const start = Date.now();
    const events: string[] = [];

    for await (const event of runner.run('nohup sleep 30 &', { cwd: '/tmp' })) {
      events.push(event.type);
      if (event.type === 'exit') break;
    }

    const elapsed = Date.now() - start;

    // 回归守卫：bash 退出后必须立即触发 exit（历史 bug 曾监听 close 导致
    // exit 延迟 30 秒），elapsed 应 < 500ms
    expect(elapsed).toBeLessThan(500);
    expect(events).toContain('exit');
  });

  it('should exit immediately for disowned background command', async () => {
    const start = Date.now();
    const events: string[] = [];

    for await (const event of runner.run('sleep 30 & disown', { cwd: '/tmp' })) {
      events.push(event.type);
      if (event.type === 'exit') break;
    }

    const elapsed = Date.now() - start;

    // 修复后应该 < 500ms
    expect(elapsed).toBeLessThan(500);
    expect(events).toContain('exit');
  });

  it('should still work for normal foreground commands', async () => {
    const start = Date.now();
    const events: string[] = [];
    let exitCode: number | undefined;

    for await (const event of runner.run('echo hello', { cwd: '/tmp' })) {
      events.push(event.type);
      if (event.type === 'exit') {
        exitCode = event.exitCode;
      }
    }

    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(events).toContain('exit');
    expect(exitCode).toBe(0);
  });
});

// 背压水位（P1-4 层④）此前零直测：判据写错不会崩，只会在长输出时把整段 stdout
// 堆进内存，或者反过来把流误停成永久 pause、`!` 命令悬死不返回。
describe('BashProcessRunner — 输出背压水位', () => {
  const HIGH = 3;
  const LOW = 2;

  class FakeStream extends EventEmitter {
    pauseCalls = 0;
    resumeCalls = 0;
    override pause(): this {
      this.pauseCalls++;
      return this;
    }
    override resume(): this {
      this.resumeCalls++;
      return this;
    }
    pushChunk(text: string): void {
      this.emit('data', Buffer.from(text, 'utf-8'));
    }
  }

  function makeRunner(): { runner: BashProcessRunner; stdout: FakeStream; stderr: FakeStream } {
    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      pid: 4242,
      exitCode: null,
      signalCode: null,
    });
    const shell: ShellBackend = { kind: 'bash', spawn: () => proc as unknown as ChildProcess };
    const terminator: Terminator = {
      stop: async () => ({ requested: false, via: 'already-exited' }),
      cleanupOnExit: () => {},
    };
    return {
      runner: new BashProcessRunner({
        queueHighWater: HIGH,
        queueLowWater: LOW,
        shell,
        terminator,
      }),
      stdout,
      stderr,
    };
  }

  // run() 的循环体同步跑到第一个 await 才让出，所以先不 await 地把它推进等待态，
  // 再灌数据，队列才会真的越过水位。
  function started(runner: BashProcessRunner): ReturnType<BashProcessRunner['run']> {
    return runner.run('fake command', { cwd: '/home/user/project' });
  }

  it('pauses past the high-water mark, resumes at the low-water mark, and re-arms', async () => {
    const { runner, stdout } = makeRunner();
    const it = started(runner);
    const first = it.next();
    for (let i = 0; i < 5; i++) stdout.pushChunk(`c${i}`);

    // 第 4 条越过高水位才 pause；之后每条都不该重复 pause
    expect(stdout.pauseCalls).toBe(1);

    expect((await first).value!.content).toBe('c0');
    expect(stdout.resumeCalls).toBe(0); // 队列还剩 4 条
    await it.next(); // c1，剩 3
    expect(stdout.resumeCalls).toBe(0);
    await it.next(); // c2，队列剩 2 = 低水位；放行发生在下一次取用时
    expect(stdout.resumeCalls).toBe(0);
    await it.next(); // c3
    expect(stdout.resumeCalls).toBe(1); // 队列触到低水位，流被放行一次
    await it.next(); // c4
    expect(stdout.resumeCalls).toBe(1); // 已经放行过就不该重复

    // 放行之后还要能再 pause：标志没复位的话流就永远不再被停，内存上界失效
    for (let i = 0; i < 5; i++) stdout.pushChunk(`d${i}`);
    expect(stdout.pauseCalls).toBe(2);

    await it.return(undefined);
  });

  it('leaves the stream alone while the queue stays at the high-water mark', async () => {
    const { runner, stdout } = makeRunner();
    const it = started(runner);
    const first = it.next();
    for (let i = 0; i < HIGH; i++) stdout.pushChunk(`c${i}`);

    // 正好等于高水位：`>` 写成 `>=` 会在这里误停
    expect(stdout.pauseCalls).toBe(0);
    await first;
    await it.next();
    await it.next();
    // 没 pause 过就没什么可放行
    expect(stdout.resumeCalls).toBe(0);

    await it.return(undefined);
  });

  it('applies the same water marks to stderr', async () => {
    const { runner, stderr } = makeRunner();
    const it = started(runner);
    const first = it.next();
    for (let i = 0; i < 5; i++) stderr.pushChunk(`e${i}`);

    expect(stderr.pauseCalls).toBe(1);
    expect((await first).value!.type).toBe('stderr');
    await it.next();
    await it.next();
    expect(stderr.resumeCalls).toBe(0);
    await it.next();
    expect(stderr.resumeCalls).toBe(1); // stderr 走的是自己那套水位状态

    await it.next(); // e4
    for (let i = 0; i < 5; i++) stderr.pushChunk(`f${i}`);
    expect(stderr.pauseCalls).toBe(2); // 放行之后仍要能再停

    await it.return(undefined);
  });
});

describe('BashProcessRunner — shell 不可用（win32 Git Bash 缺失，§7.2）', () => {
  it('同步抛 ShellUnavailableError → stderr 明确提示 + exit 1，不注册退出清理', async () => {
    const throwingShell: ShellBackend = {
      kind: 'bash',
      spawn: () => {
        throw new ShellUnavailableError(
          'bash',
          'Windows 上执行 bash 命令需要 Git Bash（未在 PATH 中找到 bash.exe）；请安装 Git for Windows 后重试',
        );
      },
    };
    const terminator: Terminator = {
      stop: async () => ({ requested: false, via: 'already-exited' }),
      cleanupOnExit: () => {},
    };
    const runner = new BashProcessRunner({ shell: throwingShell, terminator });

    const events: Array<{ type: string; content: string; exitCode?: number }> = [];
    for await (const event of runner.run('echo hi', { cwd: '/home/user/project' })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'stderr' });
    expect(events[0].content).toContain('Git Bash');
    expect(events[1]).toMatchObject({ type: 'exit', exitCode: 1 });
    expect(runner.isRunning).toBe(false);
  });
});
