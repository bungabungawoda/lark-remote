import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
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

/** Same stub connector pattern as tests/anchor/queue-card-arm/queue-card-arm-immediate-cancel-toast.test.ts. */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a condition with real waits; returns false on timeout. */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-entry-missing-'));
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
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.immediate entry-time missing target must not claim the queue was cleared', () => {
  it('test_anchor_immediate_entry_missing_target_feedback_does_not_claim_queue_cleared', async () => {
    // 验证什么行为：队列 [T1执行中, T2(目标任务)排队, T3(排在T2之后)排队] 上，
    // T1 正常结束后 T2 的槽位 begin（从 queuedTasks 移除、开始执行），**之后**
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
    // 已被清掉，危险指令仍会执行且无任何提示；③与 A12 锚点确立的同一契约
    // （queue.immediate 的最终反馈必须与队列事实一致，不得承诺未发生的状态
    // 变化）相冲突——A12 修的是步骤 6 的 mid-flight 撤销面，入口 `!targetTask`
    // 分支仍是同根因的残余面：它既没有像步骤 6 那样重新校验成员资格，也没有
    // 按真实状态修正文案，反而保留了早于 A12 修复的旧谎言。函数注释 "we can
    // still clear queue" 也是死意图——代码路径上没有任何清除动作，清除也违反
    // A13 锚点（目标任务已 begin 时，排在目标**之后**的任务必须保留）。
    //
    // 依据：router handleQueueImmediate 步骤 1 注释（"The queue chain can
    // advance while later awaits are in flight, so the target must be read
    // synchronously at entry"）承认入口读一次之后目标可能已 begin；A12 锚点
    // (queue-card-arm-immediate-cancel-toast) 确立"最终反馈必须与队列
    // 事实一致"；A13 锚点 (queue-card-arm-immediate-target-began) 确立
    // "目标已 begin 时，排在目标之后的任务必须原样保留"——本分支同样处于
    // "目标已不在队列"状态，清除队列不是合法修复，反馈只能如实报告。
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
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
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
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'm2' },
      ctx,
    );
    await sleep(20);

    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');

    // 前置（非行为断言）：handler 确实发送了"无法立即执行"的反馈，不是静默吞掉。
    expect(sentTexts.some((t) => t.includes('无法立即执行'))).toBe(true);
    // 前置：T3 必须保持排队（A13：目标已 begin 时不清除排在目标之后的任务）。
    expect(bridge.getQueuedTask(tmpDir, 'm3')).toBeDefined();

    // 当前实现：发送 "该消息已开始执行，无法立即执行。队列已清空。"——队列
    // 实际未被清空（T3 仍在），这里必须真红：反馈不得声称"队列已清空"。
    expect(sentTexts.some((t) => t.includes('队列已清空'))).toBe(false);
    // 同时也不得承诺执行（A12 同族约束）。
    expect(sentTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(false);

    // --- 清理：放行 T2、T3，让队列链自然收尾 ---
    release2();
    release3();
    await sleep(50);
  });
});
