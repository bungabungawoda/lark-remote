import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BashProcessRunner } from './index.js';

describe('BashProcessRunner', () => {
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
    console.log(`nohup command elapsed: ${elapsed}ms, events: ${events.join(',')}`);

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
    console.log(`disown command elapsed: ${elapsed}ms, events: ${events.join(',')}`);

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
