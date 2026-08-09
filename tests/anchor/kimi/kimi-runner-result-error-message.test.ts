/**
 * Anchor Test: kimi-runner result event includes error message
 *
 * Bug: 当 kimi API 返回错误时，result event 的 errorMessage 字段为 undefined，
 * 导致用户只看到"未知错误"，无法理解真实失败原因。
 *
 * 根因: kimi-runner 捕获了 stderr 但从未将其包含在 result event 中
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {} from 'node:url';

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

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

vi.mock('../../../src/runner/common/process-stopper.js', () => ({
  ProcessStopper: class {
    constructor() {}
    async stop() {}
  },
}));

vi.mock('../../../src/runner/common/spawn-heartbeat.js', () => ({
  SpawnHeartbeat: class {
    constructor() {}
    start() {}
    notifyStdout() {}
    clear() {}
  },
}));

// Import after mocks
const { KimiRunner } = await import('../../../src/runner/kimi/index.js');
const { spawn } = await import('node:child_process');

describe('KimiRunner result event error message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Anchor Test 1: 当 kimi 进程以非零退出码退出时，result event 应包含 stderr 内容
   *
   * 场景: kimi API 返回 404 错误
   * 预期: result.event 的 errorMessage 字段包含 stderr 中的错误信息
   */
  it('test_anchor_kimi_result_includes_error_message_on_api_failure', async () => {
    // 模拟 kimi 进程：输出空的 stdout，然后以退出码 1 退出
    const mockStderrData = 'ERROR llm request failed: 404 Not found the model k3';
    let stderrHandler: ((chunk: Buffer) => void) | null = null;

    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout: {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            // 模拟 stdout 立即关闭（无数据）
            setTimeout(() => cb(), 10);
          }
        }),
        once: vi.fn(),
        destroy: vi.fn(),
      } as any,
      stderr: {
        on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
          if (event === 'data') {
            stderrHandler = cb;
          }
        }),
        destroy: vi.fn(),
      } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          // 模拟进程立即关闭，退出码 1
          setTimeout(() => cb(1, null), 50);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    // 触发 stderr data 事件来模拟 kimi 写入错误信息
    setTimeout(() => {
      if (stderrHandler) {
        stderrHandler(Buffer.from(mockStderrData, 'utf-8'));
      }
    }, 10);

    const runner = new KimiRunner({ workspace: 'test', pidDir: '/tmp' });

    // 收集所有事件
    const events: any[] = [];
    for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
      events.push(event);
    }

    // 验证：应该有 result 事件
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);

    const resultEvent = resultEvents[0];
    // 验证：subtype 应该是 'error'
    expect(resultEvent.subtype).toBe('error');

    // 验证：errorMessage 应该包含 stderr 内容
    // 这是核心断言 - 当前实现中 errorMessage 为 undefined
    expect(resultEvent.errorMessage).toBeDefined();
    expect(resultEvent.errorMessage).toContain('404');
  });

  /**
   * Anchor Test 2: 当 kimi 进程正常退出时，result event 不应有 errorMessage
   */
  it('test_anchor_kimi_result_no_error_message_on_success', async () => {
    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout: {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            setTimeout(() => cb(), 10);
          }
        }),
        once: vi.fn(),
        destroy: vi.fn(),
      } as any,
      stderr: {
        on: vi.fn(),
        destroy: vi.fn(),
      } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          // 模拟正常退出，退出码 0
          setTimeout(() => cb(0, null), 50);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new KimiRunner({ workspace: 'test', pidDir: '/tmp' });

    const events: any[] = [];
    for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
      events.push(event);
    }

    // 验证：应该有 result 事件
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);

    const resultEvent = resultEvents[0];
    // 验证：subtype 应该是 'success'
    expect(resultEvent.subtype).toBe('success');

    // 验证：成功时 errorMessage 应该为空
    expect(resultEvent.errorMessage).toBeUndefined();
  });
});
