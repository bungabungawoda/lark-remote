import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from '../../src/card/run-card-session.js';

/**
 * PROBE (P1-3 push await 语义边界) — 合批路径 push 必须 fire-and-forget
 * （立即 resolve，不等 render），否则 bridge 的 `await cardSession.push(event)`
 * 串行循环被 render 阻塞，事件逐个 flush，合批无 CPU 收益（§P1-3
 * §P1-3 + §P1-4「push 改 fire-and-forget + pending flag」）。
 *
 * 同时，coalesceMs<=0 路径必须同步 flush 完成才 resolve（错误处理测试依赖 push
 * 后立即生效的契约，见 run-card-session-error.test.ts / run-card-stream-error.test.ts
 * 5 处 coalesceMs:0）。
 *
 * 本 probe 锁定两条边界：
 * ① 合批路径：push 在 flushTimer 到期前已 resolve（不等 render）。
 * ② 禁用路径：push 在 flush 完成后 resolve（含 fallback update）。
 *
 * 缺失会导致什么：
 * - 合批路径若 await render：bridge 循环串行化 render，事件逐个 flush，合批失效。
 * - 禁用路径若 fire-and-forget：错误处理测试断言的「push 后 update 已发生」被破坏。
 */
describe('RunCardSession push await semantics (P1-3 probe)', () => {
  let controller: CardStreamController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = {
      messageId: 'card-a',
      current: {},
      update: async () => {},
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSession(coalesceMs?: number): {
    session: RunCardSession;
    updateCalls: number[];
  } {
    const updateCalls: number[] = [];
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-a';
      },
      updateCard: async () => {
        updateCalls.push(Date.now());
      },
    };
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-a',
      ...(coalesceMs !== undefined ? { coalesceMs } : {}),
    });
    return { session, updateCalls };
  }

  it('probe_coalesced_push_resolves_before_window_flush_fire_and_forget', async () => {
    // 合批路径：让 controller.update 模拟耗时（若 push await render，push 会阻塞）
    let updateStarted = false;
    controller.update = async () => {
      updateStarted = true;
      // 不推进 fake timer，模拟 render 调度到窗口末尾
    };
    const { session } = makeSession(100);
    await session.start();

    // 重置：start 自带一次初始 controller.update（card-session.ts:103），清掉污染
    updateStarted = false;

    // push 后立即检查：应已 resolve（fire-and-forget），窗口未到期不应触发 update
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'fast' }] },
    });
    // push 已 resolve（到达此行）；窗口未到期，update 未触发
    expect(updateStarted).toBe(false);

    // 推进窗口触发 flush
    await vi.advanceTimersByTimeAsync(120);
    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('probe_disabled_push_resolves_only_after_synchronous_flush', async () => {
    // 禁用路径：push 必须等 flush 完成才 resolve（update 已发生）
    let updateHappened = false;
    controller.update = async () => {
      updateHappened = true;
    };
    const { session } = makeSession(0);
    await session.start();

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'sync' }] },
    });
    // push resolve 时 update 必须已发生（同步 flush 契约）
    expect(updateHappened).toBe(true);

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });
});
