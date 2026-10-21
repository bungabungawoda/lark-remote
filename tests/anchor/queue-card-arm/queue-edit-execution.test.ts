import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { OrderStore } from '../../../src/order/index.js';
import { dispatchOrderExecForQueue } from '../../../src/router/order-exec-dispatch.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { sleep, waitFor } from '../../lib/wait-for.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubConnectorWithPendingQueueCard,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
import { mockLogger } from '../../lib/logger-mock.js';
import { createRouterFixture } from '../../lib/router-fixture.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * 编辑后的排队任务簇：queue.input 编辑必须替换原始闭包的执行内容、保持
 * router.handle 的分发语义、在立即执行路径保持原队列位置，且 replacement 必须
 * 在任何可能阻塞的 await 之前注册。
 */

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-edit-exec-'));
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a queue.input-edited task must run the edited content when its turn is reached naturally (anchor)', () => {
  it('test_anchor_edited_queued_task_runs_edited_content_when_reached_naturally', async () => {
    // 验证什么行为：用户编辑排队中的消息（queue.edit → queue.input，toast
    // "消息已更新"、排队卡预览同步为 edited content）后**不点**「⚡ 立即执行」，
    // 让队列自然推进（当前执行任务正常结束 → 目标任务的 slot 轮到）时，实际
    // 交给 Claude 执行的必须是 edited content，而不是 enqueue 时冻结在闭包里的
    // 原始内容。
    //
    // 缺失会导致什么问题：production 的 enqueue 闭包（src/index.ts）捕获
    // msg.content 一次后不可变；handleQueueInput 只更新 messagePreview/
    // editedMessage（显示层 + immediate 分支的输入），**从不注册 replacement
    // 闭包**。queue-manager begin 路径只在 taskReplacements 命中时才换闭包，
    // 未命中时执行原始 task()——于是"编辑后自然轮到"时实际跑的是编辑前的旧
    // 消息：用户看到的排队卡和"已开始执行"卡都显示/承诺新内容（编辑后预览），
    // 但真正发给 Claude 的是旧内容。若编辑是对危险指令的修正（如删掉误加参数、
    // 纠正路径），修正被静默丢弃，Claude 执行了用户已明确撤回的旧指令，且无
    // 任何错误提示——比"编辑无效"更糟，是内容层面的错误执行。
    //
    // 依据：queue.edit 功能语义——编辑排队消息就是修改"这条消息将被执行的内容"；
    // handleQueueImmediate 步骤 1.5 注释明文声明同一根因的契约："If the user
    // edited the message, the original closure (captured at enqueue time with
    // stale content) must NOT run"——该契约只覆盖立即执行分支，自然轮到分支
    // 同样违反（replacement 机制已存在，编辑入口未使用）。tests/queue-immediate-
    // edited.test.ts 记录的同一缺陷（闭包冻结原始内容）修复时只覆盖 immediate，
    // 自然轮到时缺陷原样存在。
    const connector = createStubConnector();
    const runner = createStubRunner();
    const { bridge, router } = createRouterFixture({
      tmpDir,
      config,
      connector,
      runner,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-2' };

    // Spy forwardToClaude（mock 掉真实 spawn，捕获调用参数）。
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);

    // --- 步骤 1：T1 挂起，阻塞队列 ---
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
    await new Promise((r) => setTimeout(r, 50));

    // --- 步骤 2：T2（编辑目标）排队，闭包冻结原始内容 "original message" ---
    bridge.enqueue(
      tmpDir,
      async () => {
        await bridge.forwardToClaude('original message', ctx);
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'original message',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')?.messagePreview).toBe('original message');

    // --- 步骤 3：编辑 T2 → "edited message"（排队卡路径，不点立即执行）---
    await router.handleCardAction({ cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' }, ctx);
    await router.handleCardAction(
      { cmd: 'queue.input', cwd: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // 前置条件：编辑必须已落到 QueuedTask（否则断言失败是测试设置问题，
    // 不是行为缺失）。
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')?.editedMessage).toBe('edited message');
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')?.messagePreview).toBe('edited message');

    // --- 步骤 4：T1 正常结束（非 interrupt），队列自然推进到 T2 ---
    release1();
    await new Promise((r) => setTimeout(r, 300));

    // 修复前：handleQueueInput 未注册 replacement，begin 路径执行原始闭包
    // → forwardToClaude('original message')。本用例钉住：期望 edited content。
    expect(fwdSpy.mock.calls.map((c) => c[0] as string)).toEqual(['edited message']);
  });
});

describe('an edited order.exec queued task must keep the router.handle dispatch semantics of the edited content (anchor)', () => {
  it('test_anchor_edited_order_exec_command_still_routes_through_router_handle', async () => {
    // 验证什么行为：order.exec 的生产 enqueue 闭包（order-exec-dispatch.ts）把 order
    // 文本经 `router.handle(orderText, ctx)` 入队，所以 order 文本可以是 `/status`
    // 这类命令。排队卡（messageId 是 internal key，feishuReplyTo 是真实飞书卡消息）
    // 上的「✏️ 编辑」把任务内容改为 `/active` 后（queue.edit → queue.input），
    // 该任务自然轮到时必须仍然经 router.handle 分发——编辑后的 `/active` 应执行
    // 命令，而不是把 "/active" 原文丢给 Claude。
    //
    // 缺失会导致什么问题：当前 handleQueueInput（以及 handleQueueImmediate）注册的
    // replacement 直接调 `bridge.forwardToClaude(newMessage, ctx)`，绕过了
    // router.handle 的 `/` 与 `!` 分发。用户编辑一个排队中的 order（或普通排队
    // 消息）为命令后，实际执行的是把命令文本当作普通 Claude 消息发送：`/cd /other`
    // 不会切换目录、`!ls` 不会执行 shell、`/stop` 不会停止任务——编辑结果与
    // "重新发送该文本"的语义不一致。若用户是用编辑来修正一条危险命令
    // （如把 `/cd /wrong` 改成 `/cd /right`），修正不会生效且无任何提示。
    //
    // 依据：order.exec 的契约是 "equivalent queued message"——order 文本与手敲消息
    // 一样经 router.handle 路由（order-exec-dispatch.ts 注释 + dispatch 实现）；
    // queue.edit 的契约是"修改这条消息将被执行的内容"（已确立编辑
    // 内容必须替换旧闭包）。replacement 只是换掉闭包捕获的文本，不应同时换掉
    // 分发语义；直接 forwardToClaude 只覆盖"普通消息"这一种文本形态。
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const ordersPath = path.join(tmpDir, 'orders.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('/status');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'order-card-msg' };

    // Spy forwardToClaude（防止真实 spawn）并记录 router.handle 的调用。
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);
    const handleSpy = vi.spyOn(router, 'handle');

    // --- 步骤 1：T1 挂起，阻塞队列 ---
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
          messageId: 'blocker-1',
          messagePreview: 'task 1 running',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    // --- 步骤 2：order.exec 入队一个命令型 order（production 路径，internal key）---
    const dispatchStatus = await dispatchOrderExecForQueue({
      router,
      bridge,
      cwd: tmpDir,
      orderId: order.id,
      ctx: cardCtx,
    });
    expect(dispatchStatus).toBe('enqueued');
    const queued = bridge.getQueuedTasks(tmpDir).find((t) => t.messagePreview === '/status');
    expect(queued).toBeDefined();
    const internalKey = queued!.messageId;
    expect(internalKey).toMatch(/^order-/);
    expect(queued!.feishuReplyTo).toBe(cardCtx.messageId);

    // --- 步骤 3：用排队卡回调（internal key）编辑 T2 → "/active"（一条命令）---
    await router.handleCardAction(
      { cmd: 'queue.edit', cwd: tmpDir, messageId: internalKey },
      cardCtx,
    );
    await router.handleCardAction(
      { cmd: 'queue.input', cwd: tmpDir, messageId: internalKey, inputValue: '/active' },
      cardCtx,
    );
    expect(bridge.getQueuedTask(tmpDir, internalKey)?.editedMessage).toBe('/active');

    // --- 步骤 4：T1 正常结束，队列自然推进到 T2 ---
    release1();
    await new Promise((r) => setTimeout(r, 300));

    const handleCalls = handleSpy.mock.calls.map((c) => c[0] as string);
    const fwdCalls = fwdSpy.mock.calls.map((c) => c[0] as string);

    // 修复前：replacement 调 forwardToClaude('/active')，router.handle 从未收到
    // 编辑后的命令（handleCalls 为空或只有原始文本）。本用例钉住：期望
    // router.handle 收到 '/active'，且该文本不得被当作普通消息 forward。
    expect(handleCalls).toContain('/active');
    expect(fwdCalls).not.toContain('/active');
  });
});

describe('edited queue.immediate must register its replacement before any awaiting card update', () => {
  it('test_anchor_edited_immediate_replacement_not_lost_to_pending_card_send', async () => {
    // 验证什么行为：用户编辑排队消息 T2（editedMessage='edited message'）后点
    // 「⚡ 立即执行」。T2 的排队卡 send 仍在途（生产竞态：Feishu API 延迟 /
    // 99991400 限流重试，映射 promise 未 resolve）时，被立即执行停掉的当前任务
    // settle，队列链前进到 T2 begin。期望：T2 无论如何必须执行编辑后的内容
    // （'edited message'）——replacement 必须在 handleQueueImmediate 任何可能
    // 阻塞的 await（markQueueCardExecuting 等卡片 promise）之前注册，使 begin
    // 路径总能消费到它。当前实现把 setTaskReplacement 放在 markQueueCardExecuting
    // 之后：mark 卡在挂起的卡片 send 上，T2 已先 begin 且消费不到 replacement，
    // 执行了 enqueue 时冻结的旧闭包（'original message'）。
    //
    // 缺失会导致什么问题：用户看到卡片显示编辑后的内容并点了"您的消息将立即执行"
    // 的承诺，实际运行的却是编辑前的旧消息——与 round 6 修复前 queue-immediate-edited
    // 的 bug 同症状，只是触发条件变成"目标卡片的 send 晚于被停任务 settle"。
    // 若编辑内容是对危险命令的修正（删参数/改路径），修正不会生效，副作用按旧
    // 内容执行；且 setTaskReplacement 在 begin 之后注册，replacement 永远不会被
    // 消费（一次性、无归属清理），taskReplacements 泄漏一条死闭包。
    //
    // 依据：round 6 确立的编辑+立即执行契约（/ queue-immediate-edited
    // 测试：编辑后的任务必须执行编辑后内容）；router handleQueueImmediate 注释
    // 步骤 5 "If the user edited the message, the original closure ... must NOT
    // run"。该契约不能依赖卡片 send 的完成时序——已证明 send 可晚于任务接跑，
    // 契约必须对任何 send 时序成立。
    const connector = createStubConnectorWithPendingQueueCard();
    const sessionStore = new SessionStore();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
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

    // Spy forwardToClaude（mock 掉真实 spawn，捕获调用参数与顺序）。
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);

    // --- 步骤 1：T1 挂起，阻塞队列链（raw hang，不进 activeRuns）---
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

    // --- 步骤 2：T2（编辑目标）排队，闭包冻结原始内容；排队卡 send 挂起 ---
    bridge.enqueue(
      tmpDir,
      async () => {
        await bridge.forwardToClaude('original message', ctx);
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'original message',
        },
      },
    );
    // 等 T2 的排队卡 send 已注册（映射为挂起 promise）
    expect(await waitFor(() => connector._sent.length === 1)).toBe(true);

    // --- 步骤 3：编辑 T2 → 'edited message' ---
    await router.handleCardAction({ cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' }, ctx);
    await router.handleCardAction(
      { cmd: 'queue.input', cwd: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // --- 步骤 4：fire-and-forget 触发 queue.immediate（不 await）---
    // handleQueueImmediate 会停在 markQueueCardExecuting → await 挂起的卡片 send。
    const immediatePromise = router.handleCardAction(
      { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    await sleep(50);

    // --- 步骤 5：此时放行 T1 —— 队列链前进到 T2 begin ---
    // 修复前：replacement 尚未注册（markQueueCardExecuting 还在等卡片 send），
    // begin 消费不到 replacement → 执行旧闭包 'original message'。
    release1();
    expect(await waitFor(() => fwdSpy.mock.calls.length >= 1)).toBe(true);

    // --- 步骤 6：卡片 send 此刻才完成，mark 路径继续 → setTaskReplacement 太迟注册 ---
    connector.resolveQueueCardSend();
    await immediatePromise;
    await sleep(20);

    const calls = fwdSpy.mock.calls.map((c) => c[0] as string);
    // 修复前：calls = ['original message']（旧闭包先跑，编辑内容从未执行）。
    // 本用例钉住：期望编辑后的内容执行，且旧内容不得执行。
    expect(calls).toEqual(['edited message']);
  });
});

describe('queue.immediate on an edited task must keep the target position ahead of later-queued tasks', () => {
  it('test_anchor_edited_immediate_target_runs_before_tasks_queued_behind_it', async () => {
    // 验证什么行为：T2 排队中（其后还有 T3），用户把 T2 编辑为 "edited message"
    // 后点「⚡ 立即执行」。立即执行的语义（router handleQueueImmediate 步骤 4 注释
    // "keep it in queue to execute immediately" + 用户可见 toast "您的消息将立即执行"）
    // 是：停掉当前任务、清掉 T2 之前的排队任务、T2 成为下一个执行的任务——
    // 即执行顺序必须是 T2'（编辑后内容）在前、T3 在后。编辑分支用
    // removeFromQueue(旧闭包靠 stillQueued 守卫跳过) + 重新 enqueue（新 messageId）
    // 替换旧闭包，新任务必须继承 T2 的原队列位置（当前任务之后、T3 之前），
    // 而不是追加到队列链尾部。
    //
    // 缺失会导致什么问题：enqueue 只能追加到 promise 链尾部，编辑分支重新入队后
    // 队列链变为 T1 → T2-old(跳过) → T3 → T2'——T3（排在 T2 之后的普通消息）
    // 反而先于"立即执行"的编辑消息运行。用户看到 toast 承诺"您的消息将立即执行"，
    // 的卡片已被 markQueueCardExecuting 翻成"▶️ 已开始执行"（按钮禁用），
    // 但实际先跑的是 T3；若编辑内容是对危险命令的修正（如去掉误加的参数），
    // 该修正被延迟到 T3 之后执行，副作用的顺序与用户预期相反，且卡片状态
    // 与真实执行顺序完全不符（用户无法撤销——按钮已禁用）。
    //
    // 依据：router handleQueueImmediate 步骤 4 注释明文规定目标任务"keep it in
    // queue to execute immediately"、步骤 3 只清除目标任务**之前**的消息（后面的
    // 保持原相对顺序，即 T3 本来排在 T2 之后）；非编辑分支目标任务原地保留，
    // 在 T3 之前执行。编辑分支只是替换闭包，不能改变这一相对顺序——立即执行
    // 的目标必须仍是下一个执行的任务。
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

    // Spy forwardToClaude（mock 掉真实 spawn，捕获调用参数与顺序）。
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);

    // --- 步骤 1：T1 挂起，阻塞队列 ---
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
    await new Promise((r) => setTimeout(r, 50));

    // --- 步骤 2：T2（编辑目标）排队，闭包冻结原始内容 "original message" ---
    bridge.enqueue(
      tmpDir,
      async () => {
        await bridge.forwardToClaude('original message', ctx);
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'original message',
        },
      },
    );

    // --- 步骤 3：T3 排在 T2 之后（验证相对顺序的关键）---
    bridge.enqueue(
      tmpDir,
      async () => {
        await bridge.forwardToClaude('task 3 queued behind', ctx);
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 queued behind',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 100));

    // --- 步骤 4：编辑 T2 → "edited message" ---
    await router.handleCardAction({ cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' }, ctx);
    await router.handleCardAction(
      { cmd: 'queue.input', cwd: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // --- 步骤 5：对 T2 点「⚡ 立即执行」---
    await router.handleCardAction({ cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' }, ctx);

    // --- 步骤 6：放行 T1，队列链前进 ---
    release1();
    await new Promise((r) => setTimeout(r, 300));

    const calls = fwdSpy.mock.calls.map((c) => c[0] as string);

    // 修复前：编辑分支重新 enqueue 追加到链尾，T3 先执行、T2' 最后执行
    // （calls = ['task 3 queued behind', 'edited message']）。
    // 本用例钉住：期望编辑后的立即执行任务在 T3 之前执行。
    expect(calls).toEqual(['edited message', 'task 3 queued behind']);
  });
});
