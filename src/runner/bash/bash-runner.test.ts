import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
