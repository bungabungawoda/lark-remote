import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner, AgentRunner } from '../../../src/runner/index.js';
import { AgentRegistry } from '../../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

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

/**
 * A runner whose run() hangs until the test releases it (faithful to a real
 * subprocess that only exits when killed), and whose stop() hangs on a
 * separate gate. Decoupling run-exit from stop-completion reproduces the
 * production stop window: interruptCurrentRun awaits
 * Promise.allSettled([session.finish, runner.stop]), and during that window
 * the killed run's promise-chain settle can advance the serial queue all the
 * way past the immediate target (same gated pattern as
 * tests/anchor/queue-card-arm/queue-card-arm-immediate-ahead-began.test.ts).
 */
interface GatedRunner extends Runner {
  stopCalls: number;
  releaseRun: () => void;
  releaseStop: () => void;
}

function createGatedRunner(): GatedRunner & AgentRunner {
  let releaseRun!: () => void;
  let releaseStop!: () => void;
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const runner: GatedRunner & AgentRunner = {
    isRunning: false,
    stopCalls: 0,
    stop: async () => {
      runner.stopCalls++;
      await stopGate;
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      await runGate;
    },
    kind: 'claude',
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: 'claude', model: 'test' }),
    releaseRun: () => releaseRun(),
    releaseStop: () => releaseStop(),
  };
  return runner;
}

/**
 * Stub connector returning a UNIQUE card message id per sendWithRetry call
 * (same pattern as the other queue-card-arm anchors).
 */
function createStubConnector() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown; id: string }> = [];
  const cards: object[] = [];
  const updates: Array<{ messageId: string; card: object }> = [];
  let seq = 0;
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      const id = `card-msg-${++seq}`;
      sent.push({ chatId, input, opts, id });
      return id;
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined, id: `card-msg-${++seq}` });
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
    ) => {
      sent.push({ chatId, input: { card: initial }, opts: undefined, id: `card-msg-${++seq}` });
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
    updateCard: async (messageId: string, card: object) => {
      updates.push({ messageId, card });
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
    _updates: updates,
  };
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-began-settled-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      binary: 'claude',
      model: 'opus',
      stopGraceMs: 5000,
    },
    defaultAgent: 'claude',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.immediate final feedback must not claim "未安排执行" when the target began AND completed during the stop window (anchor)', () => {
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
    // 缺失会导致什么问题：A16（目标 begin 后仍在运行）与 A17（目标被撤销）各自
    // 覆盖了 hasTaskBegan 分支的一面，但第三态——目标 begin 后已 settle——
    // 让 beganMessageIds 提前清空，步骤 6 的二元判定把"已执行完毕"误判成"已撤销"。
    // 用户同时看到 T 的卡片已翻成「▶️ 已开始执行」、正文却宣称"未安排执行"，
    // 卡片与正文直接矛盾；用户以为自己的指令被丢弃（实际已执行），会重复发送，
    // 污染会话/队列。该竞态真实可达：A16/A19 已确立"stop 窗口内队列链可前进到目标
    // 的 begin"；目标若是快速任务（短指令、/status 类命令），在 stop 窗口内完成
    // 完全正常。CLAUDE.md 卡片反馈红线（反馈不得与事实矛盾）与 A16 锚点的
    // "已开始却宣称未安排 = 谎言"同族，本测试补上 A16 未覆盖的"完成态"半边。
    //
    // 依据：router handleQueueImmediate 步骤 6 注释明文规定最终 toast 必须区分
    // "目标开始执行"（acknowledge）与"目标被撤销"（未安排执行）两种缺失原因；
    // A16 文案："目标任务在 interrupt 窗口内 begin 后…正文却宣称未安排执行——
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
        { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'mT' },
        ctx,
      );
      expect(await waitFor(() => runner1.stopCalls === 1)).toBe(true);

      // --- 步骤 4：停止窗口内 T1 的 run settle → 队列链前进 → T begin 并完成 ---
      runner1.releaseRun();
      // T 已执行完毕。began 标记是粘性的（A21 修复）：任务一旦开始执行，标记
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
      // 当前实现：目标 begin 后已 settle → hasTaskBegan=false → 落入撤销分支，
      // 发送 "⚠️ 目标消息已不在队列中（可能已被撤销），未安排执行。…"。必须真红：
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
