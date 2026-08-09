import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner } from '../../../src/runner/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
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
function createStubConnector() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
  const cards: object[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined });
      return 'file-msg-id';
    },
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async (
      chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
      opts?: unknown,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts });
      cards.push(initial);
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
          cards.push(current);
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async (_messageId: string, card: object) => {
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
  };
}

function createStubRunner(): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      throw new Error('run not expected in stub');
    },
  };
}

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-began-toast-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      binary: 'claude',
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

describe('queue.immediate final feedback must say the target STARTED when it began during the interrupt window', () => {
  it('test_anchor_immediate_target_began_final_toast_not_claim_not_scheduled', async () => {
    // 验证什么行为：用户对排队任务 T2 点「⚡ 立即执行」后，handleQueueImmediate
    // 在 `await interruptCurrentRun` 挂起期间队列链前进（T1 结束、T2 槽位 begin
    // 并从 queuedTasks 移除、T2 开始执行）；stop 恢复后，步骤 6 的最终成员资格
    // 校验发现目标已不在队列，此时最终反馈必须区分两种事实：
    //   - 目标已**撤销**：不会执行 → 反馈"未安排执行"（A17 已覆盖）；
    //   - 目标已**开始执行**：正在运行 → 反馈必须承认"已开始执行"，
    //     绝不能发送"未安排执行"——任务明明在跑，却告诉用户没被安排执行。
    //
    // 缺失会导致什么问题：当前步骤 6 对两种缺失原因共用一条文案
    // "⚠️ 目标消息已不在队列中（可能已被撤销或已开始执行），未安排执行。已清除 N 条
    // 排队消息。"。目标任务在 interrupt 窗口内 begin 后，用户同时看到目标的排队卡
    // 已被翻成 "▶️ 已开始执行"（begin 路径 updateQueueCardToExecuting），正文却宣称
    // "未安排执行"——卡片与正文直接矛盾；若用户在等这条消息的结果，会误以为自己的
    // 指令被丢弃、去重复发送，实际 T2 正在执行，重复发送反而污染会话/队列。这与 A17
    // （撤销竞态下 toast 不得承诺执行）是同一根因的另一半：A17 管住"未撤销却承诺
    // 执行"，本测试管住"已开始却宣称未安排"——最终反馈必须与队列事实一致，不能对
    // 执行中的任务说"未安排执行"。
    //
    // 依据：router handleQueueImmediate 步骤 6 注释明文规定最终 toast 是"对未来
    // 事实的承诺"（success toast 承诺"您的消息将立即执行"），因此必须先按最新成员
    // 资格判定；成员资格缺失只有"撤销"与"开始执行"两种原因，文案必须区分两者。
    // CLAUDE.md 卡片反馈红线（反馈不得与事实矛盾、miss 必须可见）同族要求；
    // A16 锚点已确立"目标在 interrupt 窗口内 begin 是真实可达状态"（T1 结束 →
    // T2 begin 可以在 stop 在途时完成），本测试是该状态的反馈面。
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

    // --- 步骤 3：挂起 interruptCurrentRun（A16 同款：模拟 stop 在途，队列链
    // 可在这期间推进到目标任务的 begin）---
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

    // --- 步骤 5：队列链前进：T1 结束 → T2 begin（从 queuedTasks 移除、执行中挂起）---
    release1();
    expect(await waitFor(() => t2Started)).toBe(true);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeUndefined(); // T2 已开始执行

    // --- 步骤 6：stop 此刻完成，handler 恢复并执行步骤 3/4.5/6 ---
    resolveStop(true);
    await immediateDone;
    await sleep(20);

    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');

    // 当前实现：步骤 6 对"已开始执行"与"已撤销"共用
    // "…（可能已被撤销或已开始执行），未安排执行。…" 文案。这里必须真红：
    // 目标正在执行，最终反馈不得宣称"未安排执行"。
    expect(sentTexts.some((t) => t.includes('未安排执行'))).toBe(false);
    // 正向契约：反馈必须承认目标已开始执行（与卡片 "▶️ 已开始执行" 一致）。
    expect(sentTexts.some((t) => t.includes('已开始执行'))).toBe(true);

    // --- 清理：放行 T2，让队列链自然收尾 ---
    release2();
    await sleep(50);
  });
});
