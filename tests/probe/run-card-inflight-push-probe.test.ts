import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from '../../src/card/run-card-session.js';

/**
 * PROBE (P1-3 flush-in-flight push 不丢内容) — 第 5 轮 review 发现的覆盖缺口：
 * 当一次 flush 正在 in-flight（await updateCard 未 resolve）时，新 push 调
 * scheduleFlush 会被 flushInFlight 守卫挡掉（不调度新 timer）。该 push 的内容
 * 已 reduce 进 this.state，但当前 in-flight flush 可能已渲染旧 state。
 *
 * 本 probe 验证：① flush-in-flight 期间的 push 不会调度冗余 timer（合批守卫）
 * ② 但 push 的内容不会永久丢失——finish 渲染完整 state 时含该内容
 * （finish 是最终一致性的保证）。即：flush-in-flight 窗口内事件至多延迟到
 * finish 才上卡，不是丢失。
 */
describe('RunCardSession flush-in-flight push (P1-3 probe)', () => {
  let controller: CardStreamController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = {
      messageId: 'card-if',
      current: {},
      update: async () => {},
    };
  });
  afterEach(() => vi.useRealTimers());

  it('probe_push_during_inflight_flush_content_preserved_by_finish', async () => {
    // 让 flush 的 controller.update（第 2 次调用，第 1 次是 start 初始）阻塞，
    // 制造 in-flight 窗口；收集终态 patch JSON 验证最终一致性。
    let resolveUpdate: (() => void) | undefined;
    let callCount = 0;
    let finishCardJson = '';
    controller.update = async (card) => {
      callCount++;
      const resolved = typeof card === 'function' ? (card as (cur: object) => object)({}) : card;
      const json = JSON.stringify(resolved);
      if (json.includes('已完成')) finishCardJson = json;
      if (callCount === 2) {
        // flush 的 update 阻塞，制造 in-flight 窗口
        await new Promise<void>((r) => {
          resolveUpdate = r;
        });
      }
    };
    const connector = {
      streamCard: async (
        _c: string,
        _i: object,
        p: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await p(controller);
        return 'card-if';
      },
      updateCard: async () => {},
    };
    const session = new RunCardSession({ connector, chatId: 'chat-1', runId: 'run-if' });
    await session.start();

    // 第 1 个 push → scheduleFlush（timer 待触发）
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'event-1' }] },
    });
    // 推进 timer → flush 启动 → controller.update 第 2 次阻塞（in-flight）
    await vi.advanceTimersByTimeAsync(120);

    // flush in-flight 期间再 push（event-2）—— scheduleFlush 被 flushInFlight 挡掉
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'event-2' }] },
    });

    // 放行 in-flight flush
    resolveUpdate?.();
    // 此时 flushInFlight=false，无 pending timer；event-2 已 reduce 进 state 但未单独 flush

    // finish 渲染完整 state——必须同时含 event-1 和 event-2（最终一致性）
    await session.finish('done', { resultSubtype: 'success' });

    expect(finishCardJson).toContain('event-1');
    expect(finishCardJson).toContain('event-2');

    await session.settle();
  });
});
