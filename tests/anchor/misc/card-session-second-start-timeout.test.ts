/**
 * Anchor Test: P2-30 CardSession.start() 二次调用无超时兜底
 *
 * 背景：src/card/card-session.ts:94 的 start() 在 streamOutcome 已存在时
 * 直接 `return this.controllerReady`，绕过了首次调用中的
 * `Promise.race([this.controllerReady, timeout])` 超时保护。
 * 若首次 start 因 controller 永不 ready 而超时失败，controllerReady 这个
 * Promise 将永不 settle，第二次 start() 会无期限挂起。
 *
 * 契约：第二次 start() 也应在 startTimeoutMs 内超时抛错，而非永久挂起。
 *
 * 这个 anchor 构造一个 producer 永不调用 resolveController 的 stub connector
 * （controller.update 返回永不 resolve 的 promise），让首次 start 超时抛错，
 * 然后断言第二次 start 也在合理时间内超时抛错。真红 = 第二次 start 永久
 * 挂起，被外层兜底 race 在 200ms 后强制 reject，且错误不匹配 /timeout/。
 */
import { describe, it, expect, vi } from 'vitest';
import type { CardStreamController, CardStreamProducer } from '@larksuite/channel';
import { RunCardSession } from '../../../src/card/run-card-session.js';

vi.mock('../../../src/logger/index.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { getLogger: () => mockLogger };
});

/**
 * 构造一个 producer 永不调用 resolveController 的 connector：
 * controller.update 返回永不 resolve 的 promise，导致 CardSession.start()
 * 的 producer 卡在 `await controller.update(...)`，永远到不了
 * `this.resolveController()`，controllerReady 永不 settle。
 */
function createHangingConnector(): {
  streamCard: (
    chatId: string,
    initial: object,
    producer: CardStreamProducer,
    opts?: { replyTo?: string },
  ) => Promise<string>;
  updateCard: (messageId: string, card: object) => Promise<void>;
} {
  const hangingController: CardStreamController = {
    messageId: 'card-hang',
    current: {},
    update: () =>
      new Promise<void>(() => {
        // 永不 resolve —— producer 卡在此处
      }),
  };
  return {
    streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
      // 启动 producer 但不 await（让 producer 在后台卡住）
      // streamCard 自身也永不 resolve（producer 永不返回）
      producer(hangingController);
      return new Promise<string>(() => {
        // 永不 resolve
      });
    },
    updateCard: async () => {},
  };
}

describe('P2-30 CardSession.start() second call timeout', () => {
  it('test_anchor_second_start_after_timeout_should_also_timeout', async () => {
    const connector = createHangingConnector();
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-p2-30',
      startTimeoutMs: 50, // 首次 start 快速超时
      coalesceMs: 0,
    });

    // 首次 start：controller 永不 ready → 50ms 后超时抛错
    await expect(session.start()).rejects.toThrow(/timeout/);

    // 二次 start：当前实现 `return this.controllerReady`（永不 settle）
    // 契约要求：也应在 startTimeoutMs(50ms) 内超时抛错。
    // 用外层 200ms 兜底 race 检测：若第二次 start 在 200ms 内未按契约
    // 抛出 /stream start timeout/ 错误（即永久挂起），则兜底 reject
    // 暴露缺陷。兜底错误故意不含 "timeout" 字样，以区分「契约超时」
    // 与「永久挂起被外层杀掉」。
    const HANG_MARKER = 'SECOND_START_HUNG_NO_CONTRACT_TIMEOUT';
    await expect(
      Promise.race([
        session.start(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(HANG_MARKER)), 200)),
      ]),
    ).rejects.toThrow(/stream start timeout/);
  }, 5000);
});
