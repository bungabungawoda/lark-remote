import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from '../../src/card/run-card-session.js';

/**
 * PROBE (P1-3 coalesced-path flush error handling) — 生产路径使用默认 coalesceMs=100，
 * push fire-and-forget 调 scheduleFlush → timer 回调 `void this.flush()`。若
 * flush() → updateCard() 内部抛错，`void` 丢弃的 rejection 变成 detached
 * unhandled rejection。本 probe 验证：
 *
 * ① coalesced flush 的 controller.update 抛错时，不导致 unhandled rejection
 *    崩溃进程（updateCard 内部 try/catch 捕获）。
 * ② coalesced flush 的 controller.update 抛错 + connector.updateCard fallback
 *    也抛错时，不导致 unhandled rejection（双路径均 catch）。
 * ③ flush 终态守卫：finish 转终态后，timer 触发的 flush 跳过 patch（不覆盖终态卡）。
 *
 * 依据：第三轮 review P3「coalesced-path void this.flush() rejection 完全无测试」。
 * 当前所有 push 错误处理测试都设 coalesceMs:0（同步路径），生产路径的 detached
 * flush rejection 无覆盖。
 */
describe('RunCardSession coalesced-path flush error (P1-3 probe)', () => {
  let unhandledRejections: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    unhandledRejections = [];
    process.on('unhandledRejection', captureRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', captureRejection);
    vi.useRealTimers();
  });

  function captureRejection(reason: unknown) {
    unhandledRejections.push(reason);
  }

  function makeSession(opts: {
    controllerUpdate: () => Promise<void>;
    connectorUpdateCard?: () => Promise<void>;
  }): RunCardSession {
    const controller: CardStreamController = {
      messageId: 'card-err',
      current: {},
      update: opts.controllerUpdate,
    };
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-err';
      },
      updateCard: opts.connectorUpdateCard ?? (async () => {}),
    };
    return new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-err',
      // 使用默认 coalesceMs=100（生产路径）
    });
  }

  it('probe_coalesced_flush_controller_throws_no_unhandled_rejection', async () => {
    const session = makeSession({
      controllerUpdate: async () => {
        throw new Error('coalesced controller update failed');
      },
    });
    await session.start();

    // push 触发合批调度（fire-and-forget）
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'coalesced' }] },
    });

    // 推进 timer 让 flush 触发
    await vi.advanceTimersByTimeAsync(120);

    // 无 unhandled rejection
    expect(unhandledRejections).toHaveLength(0);

    // session 仍可正常 finish
    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('probe_coalesced_flush_both_paths_throw_no_unhandled_rejection', async () => {
    const session = makeSession({
      controllerUpdate: async () => {
        throw new Error('coalesced controller failed');
      },
      connectorUpdateCard: async () => {
        throw new Error('coalesced fallback failed');
      },
    });
    await session.start();

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'coalesced' }] },
    });

    await vi.advanceTimersByTimeAsync(120);

    // 双路径均 catch，无 unhandled rejection
    expect(unhandledRejections).toHaveLength(0);

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('probe_finish_await_inflight_flush_then_terminal_wins', async () => {
    // 验证 P2 修复核心路径：finish await in-flight flush，保证 terminal patch 在
    // pre-terminal 之后。人为延迟 flush 的 controller.update 让它在 finish 时仍
    // in-flight。时序：push → timer 到期触发 flush（flush 的 controller.update
    // 阻塞）→ finish → finish 等 flushP → resolve controller.update(PRE) →
    // finish 的 updateCard(TERMINAL)。
    //
    // 注意：start() 自带一次初始 controller.update（基类 card-session.ts:103），
    // 那次必须放行（否则 controllerReady 永不 resolve，start() 挂起）。只阻塞
    // flush 触发的那次 update（第 2 次），让它在 finish 时仍 in-flight。
    const patches: string[] = [];
    let updateCallCount = 0;
    let resolveUpdate: (() => void) | undefined;
    const controller: CardStreamController = {
      messageId: 'card-p2',
      current: {},
      update: async (card) => {
        updateCallCount++;
        // 第 2 次 update = flush 的 pre-terminal patch，阻塞直到手动 resolve，
        // 模拟"in-flight flush 在 finish 时仍未完成"的真实时序。
        if (updateCallCount === 2) {
          await new Promise<void>((r) => {
            resolveUpdate = r;
          });
        }
        const resolved = typeof card === 'function' ? (card as (cur: object) => object)({}) : card;
        const json = JSON.stringify(resolved);
        patches.push(json.includes('已完成') ? 'TERMINAL' : 'PRE');
      },
    };
    const connector = {
      streamCard: async (
        _c: string,
        _i: object,
        p: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await p(controller);
        return 'card-p2';
      },
      updateCard: async () => {},
    };
    const session = new RunCardSession({ connector, chatId: 'chat-1', runId: 'run-p2' });
    await session.start();
    patches.length = 0;

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'inflight-content' }] },
    });

    // 推进 timer 让 flush 触发：flush 的 controller.update 是第 2 次调用，会阻塞。
    // 用 advanceTimersByTimeAsync 推进到 timer 回调执行 + flush async 启动到阻塞点。
    await vi.advanceTimersByTimeAsync(120);

    // 此时 flush in-flight（flushP 非空，controller.update 卡在 await Promise）。
    // 调 finish：cancelPendingFlush（无 pending，timer 已执行）+ await flushP + 终态 patch。
    const finishP = session.finish('done', { resultSubtype: 'success' });

    // 放行 in-flight flush 的 controller.update → PRE patch 落地 → flushP resolve
    // → finish 的终态 updateCard 才执行 → TERMINAL patch 落地（后于 PRE）。
    resolveUpdate?.();

    await finishP;

    // 最后一帧必须是 TERMINAL（P2 核心契约：finish 等 flushP → PRE 先 → TERMINAL 后）。
    expect(patches.at(-1)).toBe('TERMINAL');
    // 期间至少有一次 PRE（in-flight flush 的 pre-terminal patch 确实发生了）。
    expect(patches.filter((p) => p === 'PRE').length).toBeGreaterThanOrEqual(1);

    await session.settle();
  });

  it('probe_terminal_guard_skips_flush_after_finish', async () => {
    // flush 的终态守卫：finish 转终态后，延迟触发的 flush 跳过 patch
    let updateCount = 0;
    const session = makeSession({
      controllerUpdate: async () => {
        updateCount++;
      },
    });
    await session.start();
    const updatesAfterStart = updateCount;

    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'before-finish' }] },
    });
    // 不推进 timer，直接 finish（cancel pending + await 无 in-flight + render 终态）
    await session.finish('done', { resultSubtype: 'success' });

    const updatesAfterFinish = updateCount;
    // finish 的终态 patch 计 1 次
    expect(updatesAfterFinish).toBe(updatesAfterStart + 1);

    // 推进 timer——被取消的 pending 不触发；flushP 无 in-flight → 无额外 patch
    await vi.advanceTimersByTimeAsync(150);
    expect(updateCount, 'no stale flush after finish').toBe(updatesAfterFinish);

    await session.settle();
  });
});
