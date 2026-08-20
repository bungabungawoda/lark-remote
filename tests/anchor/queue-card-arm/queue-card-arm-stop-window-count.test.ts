import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createStubConnector,
  createGatedRunner,
  type GatedRunner,
} from '../../lib/bridge-stubs.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentRunner } from '../../../src/runner/index.js';
import { AgentRegistry } from '../../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { sleep, waitFor } from '../../lib/wait-for.js';

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

/**
 * Stub connector returning a UNIQUE card message id per sendWithRetry call,
 * so the test can count queue cards (sendWithRetry entries whose payload
 * carries the queue-card header/preview) sent for each message.
 */

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-stop-window-count-'));
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

describe('queue executing count must not be reset onto the next task that began during the stop window (anchor A22)', () => {
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
    // （原 A1 事故的另一个交错：A1 只覆盖了"reset 发生在 T2 接跑之前"，
    // 这里 reset 发生在 T 接跑之后）。
    //
    // 期望：此时 T 仍在运行，新入队消息 M 必须收到 1 张排队卡（sentCards 增加）。
    // 缺失会导致什么问题：M 静默排队无任何用户反馈——用户看不到排队卡、无法
    // 撤销/立即执行/编辑，消息在后台空转（同款静默排队生产事故）。
    //
    // 依据：enqueue 的 hasWaitingTasks 语义（count>0 || queueLen>0 就必须发卡）
    // 是"只要队列里还有任务在排队或执行"；Bridge.interruptCurrentRun 的
    // resetExecutingCount 注释声称只清理"被外部中断的任务"的残留计数，不应
    // 波及停止窗口内已经接跑的新任务。A1/A4 锚点确立了计数必须反映真实执行
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
        { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'mT' },
        ctx,
      );
      expect(await waitFor(() => runner1.stopCalls === 1)).toBe(true);

      // --- 步骤 4：停止窗口内 T1 的 run settle → 队列链前进 → T 接跑并真正执行 ---
      // T1 的 finalizeRun 清掉 runner 缓存，T 的 forwardToClaude 会经 registry
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
      // 当前实现：interruptCurrentRun 在 stop 后无条件 resetExecutingCount，
      // 把接跑任务 T 的计数清零并标记 T 的 slot 为 interrupted → M 入队时
      // count=0/queueLen=0 → hasWaitingTasks=false → 不发排队卡。必须真红。
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
