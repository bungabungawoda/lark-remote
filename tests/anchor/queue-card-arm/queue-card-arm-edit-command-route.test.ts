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
import type { _Runner } from '../../../src/runner/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
  createStubConnector,
} from '../../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-edit-cmd-route-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
    // queue.edit 的契约是"修改这条消息将被执行的内容"（A7/A10 anchor 已确立编辑
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
      workspace: tmpDir,
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
      { cmd: 'queue.edit', workspace: tmpDir, messageId: internalKey },
      cardCtx,
    );
    await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: internalKey, inputValue: '/active' },
      cardCtx,
    );
    expect(bridge.getQueuedTask(tmpDir, internalKey)?.editedMessage).toBe('/active');

    // --- 步骤 4：T1 正常结束，队列自然推进到 T2 ---
    release1();
    await new Promise((r) => setTimeout(r, 300));

    const handleCalls = handleSpy.mock.calls.map((c) => c[0] as string);
    const fwdCalls = fwdSpy.mock.calls.map((c) => c[0] as string);

    // 当前实现：replacement 调 forwardToClaude('/active')，router.handle 从未收到
    // 编辑后的命令（handleCalls 为空或只有原始文本）。这里必须真红：期望
    // router.handle 收到 '/active'，且该文本不得被当作普通消息 forward。
    expect(handleCalls).toContain('/active');
    expect(fwdCalls).not.toContain('/active');
  });
});
