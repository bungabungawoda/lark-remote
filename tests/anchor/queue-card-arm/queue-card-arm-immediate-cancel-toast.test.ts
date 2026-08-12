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

/** Same stub connector pattern as tests/anchor/queue-card-arm/queue-card-arm-immediate-target-began.test.ts. */

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-cancel-toast-'));
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
    // T2 的队列槽位 begin 时被取消守卫跳过，永远不会执行，toast 是永久谎言。且用户
    // 已无补救入口：撤销卡与执行卡按钮全部禁用，唯一的行为依据（正文）指向相反结论。
    // 若 T2 是编辑过的危险指令修正，撤销后修正不会生效，用户却以为它即将执行——
    // 与 A5 锚点（撤销卡不得被迟到的执行态覆盖）同族：A5 管住了卡片，toast 仍未覆盖，
    // 属于同一个"跨 await 成员资格失效"根因的残余面。
    //
    // 依据：router handleQueueImmediate 步骤 1 注释明文规定 "The queue chain can
    // advance while later awaits are in flight, so the target must be read
    // synchronously at entry"——入口读一次只保证入口时刻的成员资格，之后的每个
    // await（interruptCurrentRun / markQueueCardExecuting）都可能改变它；步骤 4.5
    // 之后的成功 toast 是对未来事实的承诺（"您的消息将立即执行"），必须先确认目标
    // 仍在队列。A5/A9/A12 锚点已确立同一契约：任何跨 await 的后续动作/反馈必须按
    // 最新成员资格判定，不能沿用入口快照。CLAUDE.md 卡片反馈红线（stop miss 必须
    // 可见、反馈不得静默撒谎）的同类要求。
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

    // --- 步骤 3：挂起 interruptCurrentRun（A12 同款：模拟 stop 在途，队列链/其他
    // cardAction 可在这期间推进）---
    let resolveStop: (v: boolean) => void = () => {};
    const stopInFlight = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    const stopSpy = vi.spyOn(bridge, 'interruptCurrentRun').mockReturnValue(stopInFlight);

    // --- 步骤 4：触发「立即执行」（不 await，停在 interrupt 挂起点）---
    const immediateDone = router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    expect(await waitFor(() => stopSpy.mock.calls.length === 1)).toBe(true);

    // --- 步骤 5：interrupt 在途期间，用户对同一目标任务点「❌ 撤销」---
    // 撤销成功：T2 从队列移除、卡片更新为 "❌ 已撤销"、发送确认正文。
    await router.handleCardAction(
      { cmd: 'queue.cancel', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeUndefined();
    expect(bridge.getQueuedTask(tmpDir, 'msg-A')).toBeDefined(); // T2 之前的 A 仍在排队

    // --- 步骤 6：stop 此刻完成，immediate 恢复执行后续步骤 ---
    resolveStop(true);
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

    // 当前实现：handler 不重新校验成员资格，最后 toast 仍发送
    // "⚡ 已停止当前任务，清除了 0 条排队消息。您的消息将立即执行。"
    // 这里必须真红：目标已撤销，正文不得再承诺执行。
    expect(sentTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(false);

    // --- 清理：放行 T1、A、T2（T2 槽位已被取消守卫跳过），让队列链自然收尾 ---
    release1();
    releaseA();
    release2();
    await sleep(50);
  });
});
