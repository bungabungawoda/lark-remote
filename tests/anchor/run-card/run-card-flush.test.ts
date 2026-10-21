/**
 * RunCardSession 合批/flush 契约：错误不产生 unhandled rejection、finish 立即
 * flush 且等 in-flight、残留窗口不丢事件、push 的 await 语义。
 *
 * 合并自 run-card-coalesced-flush-error / run-card-finish-flush /
 * run-card-inflight-push / run-card-push-await-semantics。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from '../../../src/card/run-card-session.js';

let unhandledRejections: unknown[];
let controller: CardStreamController;

beforeEach(() => {
  vi.useFakeTimers();
  unhandledRejections = [];
  process.on('unhandledRejection', captureRejection);
  controller = {
    messageId: 'card-flush',
    current: {},
    update: async () => {},
  };
});

afterEach(() => {
  process.off('unhandledRejection', captureRejection);
  vi.useRealTimers();
});

function captureRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

function makeSession(
  opts: {
    coalesceMs?: number;
    connectorUpdateCard?: () => Promise<void>;
    runId?: string;
  } = {},
): RunCardSession {
  const connector = {
    streamCard: async (
      _chatId: string,
      _initial: object,
      producer: (ctrl: CardStreamController) => Promise<void>,
    ) => {
      await producer(controller);
      return opts.runId ?? 'card-flush';
    },
    updateCard: opts.connectorUpdateCard ?? (async () => {}),
  };
  return new RunCardSession({
    connector,
    chatId: 'chat-1',
    runId: opts.runId ?? 'run-flush',
    ...(opts.coalesceMs !== undefined ? { coalesceMs: opts.coalesceMs } : {}),
  });
}

function pushText(session: RunCardSession, text: string): Promise<void> {
  return session.push({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

describe('RunCardSession flush semantics', () => {
  it('test_anchor_coalesced_flush_controller_throws_no_unhandled_rejection', async () => {
    controller.update = async () => {
      throw new Error('coalesced controller update failed');
    };
    const session = makeSession();
    await session.start();

    await pushText(session, 'coalesced');
    await vi.advanceTimersByTimeAsync(120);

    expect(unhandledRejections).toHaveLength(0);

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('test_anchor_coalesced_flush_both_paths_throw_no_unhandled_rejection', async () => {
    controller.update = async () => {
      throw new Error('coalesced controller failed');
    };
    const session = makeSession({
      connectorUpdateCard: async () => {
        throw new Error('coalesced fallback failed');
      },
    });
    await session.start();

    await pushText(session, 'coalesced');
    await vi.advanceTimersByTimeAsync(120);

    expect(unhandledRejections).toHaveLength(0);

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('test_anchor_finish_await_inflight_flush_then_terminal_wins', async () => {
    // finish await in-flight flush，保证 terminal patch 在 pre-terminal 之后。
    const patches: string[] = [];
    let updateCallCount = 0;
    let resolveUpdate: (() => void) | undefined;
    controller.update = async (card) => {
      updateCallCount++;
      // 第 2 次 update = flush 的 pre-terminal patch，阻塞直到手动 resolve。
      if (updateCallCount === 2) {
        await new Promise<void>((r) => {
          resolveUpdate = r;
        });
      }
      const resolved = typeof card === 'function' ? (card as (cur: object) => object)({}) : card;
      patches.push(JSON.stringify(resolved).includes('已完成') ? 'TERMINAL' : 'PRE');
    };
    const session = makeSession({ runId: 'run-p2' });
    await session.start();
    patches.length = 0;

    await pushText(session, 'inflight-content');
    await vi.advanceTimersByTimeAsync(120);

    const finishP = session.finish('done', { resultSubtype: 'success' });
    resolveUpdate?.();
    await finishP;

    // 最后一帧必须是 TERMINAL（finish 等 flushP → PRE 先 → TERMINAL 后）。
    expect(patches.at(-1)).toBe('TERMINAL');
    expect(patches.filter((p) => p === 'PRE').length).toBeGreaterThanOrEqual(1);

    await session.settle();
  });

  it('test_anchor_terminal_guard_skips_flush_after_finish', async () => {
    let updateCount = 0;
    controller.update = async () => {
      updateCount++;
    };
    const session = makeSession();
    await session.start();
    const updatesAfterStart = updateCount;

    await pushText(session, 'before-finish');
    await session.finish('done', { resultSubtype: 'success' });

    const updatesAfterFinish = updateCount;
    expect(updatesAfterFinish).toBe(updatesAfterStart + 1);

    await vi.advanceTimersByTimeAsync(150);
    expect(updateCount, 'no stale flush after finish').toBe(updatesAfterFinish);

    await session.settle();
  });

  it('test_anchor_finish_flushes_immediately_without_waiting_for_coalesce_window', async () => {
    const updates: object[] = [];
    controller.update = async (card) => {
      updates.push(typeof card === 'function' ? (card as (cur: object) => object)({}) : card);
    };
    const session = makeSession({ coalesceMs: 100, runId: 'run-f' });
    await session.start();
    updates.length = 0;

    for (let i = 0; i < 5; i++) {
      await pushText(session, `pre-finish-${i}`);
    }
    await session.finish('done', { resultSubtype: 'success' });

    const last = JSON.stringify(updates.at(-1));
    expect(last).toContain('已完成');
    expect(last).toContain('pre-finish-4');

    await session.settle();
  });

  it('test_anchor_residual_window_flush_does_not_lose_last_events', async () => {
    const updates: object[] = [];
    controller.update = async (card) => {
      updates.push(typeof card === 'function' ? (card as (cur: object) => object)({}) : card);
    };
    const session = makeSession({ coalesceMs: 100, runId: 'run-f' });
    await session.start();
    updates.length = 0;

    for (let i = 0; i < 3; i++) {
      await pushText(session, `residual-${i}`);
    }
    await vi.advanceTimersByTimeAsync(120);

    const flushed = JSON.stringify(updates.at(-1));
    expect(flushed).toContain('residual-0');
    expect(flushed).toContain('residual-2');

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('test_anchor_finish_cancels_pending_flush_no_stale_overwrite', async () => {
    const updates: object[] = [];
    controller.update = async (card) => {
      updates.push(typeof card === 'function' ? (card as (cur: object) => object)({}) : card);
    };
    const session = makeSession({ coalesceMs: 100, runId: 'run-f' });
    await session.start();
    updates.length = 0;

    await pushText(session, 'stale-candidate');
    await session.finish('done', { resultSubtype: 'success' });

    const updatesAfterFinish = updates.length;
    await vi.advanceTimersByTimeAsync(150);

    expect(JSON.stringify(updates.at(-1))).toContain('已完成');
    expect(updates.length, 'stale flush fired after finish').toBe(updatesAfterFinish);

    await session.settle();
  });

  it('test_anchor_push_during_inflight_flush_content_preserved_by_finish', async () => {
    // 让 flush 的 controller.update（第 2 次调用）阻塞，制造 in-flight 窗口。
    let resolveUpdate: (() => void) | undefined;
    let callCount = 0;
    let finishCardJson = '';
    controller.update = async (card) => {
      callCount++;
      const resolved = typeof card === 'function' ? (card as (cur: object) => object)({}) : card;
      const json = JSON.stringify(resolved);
      if (json.includes('已完成')) finishCardJson = json;
      if (callCount === 2) {
        await new Promise<void>((r) => {
          resolveUpdate = r;
        });
      }
    };
    const session = makeSession({ runId: 'run-if' });
    await session.start();

    await pushText(session, 'event-1');
    await vi.advanceTimersByTimeAsync(120);
    await pushText(session, 'event-2');

    resolveUpdate?.();
    await session.finish('done', { resultSubtype: 'success' });

    expect(finishCardJson).toContain('event-1');
    expect(finishCardJson).toContain('event-2');

    await session.settle();
  });

  it('test_anchor_coalesced_push_resolves_before_window_flush_fire_and_forget', async () => {
    let updateStarted = false;
    controller.update = async () => {
      updateStarted = true;
    };
    const session = makeSession({ coalesceMs: 100, runId: 'run-a' });
    await session.start();
    updateStarted = false;

    await pushText(session, 'fast');
    // push 已 resolve；窗口未到期，update 未触发（fire-and-forget）。
    expect(updateStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(120);
    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('test_anchor_disabled_push_resolves_only_after_synchronous_flush', async () => {
    let updateHappened = false;
    controller.update = async () => {
      updateHappened = true;
    };
    const session = makeSession({ coalesceMs: 0, runId: 'run-a' });
    await session.start();

    await pushText(session, 'sync');
    // push resolve 时 update 必须已发生（同步 flush 契约）。
    expect(updateHappened).toBe(true);

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });
});
