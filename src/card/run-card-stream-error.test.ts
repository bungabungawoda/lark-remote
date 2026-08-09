import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardStreamController, CardStreamProducer } from '@larksuite/channel';
import { RunCardSession } from './run-card-session.js';

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

  /**
   * 测试 1: connector.updateCard 在 push 事件中抛出错误时的行为
   * 场景：controller.update 失败，fallback updateCard 也失败
   */
  it('test_anchor_push_both_controller_and_fallback_fail_should_log', async () => {
    const axiosError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status?: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };

    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async () => {
        throw axiosError; // controller 失败
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-1';
      },
      updateCard: async (_messageId: string, _card: object) => {
        throw axiosError; // fallback 也失败
      },
    };

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

  /**
   * 测试 2: controller.update 抛出错误时的行为
   * 场景：只有 controller 失败，fallback 成功
   */
  it('test_anchor_push_controller_fails_fallback_succeeds_should_log_once', async () => {
    const controller: CardStreamController = {
      messageId: 'card-2',
      current: {},
      update: async () => {
        throw new Error('controller update failed');
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-2';
      },
      updateCard: async () => {}, // fallback 成功
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-2',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的错误处理契约
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

  /**
   * 测试 3: controller.update 抛出 AxiosError（未经包装）
   * 模拟飞书 SDK 直接抛出原始错误的情况
   */
  it('test_anchor_push_raw_AxiosError_should_not_crash', async () => {
    const axiosError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status?: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };

    const controller: CardStreamController = {
      messageId: 'card-3',
      current: {},
      update: async () => {
        throw axiosError;
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-3';
      },
      updateCard: async () => {}, // fallback 成功
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-3',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的错误处理契约
    });

    await session.start();
    vi.clearAllMocks();

    // 推送事件触发 controller.update
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'test' }] },
    });

    // 验证：有错误日志
    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalled();

    await session.finish('done', { resultSubtype: 'success' });
  });

  /**
   * 测试 4: push 抛出异常时不应该导致进程崩溃
   * 验证 push 方法的错误处理
   */
  it('test_anchor_push_error_does_not_propagate', async () => {
    const controller: CardStreamController = {
      messageId: 'card-4',
      current: {},
      update: async () => {
        throw new Error('update error');
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-4';
      },
      updateCard: async () => {
        throw new Error('fallback error');
      },
    };

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

    // 应该仍然可以完成
    await session.finish('done', { resultSubtype: 'success' });
  });

  /**
   * 测试 5: finish 时 update 失败不应该导致进程崩溃
   */
  it('test_anchor_finish_error_does_not_propagate', async () => {
    const controller: CardStreamController = {
      messageId: 'card-5',
      current: {},
      update: async () => {
        throw new Error('finish update error');
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-5';
      },
      updateCard: async () => {
        throw new Error('fallback error');
      },
    };

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

  /**
   * ��试 6: settle 时 update 失败不应该导致进程崩溃
   */
  it('test_anchor_settle_error_does_not_propagate', async () => {
    const controller: CardStreamController = {
      messageId: 'card-6',
      current: {},
      update: async () => {
        throw new Error('settle update error');
      },
    };

    // 模拟 settle 时 updateCard 失败
    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-6';
      },
      updateCard: async (_messageId: string, _card: object) => {
        throw new Error('settle fallback error');
      },
    };

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

  /**
   * 测试 7: 验证 unhandled rejection 不会发生
   * 关键测试：模拟最坏情况，所有更新都失败
   */
  it('test_anchor_all_updates_fail_no_unhandled_rejection', async () => {
    const axiosError = new Error('Request failed with status code 400') as Error & {
      isAxiosError: boolean;
      response?: { status?: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };

    const controller: CardStreamController = {
      messageId: 'card-7',
      current: {},
      update: async () => {
        throw axiosError;
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-7';
      },
      updateCard: async () => {
        throw axiosError;
      },
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-7',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的错误处理契约
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

    // 应该仍然可以完成
    await session.finish('done', { resultSubtype: 'success' });
    const result = await session.settle();

    // 无论 settle 返回什么，都不应该抛出异常导致进程崩溃
    expect(['streamed', 'updated', 'unsent']).toContain(result);
  });

  /**
   * 测试 8: 飞书 230027 错误（外部聊天无权限）
   * 模拟生产环境中实际出现的错误码
   */
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

    const controller: CardStreamController = {
      messageId: 'card-8',
      current: {},
      update: async () => {
        throw feishuError;
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-8';
      },
      updateCard: async () => {
        throw feishuError;
      },
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-8',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的错误处理契约
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

    // 不应该抛出，应该能正常完成
    await session.finish('done', { resultSubtype: 'success' });
    const result = await session.settle();
    expect(['streamed', 'updated', 'unsent']).toContain(result);

    // 验证日志中有 230027 相关的警告
    const logger = getLogger();
    // 注意：当前代码只记录 error 对象，不解析 response.data
    // 所以这里只验证 warn 被调用（不验证 230027 文字）
    expect(logger.warn).toHaveBeenCalled();
  });

  /**
   * 测试 9: controller 变为 null 后的 fallback 行为
   * 模拟 stream 断开后 controller 丢失
   */
  it('test_anchor_controller_null_fallback_to_updateCard', async () => {
    let controllerRef: CardStreamController | undefined; // eslint-disable-line prefer-const

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controllerRef!);
        return 'card-9';
      },
      updateCard: vi.fn().mockResolvedValue(undefined),
    };

    // 先创建一个有正常 controller 的 session
    controllerRef = {
      messageId: 'card-9',
      current: {},
      update: vi.fn().mockResolvedValue(undefined),
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-9',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的 fallback 契约
    });

    await session.start();
    vi.clearAllMocks();

    // 第一次 push 使用 controller
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'before disconnect' }] },
    });
    expect(controllerRef!.update).toHaveBeenCalled();
    expect(connector.updateCard).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // 模拟 controller 丢失（stream 断开场景）
    // 在实际代码中 controller 不会变为 null，但如果 update 抛异常会走 fallback
    // 这里直接让 controller.update 抛异常来模拟
    (controllerRef!.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('controller stream closed'),
    );

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'after disconnect' }] },
    });

    // controller 失败后应该 fallback 到 updateCard
    expect(connector.updateCard).toHaveBeenCalled();
  });

  /**
   * 测试 10: stream 启动阶段 streamCard 抛出异常
   * 如果 streamCard 本身就失败了（不是 update），session 应该怎么处理
   */
  it('test_anchor_streamCard_reject_on_start', async () => {
    const connector = {
      streamCard: async () => {
        throw new Error('streamCard rejected: no permission');
      },
      updateCard: vi.fn().mockResolvedValue(undefined),
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-10',
      startTimeoutMs: 2_000, // 缩短超时
    });

    // start 应该因为 streamCard 抛出而失败（rejectController 传递原始错误）
    await expect(session.start()).rejects.toThrow('streamCard rejected: no permission');

    // 此后 settle 应该安全
    const result = await session.settle();
    expect(result).toBe('unsent');
  });

  /**
   * 测试 11: 并发 push 时部分 update 失败
   * 模拟快速连续 push 时 controller 间歇性失败
   */
  it('test_anchor_concurrent_push_intermittent_failure', async () => {
    let updateCallCount = 0;
    const controller: CardStreamController = {
      messageId: 'card-11',
      current: {},
      update: async () => {
        updateCallCount++;
        // 每 3 次失败一次
        if (updateCallCount % 3 === 0) {
          throw new Error('intermittent controller failure');
        }
      },
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        return 'card-11';
      },
      updateCard: vi.fn().mockResolvedValue(undefined),
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-11',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的间歇性失败契约
    });

    await session.start();
    vi.clearAllMocks();

    // 快速连续 push（合批禁用下每次 push 同步 flush，模拟 AgentEvent 快速到达）
    const pushPromises = [];
    for (let i = 0; i < 10; i++) {
      pushPromises.push(
        session.push({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `burst ${i}` }] },
        }),
      );
    }
    // 注意：coalesceMs=0 下 push 同步 await flush，但这里故意并发测试间歇性失败
    await Promise.all(pushPromises);

    // 应该仍然可以正常完成
    await session.finish('done', { resultSubtype: 'success' });
    const result = await session.settle();
    expect(['streamed', 'updated', 'unsent']).toContain(result);
  });

  /**
   * 测试 12: AxiosError 在 settle 阶段的 fallback 路径
   * 模拟 stream 异常结束后 settle 的 updateCard fallback
   */
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

    const controller: CardStreamController = {
      messageId: 'card-12',
      current: {},
      update: vi.fn().mockResolvedValue(undefined),
    };

    const connector = {
      streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
        await producer(controller);
        // 让 stream 本身失败
        throw feishuError;
      },
      updateCard: vi.fn().mockRejectedValue(feishuError),
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-12',
    });

    await session.start();
    await session.finish('done', { resultSubtype: 'success' });

    // settle 应该不抛出，返回 'unsent'（因为 stream 和 fallback 都失败了）
    const result = await session.settle();
    expect(result).toBe('unsent');

    // 验证错误日志
    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalled();
  });
});
