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
 * Promise.allSettled([session.finish, runner.stop]), and the Feishu card
 * round trips in that window keep the handler parked while the killed run's
 * promise-chain settle already advanced the serial queue to the NEXT task.
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
 * Stub connector returning a UNIQUE card message id per sendWithRetry call,
 * so the test can tell which queue card (A's vs the target T's) got which
 * executing/cancelled update. Run cards go through streamCard (separate path).
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-ahead-began-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
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
    // 停不到，只能等它自然结束。该竞态与 A8（queue-card-arm-immediate-clear-yield）
    // 同属"队列链在 handler await 期间前进"的已承认竞态，但 A8 只覆盖了步骤 3
    // 卡片更新窗口（A/B 仍在队列、可被同步移除），未覆盖 interruptCurrentRun 的
    // 停止窗口——此窗口内 A 已接跑，快照式清除结构性漏掉它。
    //
    // 依据：router handleQueueImmediate 步骤 3/4 注释——"Remove all tasks BEFORE
    // this one"、"The queue will naturally execute it after the current task
    // (which we just stopped)"：语义承诺停止后 T 是下一个执行者；步骤 6 的
    // 注释明文规定最终 toast 必须反映真实状态（A13/A14 已确立"不得承诺不会发生
    // 的执行"）。A8 锚点确立了清除必须在任何 await 前完成的不变量；本测试补上
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
        { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'mT' },
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
        // 当前实现：markQueueCardExecuting(started=false) 时 T 仍在队列 →
        // liveTask 存在 → T 的卡片被翻成已开始执行。必须真红。
        expect(executingUpdatesForT).toHaveLength(0);

        const toastTexts = connector._sent
          .map((s) => (s.input as { text?: string }).text)
          .filter((t): t is string => !!t);
        // 当前实现：步骤 6 的 finalTask 分支发
        // "⚡ 已停止当前任务，清除了 0 条排队消息。您的消息将立即执行。"。必须真红。
        expect(toastTexts.some((t) => t.includes('您的消息将立即执行'))).toBe(false);
      } else {
        // 修复后若 T 已真正接跑（escaping 任务被再停掉），卡片/toast 即如实，
        // 断言在 if 分支外为空操作——测试只约束"T 仍排队时必须不说谎"。
        expect(true).toBe(true);
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
