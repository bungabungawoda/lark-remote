import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
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

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-order-test-'));
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
    // T2 的卡片已被 markQueueCardExecuting 翻成"▶️ 已开始执行"（按钮禁用），
    // 但实际先跑的是 T3；若编辑内容是对危险命令的修正（如去掉误加的参数），
    // 该修正被延迟到 T3 之后执行，副作用的顺序与用户预期相反，且卡片状态
    // 与真实执行顺序完全不符（用户无法撤销——按钮已禁用）。
    //
    // 依据：router handleQueueImmediate 步骤 4 注释明文规定目标任务"keep it in
    // queue to execute immediately"、步骤 3 只清除目标任务**之前**的消息（后面的
    // T3 保持原相对顺序，即 T3 本来排在 T2 之后）；非编辑分支目标任务原地保留，
    // 在 T3 之前执行。编辑分支只是替换闭包，不能改变这一相对顺序——立即执行
    // 的目标必须仍是下一个执行的任务。
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
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
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // --- 步骤 5：对 T2 点「⚡ 立即执行」---
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );

    // --- 步骤 6：放行 T1，队列链前进 ---
    release1();
    await new Promise((r) => setTimeout(r, 300));

    const calls = fwdSpy.mock.calls.map((c) => c[0] as string);

    // 当前实现：编辑分支重新 enqueue 追加到链尾，T3 先执行、T2' 最后执行
    // （calls = ['task 3 queued behind', 'edited message']）。
    // 这里必须真红：期望编辑后的立即执行任务在 T3 之前执行。
    expect(calls).toEqual(['edited message', 'task 3 queued behind']);
  });
});
