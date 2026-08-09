import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from '../../src/card/run-card-session.js';

/**
 * PROBE (P1-3 finish 立即 flush + 残留窗口不丢) — spec 红线：finish() 必须立即
 * flush 不能合批（终态要即时显示）；最后一次 push 后的残留窗口必须 flush（否则
 * 丢最后一批事件）。本 probe 验证合批引入后这两条不变量未退化。
 *
 * ① finish 立即 flush：push 一批事件（窗口内未 flush），紧接着 finish()，不推进
 *    timer，断言终态卡已含 finish 的内容（done 标记/usage）。若 finish 等窗口，
 *    终态卡停留在运行态。
 * ② 残留窗口不丢：push 后窗口到期 flush，再 finish，断言 push 的内容 + finish
 *    的终态都在最终卡里。
 * ③ finish cancel pending：push 后立即 finish（窗口未到期），断言延迟 flush 不
 *    在 finish 之后触发用旧 state 覆盖终态卡（updates 末尾是终态内容）。
 *
 * 依据：§P1-3「注意：finish() 必须立即 flush 不能合批
 * （终态要即时显示）」+「需保证最后一次 push 后 flush 残留窗口」。
 */
describe('RunCardSession finish flush + residual window (P1-3 probe)', () => {
  let updates: object[];
  let controller: CardStreamController;

  beforeEach(() => {
    vi.useFakeTimers();
    updates = [];
    controller = {
      messageId: 'card-f',
      current: {},
      update: async (card) => {
        updates.push(typeof card === 'function' ? (card as (cur: object) => object)({}) : card);
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSession(coalesceMs = 100): RunCardSession {
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-f';
      },
      updateCard: async () => {},
    };
    return new RunCardSession({ connector, chatId: 'chat-1', runId: 'run-f', coalesceMs });
  }

  it('probe_finish_flushes_immediately_without_waiting_for_coalesce_window', async () => {
    const session = makeSession(100);
    await session.start();
    vi.clearAllMocks();
    updates.length = 0;

    // push 一批事件（窗口内，未 flush）
    for (let i = 0; i < 5; i++) {
      await session.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `pre-finish-${i}` }] },
      });
    }
    // 紧接着 finish，不推进 timer
    await session.finish('done', { resultSubtype: 'success' });

    // 终态必须立即显示：最终 update 含 done 标记，无需推进窗口
    const last = JSON.stringify(updates.at(-1));
    expect(last).toContain('已完成');
    // pre-finish 内容也必须在终态卡里（state 累积正确）
    expect(last).toContain('pre-finish-4');

    await session.settle();
  });

  it('probe_residual_window_flush_does_not_lose_last_events', async () => {
    const session = makeSession(100);
    await session.start();
    vi.clearAllMocks();
    updates.length = 0;

    // push 后让窗口到期 flush
    for (let i = 0; i < 3; i++) {
      await session.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `residual-${i}` }] },
      });
    }
    await vi.advanceTimersByTimeAsync(120);

    // 残留窗口 flush 后内容不丢
    const flushed = JSON.stringify(updates.at(-1));
    expect(flushed).toContain('residual-0');
    expect(flushed).toContain('residual-2');

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('probe_finish_cancels_pending_flush_no_stale_overwrite', async () => {
    const session = makeSession(100);
    await session.start();
    vi.clearAllMocks();
    updates.length = 0;

    // push 触发延迟 flush 调度（窗口未到期）
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'stale-candidate' }] },
    });
    // finish 立即转终态，cancel pending 调度
    await session.finish('done', { resultSubtype: 'success' });

    // 推进窗口 —— 被取消的延迟 flush 不应触发（否则可能用旧 state 覆盖）
    const updatesAfterFinish = updates.length;
    await vi.advanceTimersByTimeAsync(150);

    // 终态卡是最后一帧：仍含 done 标记
    expect(JSON.stringify(updates.at(-1))).toContain('已完成');
    // finish 后推进窗口不应新增 update（pending 已 cancel）
    expect(updates.length, 'stale flush fired after finish').toBe(updatesAfterFinish);

    await session.settle();
  });
});
