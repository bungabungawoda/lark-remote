import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import type { InterruptOutcome } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner, AgentRunner } from '../../../src/runner/index.js';
import { AgentRegistry } from '../../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { sleep, waitFor } from '../../lib/wait-for.js';
import {
  createGatedRunner,
  createStubRunner,
  createStubConnector,
  type GatedRunner,
} from '../../lib/bridge-stubs.js';
import { mockLogger } from '../../lib/logger-mock.js';
import { createRouterFixture } from '../../lib/router-fixture.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * queue.immediate 的用户可见反馈簇：最终 toast 必须与队列事实一致
 * （未撤销却承诺执行 / 已开始却宣称未安排 / 无 run 却宣称停止 / 误清目标之后的任务 /
 * 误停其他 workspace 的 run）。每个用例用真实 Bridge + Router + 可控 runner
 * 复现「队列链在 handler await 期间前进」的生产竞态。
 */

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-immediate-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    cwd: { default: '' },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.immediate final feedback must say the target STARTED when it began during the interrupt window', () => {
  it('test_anchor_immediate_target_began_final_toast_not_claim_not_scheduled', async () => {
    // 验证什么行为：用户对排队任务 T2 点「⚡ 立即执行」后，handleQueueImmediate
    // 在 `await interruptCurrentRun` 挂起期间队列链前进（T1 结束、T2 槽位 begin
    // 并从 queuedTasks 移除、T2 开始执行）；stop 恢复后，步骤 6 的最终成员资格
    // 校验发现目标已不在队列，此时最终反馈必须区分两种事实：
    //   - 目标已**撤销**：不会执行 → 反馈"未安排执行"（已覆盖）；
    //   - 目标已**开始执行**：正在运行 → 反馈必须承认"已开始执行"，
    //     绝不能发送"未安排执行"——任务明明在跑，却告诉用户没被安排执行。
    //
    // 缺失会导致什么问题：当前步骤 6 对两种缺失原因共用一条文案
    // "⚠️ 目标消息已不在队列中（可能已被撤销或已开始执行），未安排执行。已清除 N 条
    // 排队消息。"。目标任务在 interrupt 窗口内 begin 后，用户同时看到目标的排队卡
    // 已被翻成 "▶️ 已开始执行"（begin 路径 updateQueueCardToExecuting），正文却宣称
    // "未安排执行"——卡片与正文直接矛盾；若用户在等这条消息的结果，会误以为自己的
    // 指令被丢弃、去重复发送，实际 T2 正在执行，重复发送反而污染会话/队列。这与
    // （撤销竞态下 toast 不得承诺执行）是同一根因的另一半：管住"未撤销却承诺
    // 执行"，本测试管住"已开始却宣称未安排"——最终反馈必须与队列事实一致，不能对
    // 执行中的任务说"未安排执行"。
    //
    // 依据：router handleQueueImmediate 步骤 6 注释明文规定最终 toast 是"对未来
    // 事实的承诺"（success toast 承诺"您的消息将立即执行"），因此必须先按最新成员
    // 资格判定；成员资格缺失只有"撤销"与"开始执行"两种原因，文案必须区分两者。
    // 卡片反馈约束（反馈不得与事实矛盾、miss 必须可见）同族要求；
    // 锚点已确立"目标在 interrupt 窗口内 begin 是真实可达状态"（T1 结束 →
    // begin 可以在 stop 在途时完成），本测试是该状态的反馈面。
    const connector = createStubConnector();
    const runner = createStubRunner();
    const { bridge, router } = createRouterFixture({
      tmpDir,
      config,
      connector,
      runner,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // --- 步骤 1：T1（meta，挂起）开始执行，阻塞队列 ---
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    let t1Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t1Started = true;
        await hang1;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-1',
          messagePreview: 'task 1 running',
        },
      },
    );
    expect(await waitFor(() => t1Started)).toBe(true);

    // --- 步骤 2：T2（目标任务，挂起）排队 ---
    let release2: () => void = () => {};
    const hang2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let t2Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t2Started = true;
        await hang2;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 immediate target',
        },
      },
    );
    expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'msg-2') !== undefined)).toBe(true);

    // --- 步骤 3：挂起 interruptCurrentRun（同款：模拟 stop 在途，队列链
    // 可在这期间推进到目标任务的 begin）---
    let resolveStop: (v: InterruptOutcome) => void = () => {};
    const stopInFlight = new Promise<InterruptOutcome>((resolve) => {
      resolveStop = resolve;
    });
    const stopSpy = vi.spyOn(bridge, 'interruptCurrentRunDetailed').mockReturnValue(stopInFlight);

    // --- 步骤 4：触发「立即执行」（不 await，停在 interrupt 挂起点）---
    const immediateDone = router.handleCardAction(
      { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    expect(await waitFor(() => stopSpy.mock.calls.length === 1)).toBe(true);

    // --- 步骤 5：队列链前进：T1 结束 → T2 begin（从 queuedTasks 移除、执行中挂起）---
    release1();
    expect(await waitFor(() => t2Started)).toBe(true);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeUndefined(); // T2 已开始执行

    // --- 步骤 6：stop 此刻完成，handler 恢复并执行步骤 3/4.5/6 ---
    resolveStop({ stopped: true });
    await immediateDone;
    await sleep(20);

    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');

    // 修复前：步骤 6 对"已开始执行"与"已撤销"共用
    // "…（可能已被撤销或已开始执行），未安排执行。…" 文案。本用例钉住：
    // 目标正在执行，最终反馈不得宣称"未安排执行"。
    expect(sentTexts.some((t) => t.includes('未安排执行'))).toBe(false);
    // 正向契约：反馈必须承认目标已开始执行（与卡片 "▶️ 已开始执行" 一致）。
    expect(sentTexts.some((t) => t.includes('已开始执行'))).toBe(true);

    // --- 清理：放行 T2，让队列链自然收尾 ---
    release2();
    await sleep(50);
  });
});

describe('queue.immediate must not remove tasks queued BEHIND the target when the target began while the stop was in flight', () => {
  it('test_anchor_immediate_target_began_keeps_tasks_behind_target', async () => {
    // 验证什么行为：用户对排队任务 T2 点「⚡ 立即执行」后，handleQueueImmediate
    // 在 `await interruptCurrentRun` 期间队列链前进（T1 结束、T2 的槽位 begin 并
    // 从 queuedTasks 移除、T2 开始执行）；stop 恢复后，步骤 3 的"清除目标任务之前
    // 消息"循环必须仍然只删除 T2 **之前**的任务——T3（排在 T2 之后）必须原样保留
    // 排队状态，绝不能因目标任务已不在队列快照里而被一并撤销。
    //
    // 缺失会导致什么问题：步骤 3 的循环 `for (task of tasks) { if (task.messageId
    // === messageId) break; ... }` 只在快照里**遇到目标任务**时才 break。若 T2 在
    // interrupt 挂起期间已经 begin（被移除），快照里没有 messageId 可命中，循环
    // 把**剩余全部**排队任务都 removeFromQueue——包括排在 T2 之后的 T3/T4。用户
    // 没撤销过 T3，却收到"❌ 已撤销"卡片，T3 永远不执行；toast 还报告
    // "清除了 N 条排队消息"（N 含目标之后的消息），与锚点确立的不变量
    // （"立即执行只清除目标任务之前的消息，之后的保持原相对顺序"）直接冲突。
    // 该竞态是真实可达的：handleQueueImmediate 自身注释明确承认 "The queue chain
    // can advance while later awaits (interruptCurrentRun / markQueueCardExecuting's
    // card send) are in flight"；生产上 runner.stop 与卡片 finish 均含 Feishu API
    // 往返，进程退出到 handler 恢复之间的窗口足以让目标任务 begin。
    //
    // 依据：router handleQueueImmediate 步骤 3 注释 "Remove all tasks BEFORE this
    // one (by messageId, not index)"——语义边界是"目标之前"；锚点
    // (queue-card-arm-edit-immediate-order) 已确立 T3 保持原相对顺序、
    // 不得先于或替代目标被清除。步骤 4 注释 "DO NOT remove the target task" 同样
    // 只豁免目标本身，未授权清除目标之后的任务。
    const connector = createStubConnector();
    const runner = createStubRunner();
    const { bridge, router } = createRouterFixture({
      tmpDir,
      config,
      connector,
      runner,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // --- 步骤 1：T1（meta，挂起）开始执行，阻塞队列 ---
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang1;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-1',
          messagePreview: 'task 1 running',
        },
      },
    );
    await sleep(50);

    // --- 步骤 2：T2（目标任务，挂起）与 T3（排在 T2 之后）依次排队 ---
    let release2: () => void = () => {};
    const hang2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let t2Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t2Started = true;
        await hang2;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 immediate target',
        },
      },
    );
    bridge.enqueue(
      tmpDir,
      async () => {
        // 应保持排队；本闭包不应执行
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 queued behind target',
        },
      },
    );
    await sleep(100);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeDefined();
    expect(bridge.getQueuedTask(tmpDir, 'msg-3')).toBeDefined();

    // --- 步骤 3：挂起 interruptCurrentRun（模拟 runner.stop / 卡片 finish 在途，
    // 即同类生产竞态：外部停止操作尚未返回，队列链已可前进）---
    let resolveStop: (v: InterruptOutcome) => void = () => {};
    const stopInFlight = new Promise<InterruptOutcome>((resolve) => {
      resolveStop = resolve;
    });
    const stopSpy = vi.spyOn(bridge, 'interruptCurrentRunDetailed').mockReturnValue(stopInFlight);

    // --- 步骤 4：触发「立即执行」（不 await，让它停在 interrupt 挂起点）---
    const immediateDone = router.handleCardAction(
      { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    expect(await waitFor(() => stopSpy.mock.calls.length === 1)).toBe(true);

    // --- 步骤 5：队列链前进：T1 结束 → T2 begin（从 queuedTasks 移除、执行中挂起）---
    release1();
    expect(await waitFor(() => t2Started)).toBe(true);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeUndefined(); // T2 已开始执行
    expect(bridge.getQueuedTask(tmpDir, 'msg-3')).toBeDefined(); // T3 仍在排队（T2 之后）

    // --- 步骤 6：stop 此刻完成，handler 恢复并执行步骤 3 的清除循环 ---
    resolveStop({ stopped: true });
    await immediateDone;

    // 修复前：快照 [msg-3] 中没有 msg-2 可 break → T3 被 removeFromQueue 误删。
    // 本用例钉住（期望 T3 仍在排队，因为它排在目标任务**之后**）。
    expect(bridge.getQueuedTask(tmpDir, 'msg-3')).toBeDefined();

    // --- 清理：放行 T2，让队列链自然收尾 ---
    release2();
    await sleep(50);
  });
});

describe('queue.immediate entry-time missing target must not claim the queue was cleared', () => {
  it('test_anchor_immediate_entry_missing_target_feedback_does_not_claim_queue_cleared', async () => {
    // 验证什么行为：队列 [T1执行中, T2(目标任务)排队, T3(排在T2之后)排队] 上，
    // 正常结束后 T2 的槽位 begin（从 queuedTasks 移除、开始执行），**之后**
    // 用户才点 T2 排队卡上的「⚡ 立即执行」（真实可达：T2 begin 的卡片更新
    // updateQueueCardToExecuting 要先 await 排队卡 send 的 promise，按钮在这
    // 之前仍是可点的排队态；或 SDK 延迟投递旧回调）。handleQueueImmediate 入口
    // 同步读 getQueuedTask 返回 undefined，走 `!targetTask` 分支。期望：该分支
    // 的反馈**不得声称"队列已清空"**——本分支没有执行任何 removeFromQueue，
    // 排在 T2 之后的 T3 仍原样排队；同时反馈也不得承诺"您的消息将立即执行"。
    //
    // 缺失会导致什么问题：当前实现发送 "该消息已开始执行，无法立即执行。
    // 队列已清空。"——队列根本没有清空（T3 仍在排队），这是对用户可见状态的
    // 直接撒谎：①用户以为排在其后的消息已被清除，不再关注/重新发送，T3 却
    // 在队列里继续消耗 Claude；②若 T3 是用户本想撤销的危险指令，用户误以为它
    // 已被清掉，危险指令仍会执行且无任何提示；③与锚点确立的同一契约
    // （queue.immediate 的最终反馈必须与队列事实一致，不得承诺未发生的状态
    // 变化）相冲突——修的是步骤 6 的 mid-flight 撤销面，入口 `!targetTask`
    // 分支仍是同根因的残余面：它既没有像步骤 6 那样重新校验成员资格，也没有
    // 按真实状态修正文案，反而保留了早于修复的旧谎言。函数注释 "we can
    // still clear queue" 也是死意图——代码路径上没有任何清除动作，清除也违反
    // 锚点（目标任务已 begin 时，排在目标**之后**的任务必须保留）。
    //
    // 依据：router handleQueueImmediate 步骤 1 注释（"The queue chain can
    // advance while later awaits are in flight, so the target must be read
    // synchronously at entry"）承认入口读一次之后目标可能已 begin；锚点
    // (queue-card-arm-immediate-cancel-toast) 确立"最终反馈必须与队列
    // 事实一致"；锚点 (queue-card-arm-immediate-target-began) 确立
    // "目标已 begin 时，排在目标之后的任务必须原样保留"——本分支同样处于
    // "目标已不在队列"状态，清除队列不是合法修复，反馈只能如实报告。
    const connector = createStubConnector();
    const runner = createStubRunner();
    const { bridge, router } = createRouterFixture({
      tmpDir,
      config,
      connector,
      runner,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // --- 步骤 1：T1（meta，挂起）开始执行，阻塞队列 ---
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    let t1Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t1Started = true;
        await hang1;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm1',
          messagePreview: 'task 1 running',
        },
      },
    );
    expect(await waitFor(() => t1Started)).toBe(true);

    // --- 步骤 2：T2（目标任务，挂起）与 T3（排在 T2 之后，挂起）依次排队 ---
    let release2: () => void = () => {};
    const hang2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let t2Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t2Started = true;
        await hang2;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm2',
          messagePreview: 'task 2 immediate target',
        },
      },
    );
    let release3: () => void = () => {};
    const hang3 = new Promise<void>((resolve) => {
      release3 = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang3;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm3',
          messagePreview: 'task 3 queued behind target',
        },
      },
    );
    expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'm2') !== undefined)).toBe(true);
    expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'm3') !== undefined)).toBe(true);

    // --- 步骤 3：T1 结束，队列链前进 → T2 begin（从队列移除并开始执行）---
    release1();
    expect(await waitFor(() => t2Started)).toBe(true);
    expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'm2') === undefined)).toBe(true);
    expect(bridge.getQueuedTask(tmpDir, 'm3')).toBeDefined(); // T3 仍在排队（T2 之后）

    // --- 步骤 4：此时用户点 T2 的「⚡ 立即执行」→ 入口 getQueuedTask 已是
    // undefined，走 `!targetTask` 早退分支（不 await interrupt、不触碰队列）---
    await router.handleCardAction({ cmd: 'queue.immediate', cwd: tmpDir, messageId: 'm2' }, ctx);
    await sleep(20);

    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');

    // 前置（非行为断言）：handler 确实发送了"无法立即执行"的反馈，不是静默吞掉。
    expect(sentTexts.some((t) => t.includes('无法立即执行'))).toBe(true);
    // 前置：T3 必须保持排队（目标已 begin 时不清除排在目标之后的任务）。
    expect(bridge.getQueuedTask(tmpDir, 'm3')).toBeDefined();

    // 修复前：发送 "该消息已开始执行，无法立即执行。队列已清空。"——队列
    // 实际未被清空（T3 仍在），本用例钉住：反馈不得声称"队列已清空"。
    expect(sentTexts.some((t) => t.includes('队列已清空'))).toBe(false);
    // 同时也不得承诺执行（同族约束）。
    expect(sentTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(false);

    // --- 清理：放行 T2、T3，让队列链自然收尾 ---
    release2();
    release3();
    await sleep(50);
  });
});

describe('queue.immediate must not promise execution in its final toast after the target was cancelled mid-flight', () => {
  it('test_anchor_immediate_cancel_race_final_toast_does_not_promise_execution', async () => {
    // 验证什么行为：用户对排队任务 T2 点「⚡ 立即执行」后，handleQueueImmediate 在
    // `await interruptCurrentRun` 挂起期间，用户又对同一任务点了「❌ 撤销」（两者同属
    // immediate lane，fire-and-forget 并发，该交错真实可达：立即执行要先停当前任务，
    // 撤销的 removeFromQueue 可在这个窗口完成）。撤销成功移除 T2 并把其卡片更新为
    // "❌ 已撤销"。interrupt 恢复后，handleQueueImmediate 必须意识到目标已不在队列：
    // markQueueCardExecuting 已有 started=false 成员守卫（不会把撤销卡翻回执行态），
    // 但最后一步 toast 仍不得发送 "⚡ 已停止当前任务，清除了 N 条排队消息。您的消息将
    // 立即执行。" —— 最终反馈必须与队列事实一致：T2 已撤销、不会执行。
    //
    // 缺失会导致什么问题：handler 只在入口同步读一次 targetTask，步骤 3/4.4/4.5 全部
    // 基于"目标仍在队列"的假设，最终 toast 不重新校验成员资格。T2 被并发撤销后，
    // 用户同时看到 "❌ 已撤销" 卡片和 "您的消息将立即执行" 正文——两条反馈直接矛盾；
    // 的队列槽位 begin 时被取消守卫跳过，永远不会执行，toast 是永久谎言。且用户
    // 已无补救入口：撤销卡与执行卡按钮全部禁用，唯一的行为依据（正文）指向相反结论。
    // 若 T2 是编辑过的危险指令修正，撤销后修正不会生效，用户却以为它即将执行——
    // 与锚点（撤销卡不得被迟到的执行态覆盖）同族：管住了卡片，toast 仍未覆盖，
    // 属于同一个"跨 await 成员资格失效"根因的残余面。
    //
    // 依据：router handleQueueImmediate 步骤 1 注释明文规定 "The queue chain can
    // advance while later awaits are in flight, so the target must be read
    // synchronously at entry"——入口读一次只保证入口时刻的成员资格，之后的每个
    // await（interruptCurrentRun / markQueueCardExecuting）都可能改变它；步骤 4.5
    // 之后的成功 toast 是对未来事实的承诺（"您的消息将立即执行"），必须先确认目标
    // 仍在队列。锚点已确立同一契约：任何跨 await 的后续动作/反馈必须按
    // 最新成员资格判定，不能沿用入口快照。卡片反馈约束（stop miss 必须
    // 可见、反馈不得静默撒谎）的同类要求。
    const connector = createStubConnector();
    const runner = createStubRunner();
    const { bridge, router } = createRouterFixture({
      tmpDir,
      config,
      connector,
      runner,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // --- 步骤 1：T1（meta，挂起）开始执行，阻塞队列 ---
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    let t1Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t1Started = true;
        await hang1;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-1',
          messagePreview: 'task 1 running',
        },
      },
    );
    expect(await waitFor(() => t1Started)).toBe(true);

    // --- 步骤 2：A（T2 之前）与 T2（目标任务）依次排队 ---
    let releaseA: () => void = () => {};
    const hangA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hangA;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-A',
          messagePreview: 'task A before target',
        },
      },
    );
    let release2: () => void = () => {};
    const hang2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang2;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 immediate target',
        },
      },
    );
    expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'msg-A') !== undefined)).toBe(true);
    expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'msg-2') !== undefined)).toBe(true);

    // --- 步骤 3：挂起 interruptCurrentRun（同款：模拟 stop 在途，队列链/其他
    // cardAction 可在这期间推进）---
    let resolveStop: (v: InterruptOutcome) => void = () => {};
    const stopInFlight = new Promise<InterruptOutcome>((resolve) => {
      resolveStop = resolve;
    });
    const stopSpy = vi.spyOn(bridge, 'interruptCurrentRunDetailed').mockReturnValue(stopInFlight);

    // --- 步骤 4：触发「立即执行」（不 await，停在 interrupt 挂起点）---
    const immediateDone = router.handleCardAction(
      { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    expect(await waitFor(() => stopSpy.mock.calls.length === 1)).toBe(true);

    // --- 步骤 5：interrupt 在途期间，用户对同一目标任务点「❌ 撤销」---
    // 撤销成功：T2 从队列移除、卡片更新为 "❌ 已撤销"、发送确认正文。
    await router.handleCardAction({ cmd: 'queue.cancel', cwd: tmpDir, messageId: 'msg-2' }, ctx);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeUndefined();
    expect(bridge.getQueuedTask(tmpDir, 'msg-A')).toBeDefined(); // T2 之前的 A 仍在排队

    // --- 步骤 6：stop 此刻完成，immediate 恢复执行后续步骤 ---
    resolveStop({ stopped: true });
    await immediateDone;
    await sleep(20);

    // 前置条件（非行为断言）：mark 路径的成员守卫生效，没有把已撤销卡翻回执行态。
    const executingCards = connector._cards.filter((c) => {
      const header = (c as { header?: { title?: { content?: string } } }).header;
      return header?.title?.content === '▶️ 已开始执行';
    });
    expect(executingCards.length).toBe(0);

    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');
    expect(sentTexts).toContain('✅ 已从队列中撤销');

    // 修复前：handler 不重新校验成员资格，最后 toast 仍发送
    // "⚡ 已停止当前任务，清除了 0 条排队消息。您的消息将立即执行。"
    // 本用例钉住：目标已撤销，正文不得再承诺执行。
    expect(sentTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(false);

    // --- 清理：放行 T1、A、T2（T2 槽位已被取消守卫跳过），让队列链自然收尾 ---
    release1();
    releaseA();
    release2();
    await sleep(50);
  });
});

describe('queue.immediate must not claim the target is executing when a task ahead of it escaped the stop window (anchor)', () => {
  it('test_anchor_immediate_target_card_and_toast_stay_pending_when_ahead_task_began_during_stop', async () => {
    // 验证什么行为：队列 [T1 执行中, A, T(目标)] 上，用户对 T 点「⚡ 立即执行」。
    // handleQueueImmediate 进入 interruptCurrentRun 并 await
    // Promise.allSettled([session.finish, runner.stop])——Feishu 卡片往返/进程
    // 收尾让 handler 在这一步停留。停留期间 T1 的队列链 settle 已让 A 接跑并真正
    // 开始执行（A 已从 queuedTasks 移除、beganMessageIds 记录）。handler 恢复后
    // 步骤 3 的快照只剩 [T]（A 不在快照里，清除循环无法移除一个已经接跑的任务），
    // 但步骤 4.5 仍把 T 的排队卡翻成「▶️ 已开始执行」、步骤 6 仍发
    // "⚡ 已停止当前任务，清除了 0 条排队消息。您的消息将立即执行。"。
    // 期望：当 handler 完成时 T 仍排在正在执行的 A 后面（T 从未接跑），T 的卡片
    // 必须保持「⏳ 消息排队中」（不得翻成已开始执行），toast 必须不得承诺
    // "您的消息将立即执行"——卡片与文案只能反映真实队列状态。
    //
    // 缺失会导致什么问题：①T 的卡片谎称"已开始执行"且按钮被禁用，用户看到执行卡
    // 却永远等不到 T 的结果（T 实际排在 A 后面，A 可能跑很久）；②toast 承诺立即
    // 执行与事实相反，用户无法补救（按钮已禁用、/stop 无目标）；③interruptCurrentRun
    // 恢复后按 cwd 无条件 activeRuns.delete，把停留窗口内新登记的 A 的追踪条目一并
    // 删掉（它停止的是 T1，删的是 A）——A 变成无主 run：/active 不可见、/stop
    // 停不到，只能等它自然结束。该竞态与（queue-card-arm-immediate-clear-yield）
    // 同属"队列链在 handler await 期间前进"的已承认竞态，但只覆盖了步骤 3
    // 卡片更新窗口（A/B 仍在队列、可被同步移除），未覆盖 interruptCurrentRun 的
    // 停止窗口——此窗口内 A 已接跑，快照式清除结构性漏掉它。
    //
    // 依据：router handleQueueImmediate 步骤 3/4 注释——"Remove all tasks BEFORE
    // this one"、"The queue will naturally execute it after the current task
    // (which we just stopped)"：语义承诺停止后 T 是下一个执行者；步骤 6 的
    // 注释明文规定最终 toast 必须反映真实状态（已确立"不得承诺不会发生
    // 的执行"）。锚点确立了清除必须在任何 await 前完成的不变量；本测试补上
    // 其未覆盖的停止窗口：任务在快照前接跑时，handler 要么再停掉它（使 T 真正
    // 接跑），要么如实反馈 T 仍在排队——绝不能翻卡 + 承诺立即执行。
    const created: Array<GatedRunner & AgentRunner> = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createGatedRunner();
      created.push(r);
      return r;
    });

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner: createGatedRunner(), // fallback, unused (registry path)
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      idleTimeoutMs: 0,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    let releaseT: () => void = () => {};
    const hangT = new Promise<void>((resolve) => {
      releaseT = resolve;
    });

    try {
      // --- 步骤 1：T1 经 forwardToClaude 真正执行（注册 activeRuns），阻塞队列 ---
      sessionStore.setCwd('u1', tmpDir);
      bridge.enqueue(
        tmpDir,
        async () => {
          await bridge.forwardToClaude('T1 running', ctx);
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm1',
            messagePreview: 'T1 running',
          },
        },
      );
      expect(await waitFor(() => created.length >= 1 && bridge.isBusyFor(tmpDir))).toBe(true);
      const runner1 = created[0];

      // --- 步骤 2：A（目标之前）与 T（目标）入队；A 也走 forwardToClaude ---
      bridge.enqueue(
        tmpDir,
        async () => {
          await bridge.forwardToClaude('A before target', ctx);
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'mA',
            messagePreview: 'A before target',
          },
        },
      );
      bridge.enqueue(
        tmpDir,
        async () => {
          await hangT;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'mT',
            messagePreview: 'T immediate target',
          },
        },
      );
      expect(
        await waitFor(
          () =>
            bridge.getQueuedTask(tmpDir, 'mA') !== undefined &&
            bridge.getQueuedTask(tmpDir, 'mT') !== undefined,
        ),
      ).toBe(true);

      // --- 步骤 3：触发「⚡ 立即执行」（不 await），停在 runner1.stop 的 gate ---
      const immediateDone = router.handleCardAction(
        { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'mT' },
        ctx,
      );
      expect(await waitFor(() => runner1.stopCalls === 1)).toBe(true);

      // --- 步骤 4：停止窗口内 T1 的 run settle → 队列链前进 → A 接跑并真正执行 ---
      runner1.releaseRun();
      expect(await waitFor(() => created.length >= 2 && bridge.isBusyFor(tmpDir))).toBe(true);
      expect(bridge.getQueuedTask(tmpDir, 'mT')).toBeDefined();

      // --- 步骤 5：放行 stop，interruptCurrentRun 完成，handler 恢复并跑完 ---
      runner1.releaseStop();
      await immediateDone;

      // --- 断言：T 仍排队（A 执行中，T 从未接跑）时卡片与 toast 必须如实 ---
      const tStillQueued = bridge.getQueuedTask(tmpDir, 'mT') !== undefined;
      if (tStillQueued) {
        const tCardId =
          connector._sent.find((s) => JSON.stringify(s.input).includes('T immediate target'))?.id ??
          '';
        const executingUpdatesForT = connector._updates.filter(
          (u) =>
            u.messageId === tCardId &&
            (u.card as { header?: { title?: { content?: string } } }).header?.title?.content ===
              '▶️ 已开始执行',
        );
        // 修复前：markQueueCardExecuting(started=false) 时 T 仍在队列 →
        // liveTask 存在 → T 的卡片被翻成已开始执行。
        expect(executingUpdatesForT).toHaveLength(0);

        const toastTexts = connector._sent
          .map((s) => (s.input as { text?: string }).text)
          .filter((t): t is string => !!t);
        // 修复前：步骤 6 的 finalTask 分支发
        // "⚡ 已停止当前任务，清除了 0 条排队消息。您的消息将立即执行。"。
        expect(toastTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(false);
      }

      // 清理：放行 A 的 run（created[1]）与 T 的挂起，让两条队列链 settle。
      if (created[1]) created[1].releaseRun();
      releaseT();
      await sleep(50);
    } finally {
      if (created[0]) created[0].releaseStop();
      if (created[1]) created[1].releaseRun();
      releaseT();
      await sleep(50);
    }
  });
});

describe('queue.immediate final feedback must not claim "未安排执行" when the target began AND completed during the stop window (anchor)', () => {
  /** Stub connector returning a UNIQUE card message id per sendWithRetry call. */
  let msgIdCounter = 0;
  function createUniqueMsgIdConnector() {
    const sent: { chatId: string; input: unknown; opts?: unknown; id: string }[] = [];
    const cards: object[] = [];
    const updates: { messageId: string; card: object }[] = [];
    return {
      sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
        const id = `msg-${++msgIdCounter}`;
        sent.push({ chatId, input, opts, id });
        return id;
      },
      sendFile: async (chatId: string, filePath: string) => {
        sent.push({
          chatId,
          input: { file: filePath },
          opts: undefined,
          id: `file-${++msgIdCounter}`,
        });
        return `file-msg-${msgIdCounter}`;
      },
      addReaction: async () => {},
      streamCard: async (
        chatId: string,
        initial: object,
        producer: (controller: {
          messageId: string;
          current: object;
          update(next: object | ((current: object) => object)): Promise<void>;
        }) => Promise<void>,
        opts2?: unknown,
      ) => {
        const id = `stream-${++msgIdCounter}`;
        sent.push({ chatId, input: { card: initial }, opts: opts2, id });
        cards.push(initial);
        let current = initial;
        await producer({
          messageId: id,
          get current() {
            return current;
          },
          update: async (next) => {
            current = typeof next === 'function' ? next(current) : next;
            cards.push(current);
            sent.push({ chatId, input: { card: current }, opts: opts2, id: `${id}-update` });
            updates.push({ messageId: id, card: current });
          },
        });
        return id;
      },
      updateCard: async (messageId: string, card: object) => {
        cards.push(card);
        updates.push({ messageId, card });
      },
      connected: true,
      _sent: sent,
      _cards: cards,
      _updates: updates,
    };
  }

  it('test_anchor_immediate_target_began_and_settled_final_toast_not_claim_not_scheduled', async () => {
    // 验证什么行为：队列 [T1 执行中, T(目标)] 上，用户对 T 点「⚡ 立即执行」。
    // handleQueueImmediate 进入 interruptCurrentRun 并 await
    // Promise.allSettled([session.finish, runner.stop])（生产上 runner.stop 与
    // 卡片收尾均含 Feishu API 往返，stop 窗口可达秒级）。窗口内 T1 的 run settle
    // 使队列链前进：T 的槽位 begin（从 queuedTasks 移除、beganMessageIds 加入、
    // 排队卡翻成「▶️ 已开始执行」），随后 T 是一个快速任务——在 stop 仍未放行时
    // 就已完成：T 的 settle 把 beganMessageIds 里 T 的条目删除。stop 恢复后，
    // handler 步骤 4.5 看到目标不在队列、步骤 6 hasTaskBegan(mT) 为 false——
    // 当前实现落入"撤销"分支，发送
    // "⚠️ 目标消息已不在队列中（可能已被撤销），未安排执行。已清除 0 条排队消息。"。
    // 期望：目标实际已开始执行并完成，最终反馈必须承认它执行过（如"已开始执行"），
    // 绝不能宣称"未安排执行"——"未安排执行"只允许用于真正被撤销（从未 begin）的目标。
    //
    // 缺失会导致什么问题：（目标 begin 后仍在运行）与（目标被撤销）各自
    // 覆盖了 hasTaskBegan 分支的一面，但第三态——目标 begin 后已 settle——
    // 让 beganMessageIds 提前清空，步骤 6 的二元判定把"已执行完毕"误判成"已撤销"。
    // 用户同时看到 T 的卡片已翻成「▶️ 已开始执行」、正文却宣称"未安排执行"，
    // 卡片与正文直接矛盾；用户以为自己的指令被丢弃（实际已执行），会重复发送，
    // 污染会话/队列。该竞态真实可达：已确立"stop 窗口内队列链可前进到目标
    // 的 begin"；目标若是快速任务（短指令、/status 类命令），在 stop 窗口内完成
    // 完全正常。卡片反馈约束（反馈不得与事实矛盾）与锚点的
    // "已开始却宣称未安排 = 谎言"同族，本测试补上未覆盖的"完成态"半边。
    //
    // 依据：router handleQueueImmediate 步骤 6 注释明文规定最终 toast 必须区分
    // "目标开始执行"（acknowledge）与"目标被撤销"（未安排执行）两种缺失原因；
    // 文案："目标任务在 interrupt 窗口内 begin 后…正文却宣称未安排执行——
    // 卡片与正文直接矛盾"。该不变量不因目标之后又完成而失效：任务跑完比"正在跑"
    // 更不能说"未安排执行"。queue-manager 的 beganMessageIds 注释（"A task leaves
    // the set when its slot settles"）正是本测试命中的状态转换点。
    const created: Array<GatedRunner & AgentRunner> = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createGatedRunner();
      created.push(r);
      return r;
    });

    const connector = createUniqueMsgIdConnector();
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner: createGatedRunner(), // fallback, unused (registry path)
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      idleTimeoutMs: 0,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    let t1Done: Promise<void> = Promise.resolve();
    let tDone = false;

    try {
      // --- 步骤 1：T1 经 forwardToClaude 真正执行（注册 activeRuns），阻塞队列 ---
      sessionStore.setCwd('u1', tmpDir);
      bridge.enqueue(
        tmpDir,
        async () => {
          t1Done = bridge.forwardToClaude('T1 running', ctx);
          await t1Done;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm1',
            messagePreview: 'T1 running',
          },
        },
      );
      expect(await waitFor(() => created.length >= 1 && bridge.isBusyFor(tmpDir))).toBe(true);
      const runner1 = created[0];

      // --- 步骤 2：T（快速目标任务）排队 ---
      bridge.enqueue(
        tmpDir,
        async () => {
          tDone = true;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'mT',
            messagePreview: 'T immediate target',
          },
        },
      );
      expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'mT') !== undefined)).toBe(true);

      // --- 步骤 3：触发「⚡ 立即执行」（不 await），停在 runner1.stop 的 gate ---
      const immediateDone = router.handleCardAction(
        { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'mT' },
        ctx,
      );
      expect(await waitFor(() => runner1.stopCalls === 1)).toBe(true);

      // --- 步骤 4：停止窗口内 T1 的 run settle → 队列链前进 → T begin 并完成 ---
      runner1.releaseRun();
      // T 已执行完毕。began 标记是粘性的（修复）：任务一旦开始执行，标记
      // 保留至被上限修剪——正因如此，立即执行最终反馈能区分"已开始执行"
      // （含已 settle 的情况）与"真正撤销"。若 hasTaskBegan 不为 true，
      // 说明粘性语义被破坏，步骤 6 会再次误判为"未安排执行"。
      expect(await waitFor(() => tDone)).toBe(true);
      expect(bridge.hasTaskBegan('mT')).toBe(true);
      expect(bridge.getQueuedTask(tmpDir, 'mT')).toBeUndefined();

      // --- 步骤 5：放行 stop，interruptCurrentRun 完成，handler 恢复并跑完 ---
      runner1.releaseStop();
      await immediateDone;
      await sleep(20);

      // 前置（非行为断言）：目标确实执行过——T 的卡片已被 begin 路径翻成执行态。
      const tCardId =
        connector._sent.find((s) => JSON.stringify(s.input).includes('T immediate target'))?.id ??
        '';
      const executingUpdatesForT = connector._updates.filter(
        (u) =>
          u.messageId === tCardId &&
          (u.card as { header?: { title?: { content?: string } } }).header?.title?.content ===
            '▶️ 已开始执行',
      );
      expect(executingUpdatesForT.length).toBeGreaterThan(0);

      const sentTexts = connector._sent
        .map((s) => (s.input as { text?: string } | undefined)?.text)
        .filter((t): t is string => typeof t === 'string');
      // 修复前：目标 begin 后已 settle → hasTaskBegan=false → 落入撤销分支，
      // 发送 "⚠️ 目标消息已不在队列中（可能已被撤销），未安排执行。…"。本用例钉住：
      // 目标明明执行完毕，正文不得宣称"未安排执行"。
      expect(sentTexts.some((t) => t.includes('未安排执行'))).toBe(false);
      // 正向契约：反馈必须承认目标已开始执行（与卡片 "▶️ 已开始执行" 一致）。
      expect(sentTexts.some((t) => t.includes('已开始执行') || t.includes('已执行'))).toBe(true);
    } finally {
      // 清理：无论断言成败，放行 stop/run，让队列链 settle，避免悬空 promise。
      if (created[0]) created[0].releaseStop();
      if (created[0]) created[0].releaseRun();
      await Promise.allSettled([t1Done]);
      await sleep(50);
    }
  });
});

describe('queue.immediate must stop the run blocking the SAME cwd, not a parallel run in another workspace', () => {
  /**
   * A runner whose run() hangs forever until stop() releases it — faithful to a
   * real runner holding a live subprocess that only exits when stop() kills it.
   * Each instance counts its own stop() calls so the test can distinguish which
   * workspace's run was stopped (same pattern as
   * tests/bridge/bridge-clear-runners-active-run.test.ts).
   */
  interface TrackingHangingRunner extends Runner {
    stopCalls: number;
  }

  function createTrackingHangingRunner(): TrackingHangingRunner & AgentRunner {
    let release!: () => void;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: TrackingHangingRunner & AgentRunner = {
      isRunning: false,
      stopCalls: 0,
      stop: async () => {
        runner.stopCalls++;
        // Resolving the hang simulates the subprocess being killed and the run()
        // generator settling — which is what unblocks the workspace's queue chain.
        release();
      },
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        await hang;
      },
      kind: 'claude',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
      getStatusInfo: () => ({ kind: 'claude', model: 'test' }),
    };
    return runner;
  }

  let ws1: string;
  let ws2: string;

  beforeEach(() => {
    ws1 = path.join(tmpDir, 'ws1');
    ws2 = path.join(tmpDir, 'ws2');
    fs.mkdirSync(ws1);
    fs.mkdirSync(ws2);
  });

  it('test_anchor_queue_immediate_stops_run_blocking_same_workspace', async () => {
    // 验证什么行为：同一用户在两个 cwd 并行各有一个活跃 run（Bridge 明确
    // 支持："Multiple workspaces can have runs in parallel"，activeRuns 按 cwd
    // 键控、interruptCurrentRun 按 (userId, chatId) 匹配）。用户在 ws2 的排队卡
    // 上点「⚡ 立即执行」（卡片 payload 带 cwd=ws2、目标任务在 ws2 队列里），
    // 期望：被停止的必须是 ws2 队列头部正在运行的 R2（阻塞目标任务的 run），
    // ws1 的并行 run R1 必须原样继续执行；随后 ws2 队列链前进，目标任务立即接跑。
    //
    // 缺失会导致什么问题：handleQueueImmediate 调 interruptCurrentRun 时不传
    // cwd/runId，interruptCurrentRun 遍历 activeRuns（Map 按 cwd 插入序），
    // 命中第一个 (userId, chatId) 匹配的活跃 run——即先启动的 ws1 的 R1。于是
    // 「立即执行」停掉了**另一个 cwd** 的无关任务：①R1 的现场被毁
    // （用户另一个正在执行的任务被 SIGKILL）；②真正阻塞 ws2 队列的 R2 没被停，
    // 目标消息不会"立即执行"——卡片已被 markQueueCardExecuting 翻成
    // "▶️ 已开始执行"（按钮禁用、无法撤销），toast 承诺"您的消息将立即执行"，
    // 实际 ws2 队列仍被 R2 阻塞，目标任务遥遥无期；用户看到执行中卡片却收不到
    // 结果，且没有可用的停止入口（按钮已禁用、/stop 会再次命中错误的 run）。
    // 这是 round 6/7 引入 replacement 原位替换后仍存在的 cwd 维度串扰。
    //
    // 依据：router handleQueueImmediate 文档注释——"Stop current run, clear
    // queue before this message, execute this message immediately"；"current
    // run" 的上下文是卡片所在 cwd 的串行队列（queue-manager 按 cwd
    // 分队列、Bridge 注释 "Each cwd has its own serial queue for parallel
    // execution across workspaces"）。卡片回调 value 携带 cwd 正是用来
    // 标识队列身份；立即执行清的是该 cwd 队列中目标任务**之前**的任务，
    // 停的也必须是该 cwd 当前执行的任务，否则"立即执行"的承诺对象与实际
    // 副作用对象不一致。
    const created: TrackingHangingRunner[] = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createTrackingHangingRunner();
      created.push(r);
      return r;
    });

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner: createTrackingHangingRunner(), // fallback, unused (registry path)
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      idleTimeoutMs: 0,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    let run1Done: Promise<void> = Promise.resolve();
    let run2Done: Promise<void> = Promise.resolve();
    let t2Ran = false;

    try {
      // --- 步骤 1：ws1 先启动一个并行 run R1（经队列链，计数=1）---
      sessionStore.setCwd('u1', ws1);
      bridge.enqueue(
        ws1,
        async () => {
          run1Done = bridge.forwardToClaude('run in ws1', ctx);
          await run1Done;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm-r1',
            messagePreview: 'R1 running in ws1',
          },
        },
      );
      expect(await waitFor(() => created.length >= 1 && bridge.isBusyFor(ws1))).toBe(true);
      const runner1 = created[0];

      // --- 步骤 2：用户 /cd 到 ws2 并启动并行 run R2（阻塞 ws2 队列）---
      sessionStore.setCwd('u1', ws2);
      bridge.enqueue(
        ws2,
        async () => {
          run2Done = bridge.forwardToClaude('run in ws2', ctx);
          await run2Done;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm-r2',
            messagePreview: 'R2 running in ws2',
          },
        },
      );
      expect(await waitFor(() => created.length >= 2 && bridge.isBusyFor(ws2))).toBe(true);
      const runner2 = created[1];

      // --- 步骤 3：ws2 中排入目标消息 T2（拿到排队卡）---
      bridge.enqueue(
        ws2,
        async () => {
          t2Ran = true;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm-target',
            messagePreview: 'target queued in ws2',
          },
        },
      );
      expect(await waitFor(() => bridge.getQueuedTask(ws2, 'm-target') !== undefined)).toBe(true);

      // --- 步骤 4：对 ws2 的排队卡点「⚡ 立即执行」---
      await router.handleCardAction(
        { cmd: 'queue.immediate', cwd: ws2, messageId: 'm-target' },
        ctx,
      );
      await sleep(50);

      // 修复前：interruptCurrentRun 先命中 activeRuns 里的 ws1 run（Map 插入序
      // ws1 在前），runner1.stopCalls=1、runner2.stopCalls=0；ws1 被误停、
      // ws2 的阻塞 run 仍在。以下断言钉住正确行为。
      expect(runner1.stopCalls).toBe(0); // ws1 的并行 run 不得被停
      expect(runner2.stopCalls).toBe(1); // 阻塞 ws2 队列的 run 必须被停
      expect(bridge.isBusyFor(ws1)).toBe(true); // ws1 任务继续运行
      expect(bridge.isBusyFor(ws2)).toBe(false); // ws2 阻塞任务已停

      // --- 步骤 5：ws2 队列链前进，目标任务立即接跑（"您的消息将立即执行"）---
      expect(await waitFor(() => t2Ran)).toBe(true);
    } finally {
      // 清理：无论断言成败，停掉剩余活跃 run，让两条队列链 settle，避免悬空 promise。
      await bridge.interruptCurrentRun({ userId: 'u1', chatId: 'c1' });
      await Promise.allSettled([run1Done, run2Done]);
      await sleep(50);
    }
  });
});

describe('queue.immediate final toast must not claim a stop when no run was running (anchor)', () => {
  it('test_anchor_immediate_toast_without_stop_does_not_claim_stopped_current_task', async () => {
    // 验证什么行为：cwd 没有活跃 run（interruptCurrentRun 返回 false）时，
    // 「⚡ 立即执行」成功路径的 toast 不得包含"已停止当前任务"——没有停掉任何
    // 任务就不能宣称停过；"您的消息将立即执行"的承诺仍须保留。
    //
    // 缺失会导致什么问题：interruptCurrentRun 的返回值 `stopped` 被丢弃，toast
    // 恒为"⚡ 已停止当前任务，清除了 N 条…"，在无 run 可停时（链上只有排队任务、
    // 头部任务不是 run）对用户撒谎（finding）。
    //
    // 依据：router handleQueueImmediate 步骤 2 捕获 `stopped`（interruptCurrentRun
    // 是否真的停到了 run），最终 toast 是对事实的承诺——没有停止就不写停止；
    // 已确立"toast 不得与队列事实矛盾"的反馈契约。
    const connector = createStubConnector();
    const runner = createStubRunner();
    const { bridge, router } = createRouterFixture({
      tmpDir,
      config,
      connector,
      runner,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);

    // --- 步骤 1：A（目标之前，普通挂起闭包，不产生活跃 run）阻塞链头 ---
    let releaseA: () => void = () => {};
    const hangA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hangA;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'mA',
          messagePreview: 'A ahead of target',
        },
      },
    );

    // --- 步骤 2：T（目标）排队 ---
    bridge.enqueue(
      tmpDir,
      async () => {
        await bridge.forwardToClaude('target message', ctx);
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'mT',
          messagePreview: 'target message',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    // --- 步骤 3：对 T 点「⚡ 立即执行」——cwd 无活跃 run，stopped=false ---
    await router.handleCardAction({ cmd: 'queue.immediate', cwd: tmpDir, messageId: 'mT' }, ctx);

    // --- 步骤 4：断言 toast 文案 ---
    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');
    // 成功承诺保留。
    expect(sentTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(true);
    // 但不得宣称停掉了当前任务（stopped=false）。
    expect(sentTexts.some((t) => t.includes('已停止当前任务'))).toBe(false);

    // --- 清理：A 是链头挂起闭包（步骤 3 只移除其元数据，闭包仍在阻塞链）；
    // 放行 A 后 T 才会接跑并执行目标消息 ---
    releaseA();
    await new Promise((r) => setTimeout(r, 50));
    expect(fwdSpy).toHaveBeenCalledTimes(1);
    expect(fwdSpy).toHaveBeenCalledWith('target message', ctx);
  });
});

describe('queue executing count must not be reset onto the next task that began during the stop window (anchor)', () => {
  it('test_anchor_new_message_gets_queue_card_while_resumed_task_runs_after_stop', async () => {
    // 验证什么行为：队列 [T1 执行中, T 排队] 上，用户对 T 点「⚡ 立即执行」。
    // handleQueueImmediate → Bridge.interruptCurrentRun 在
    // Promise.allSettled([session.finish, runner.stop]) 处停留（停止窗口）；
    // 窗口内 T1 的队列链 settle（正常 decrement 2→1）→ 链前进 → T 接跑并真正
    // 执行（T 的 forwardToClaude 注册新 activeRun、executingSlot 指向 T 的
    // slot）。stop 放行后 interruptCurrentRun 恢复，若无条件
    // resetExecutingCount(cwd)，会把正在运行的 T 的计数清零，并把 interrupted
    // 标记授给 T 的 slot —— T settle 时跳过 decrement，计数在整个运行期间为 0，
    // 后续入队的新消息 hasWaitingTasks=false → 不弹「⏳ 消息排队中」卡
    // （原事故的另一个交错：只覆盖了"reset 发生在 T2 接跑之前"，
    // 这里 reset 发生在 T 接跑之后）。
    //
    // 期望：此时 T 仍在运行，新入队消息 M 必须收到 1 张排队卡（sentCards 增加）。
    // 缺失会导致什么问题：M 静默排队无任何用户反馈——用户看不到排队卡、无法
    // 撤销/立即执行/编辑，消息在后台空转（同款静默排队生产事故）。
    //
    // 依据：enqueue 的 hasWaitingTasks 语义（count>0 || queueLen>0 就必须发卡）
    // 是"只要队列里还有任务在排队或执行"；Bridge.interruptCurrentRun 的
    // resetExecutingCount 注释声称只清理"被外部中断的任务"的残留计数，不应
    // 波及停止窗口内已经接跑的新任务。锚点确立了计数必须反映真实执行
    // 状态；本测试用真实 interruptCurrentRun（gated runner 停在 runner.stop）
    // 复现其未覆盖的停止窗口。
    const created: Array<GatedRunner & AgentRunner> = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createGatedRunner();
      created.push(r);
      return r;
    });

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner: createGatedRunner(), // fallback, unused (registry path)
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      idleTimeoutMs: 0,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    let releaseM: () => void = () => {};
    const hangM = new Promise<void>((resolve) => {
      releaseM = resolve;
    });

    try {
      // --- 步骤 1：T1 经 forwardToClaude 真正执行（注册 activeRuns），阻塞队列 ---
      sessionStore.setCwd('u1', tmpDir);
      bridge.enqueue(
        tmpDir,
        async () => {
          await bridge.forwardToClaude('T1 running', ctx);
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm1',
            messagePreview: 'T1 running',
          },
        },
      );
      expect(await waitFor(() => created.length >= 1 && bridge.isBusyFor(tmpDir))).toBe(true);
      const runner1 = created[0];

      // --- 步骤 2：T 入队（T 的排队卡必须已发）---
      bridge.enqueue(
        tmpDir,
        async () => {
          await bridge.forwardToClaude('T running', ctx);
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'mT',
            messagePreview: 'T immediate target',
          },
        },
      );
      expect(await waitFor(() => bridge.getQueuedTask(tmpDir, 'mT') !== undefined)).toBe(true);
      expect(
        connector._sent.some((s) => JSON.stringify(s.input).includes('T immediate target')),
      ).toBe(true);

      // --- 步骤 3：触发「⚡ 立即执行」（不 await），停在 runner1.stop 的 gate ---
      const immediateDone = router.handleCardAction(
        { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'mT' },
        ctx,
      );
      expect(await waitFor(() => runner1.stopCalls === 1)).toBe(true);

      // --- 步骤 4：停止窗口内 T1 的 run settle → 队列链前进 → T 接跑并真正执行 ---
      // 的 finalizeRun 清掉 runner 缓存，T 的 forwardToClaude 会经 registry
      // 新建 runner（created[1]）并注册新的 activeRun（executingSlot=s2）。
      runner1.releaseRun();
      expect(
        await waitFor(
          () =>
            created.length >= 2 &&
            bridge.isBusyFor(tmpDir) &&
            bridge.getQueuedTask(tmpDir, 'mT') === undefined,
        ),
      ).toBe(true);
      const runnerT = created[1];

      // --- 步骤 5：放行 stop，interruptCurrentRun 完成，handler 恢复并跑完 ---
      runner1.releaseStop();
      await immediateDone;

      // --- 断言前置：T 仍在运行（新 activeRun 未被 interruptCurrentRun 删除）---
      expect(bridge.isBusyFor(tmpDir)).toBe(true);

      // --- 步骤 6：T 仍运行中入队 M → 必须收到 1 张排队卡 ---
      bridge.enqueue(
        tmpDir,
        async () => {
          await hangM;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'mM',
            messagePreview: 'M after stop',
          },
        },
      );
      await sleep(50);
      const mQueueCards = connector._sent.filter((s) =>
        JSON.stringify(s.input).includes('M after stop'),
      );
      // 修复前：interruptCurrentRun 在 stop 后无条件 resetExecutingCount，
      // 把接跑任务 T 的计数清零并标记 T 的 slot 为 interrupted → M 入队时
      // count=0/queueLen=0 → hasWaitingTasks=false → 不发排队卡。
      expect(mQueueCards).toHaveLength(1);

      // 清理：放行 T 的 run 与 M 的挂起，让两条队列链自然收尾。
      runnerT.releaseRun();
      releaseM();
      await sleep(50);
    } finally {
      if (created[0]) created[0].releaseStop();
      if (created[1]) created[1].releaseRun();
      releaseM();
      await sleep(50);
    }
  });
});
