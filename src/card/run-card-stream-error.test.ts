import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCardSession } from './run-card-session.js';
import { makeStreamCardConnector } from '../../tests/lib/card-stubs.js';

// Mock logger to capture log calls
vi.mock('../logger/index.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    getLogger: () => mockLogger,
  };
});

import { getLogger } from '../logger/index.js';

describe('RunCardSession - 流式卡片错误处理探索', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_push_both_controller_and_fallback_fail_should_log', async () => {
    const axiosError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status?: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };

    const { connector } = makeStreamCardConnector({
      messageId: 'card-1',
      controllerUpdate: axiosError,
      updateCard: axiosError,
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-1',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的错误处理契约
    });

    await session.start();
    vi.clearAllMocks(); // 清除 start 阶段的日志

    // 推送一个事件，触发 update
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });

    // 验证：至少有 controller update 失败的警告
    const logger = getLogger();
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const hasControllerFailed = warnCalls.some(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('controller update failed'),
    );
    expect(hasControllerFailed).toBe(true);

    // session 应该仍然可以正常 finish
    await session.finish('done', { resultSubtype: 'success' });
    expect(await session.settle()).toBe('streamed');
  });

  it('test_anchor_push_controller_fails_fallback_succeeds_should_log_once', async () => {
    const { connector } = makeStreamCardConnector({
      messageId: 'card-2',
      controllerUpdate: new Error('controller update failed'),
      updateCard: () => {},
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-2',
      coalesceMs: 0,
    });

    await session.start();
    vi.clearAllMocks();

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'test' }] },
    });

    // 预期：只有一次 controller update failed 的警告
    const logger = getLogger();
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const controllerFailedCalls = warnCalls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('controller update failed'),
    );
    expect(controllerFailedCalls.length).toBe(1);

    await session.finish('done', { resultSubtype: 'success' });
    expect(await session.settle()).toBe('streamed');
  });

  it('test_anchor_push_raw_AxiosError_should_not_crash', async () => {
    const axiosError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status?: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };

    const { connector } = makeStreamCardConnector({
      messageId: 'card-3',
      controllerUpdate: axiosError,
      updateCard: () => {},
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-3',
      coalesceMs: 0,
    });

    await session.start();
    vi.clearAllMocks();

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'test' }] },
    });

    // 验证：有错误日志
    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalled();

    await session.finish('done', { resultSubtype: 'success' });
  });

  it('test_anchor_push_error_does_not_propagate', async () => {
    const { connector } = makeStreamCardConnector({
      messageId: 'card-4',
      controllerUpdate: new Error('update error'),
      updateCard: new Error('fallback error'),
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-4',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push flush 的错误不传播
    });

    await session.start();
    vi.clearAllMocks();

    // push 不应该抛出异常，使用 try-catch 来验证
    let error: Error | undefined;
    try {
      await session.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'test' }] },
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeUndefined();

    await session.finish('done', { resultSubtype: 'success' });
  });

  it('test_anchor_finish_error_does_not_propagate', async () => {
    const { connector } = makeStreamCardConnector({
      messageId: 'card-5',
      controllerUpdate: new Error('finish update error'),
      updateCard: new Error('fallback error'),
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-5',
    });

    await session.start();
    vi.clearAllMocks();

    // finish 不应该抛出异常，使用 try-catch 来验证
    let error: Error | undefined;
    try {
      await session.finish('done', { resultSubtype: 'success' });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeUndefined();
  });

  it('test_anchor_settle_error_does_not_propagate', async () => {
    const { connector } = makeStreamCardConnector({
      messageId: 'card-6',
      controllerUpdate: new Error('settle update error'),
      updateCard: new Error('settle fallback error'),
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-6',
    });

    await session.start();
    await session.finish('done', { resultSubtype: 'success' });
    vi.clearAllMocks();

    // settle 不应该抛出异常
    await expect(session.settle()).resolves.not.toBe('unsent');
  });

  it('test_anchor_all_updates_fail_no_unhandled_rejection', async () => {
    const axiosError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status?: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };

    const { connector } = makeStreamCardConnector({
      messageId: 'card-7',
      controllerUpdate: axiosError,
      updateCard: axiosError,
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-7',
      coalesceMs: 0,
    });

    await session.start();
    vi.clearAllMocks();

    // 模拟多次 push
    for (let i = 0; i < 5; i++) {
      await session.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `message ${i}` }] },
      });
    }

    await session.finish('done', { resultSubtype: 'success' });
    const result = await session.settle();

    expect(['streamed', 'updated', 'unsent']).toContain(result);
  });

  it('test_anchor_feishu_230027_error_both_paths_fail', async () => {
    const feishuError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status: number; data: { code: number; msg: string } };
    };
    feishuError.isAxiosError = true;
    feishuError.response = {
      status: 400,
      data: { code: 230027, msg: 'no permission to operate external chats' },
    };

    const { connector } = makeStreamCardConnector({
      messageId: 'card-8',
      controllerUpdate: feishuError,
      updateCard: feishuError,
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-8',
      coalesceMs: 0,
    });

    await session.start();
    vi.clearAllMocks();

    // push 多次，每次都会遇到 230027
    for (let i = 0; i < 3; i++) {
      await session.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `msg ${i}` }] },
      });
    }

    await session.finish('done', { resultSubtype: 'success' });
    const result = await session.settle();
    expect(['streamed', 'updated', 'unsent']).toContain(result);

    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('test_anchor_controller_null_fallback_to_updateCard', async () => {
    const { connector, controller } = makeStreamCardConnector({
      messageId: 'card-9',
      controllerUpdate: () => {},
      updateCard: vi.fn(),
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-9',
      coalesceMs: 0,
    });

    await session.start();
    vi.clearAllMocks();

    // 第一次 push 使用 controller
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'before disconnect' }] },
    });
    expect(controller.update).toHaveBeenCalled();
    expect(connector.updateCard).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // 模拟 controller 丢失（stream 断开场景）——让 controller.update 抛异常走 fallback
    (controller.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('controller stream closed'),
    );

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'after disconnect' }] },
    });

    expect(connector.updateCard).toHaveBeenCalled();
  });

  it('test_anchor_streamCard_reject_on_start', async () => {
    const { connector } = makeStreamCardConnector({
      messageId: 'card-10',
      streamCardThrows: new Error('streamCard rejected: no permission'),
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-10',
      startTimeoutMs: 2_000,
    });

    await expect(session.start()).rejects.toThrow('streamCard rejected: no permission');

    const result = await session.settle();
    expect(result).toBe('unsent');
  });

  it('test_anchor_concurrent_push_intermittent_failure', async () => {
    let updateCallCount = 0;
    const { connector } = makeStreamCardConnector({
      messageId: 'card-11',
      controllerUpdate: () => {
        updateCallCount++;
        // 每 3 次失败一次
        if (updateCallCount % 3 === 0) {
          throw new Error('intermittent controller failure');
        }
      },
      updateCard: () => {},
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-11',
      coalesceMs: 0,
    });

    await session.start();
    vi.clearAllMocks();

    const pushPromises = [];
    for (let i = 0; i < 10; i++) {
      pushPromises.push(
        session.push({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `burst ${i}` }] },
        }),
      );
    }
    await Promise.all(pushPromises);

    await session.finish('done', { resultSubtype: 'success' });
    const result = await session.settle();
    expect(['streamed', 'updated', 'unsent']).toContain(result);
  });

  it('test_anchor_settle_fallback_AxiosError_230027', async () => {
    const feishuError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status: number; data: { code: number; msg: string } };
    };
    feishuError.isAxiosError = true;
    feishuError.response = {
      status: 400,
      data: { code: 230027, msg: 'no permission to operate external chats' },
    };

    const { connector } = makeStreamCardConnector({
      messageId: 'card-12',
      streamCardThrowsAfterProducer: feishuError,
      updateCard: feishuError,
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-12',
    });

    await session.start();
    await session.finish('done', { resultSubtype: 'success' });

    const result = await session.settle();
    expect(result).toBe('unsent');

    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalled();
  });
});
