/**
 * Anchor Test: kimi-runner should emit system.init event
 *
 * Bug: kimi-runner 解析了 session.resume_hint 元事件，但没有将其转换为
 * system.init 事件发送给 bridge，导致:
 * 1. bridge 无法获知 session_id
 * 2. 用户无法通过 /resume 恢复会话
 *
 * 修复: 在收到 session.resume_hint 时，yield system.init 事件
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock dependencies
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/runner/common/process-stopper.js', () => ({
  ProcessStopper: class {
    constructor() {}
    async stop() {}
  },
}));

vi.mock('../../../src/runner/common/spawn-heartbeat.js', () => ({
  SpawnHeartbeat: class {
    constructor() {}
    notifyStdout() {}
    clear() {}
    start() {}
  },
}));

const { KimiRunner } = await import('../../../src/runner/kimi/index.js');
const { spawn } = await import('node:child_process');

describe('KimiRunner system.init event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Anchor Test: 当 kimi 返回 session.resume_hint 时，应发送 system.init 事件
   */
  it('test_anchor_kimi_emits_system_init_on_session_resume', async () => {
    // 创建一个模拟的 stdout 流，使用 EventEmitter 模式
    const mockStdout = new EventEmitter() as EventEmitter & {
      pause: () => void;
      resume: () => void;
      destroy: () => void;
    };
    mockStdout.pause = vi.fn();
    mockStdout.resume = vi.fn();
    mockStdout.destroy = vi.fn();

    let closeHandler: (() => void) | null = null;
    mockStdout.on('close', () => {
      if (closeHandler) closeHandler();
    });

    // 原实现 dataHandler 恒为 null（从未赋值），保留空回调保持行为一致。
    mockStdout.on('data', () => {});

    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout: mockStdout as any,
      stderr: {
        on: vi.fn(),
        destroy: vi.fn(),
      } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandler = cb as () => void;
          // 模拟进程退出
          setTimeout(() => {
            mockStdout.emit('close');
            cb(0, null);
          }, 50);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new KimiRunner({ workspace: 'test', pidDir: '/tmp' });

    // 异步收集事件
    const events: any[] = [];
    const eventCollectionPromise = (async () => {
      for await (const event of runner.run('test prompt', { cwd: '/tmp/test-workspace' })) {
        events.push(event);
      }
    })();

    // 延迟发送 session.resume_hint 数据，模拟 kimi 流式输出
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 模拟 kimi 输出 session.resume_hint JSONL
    const sessionResumeHint = JSON.stringify({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_test123',
      command: 'kimi -r session_test123',
      content: 'To resume this session: kimi -r session_test123',
    });
    mockStdout.emit('data', Buffer.from(sessionResumeHint + '\n'));

    // 等待事件收集完成
    await eventCollectionPromise;

    // 验证：应该有 system.init 事件
    const systemInitEvents = events.filter((e) => e.type === 'system' && e.subtype === 'init');
    expect(systemInitEvents.length).toBe(1);

    const initEvent = systemInitEvents[0];
    // 验证 session_id 正确
    expect(initEvent.session_id).toBe('session_test123');
    // 验证 cwd 正确（从 spawn opts 传入）
    expect(initEvent.cwd).toBe('/tmp/test-workspace');
    // 验证 model 正确
    expect(initEvent.model).toBe('kimi-code/k3');
  });
});
