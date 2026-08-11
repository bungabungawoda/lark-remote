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
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async (
      _chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
    ) => {
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async () => {},
    connected: true,
    _sent: sent,
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-no-run-toast-'));
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

describe('queue.immediate final toast must not claim a stop when no run was running (anchor A24)', () => {
  it('test_anchor_immediate_toast_without_stop_does_not_claim_stopped_current_task', async () => {
    // 验证什么行为：workspace 没有活跃 run（interruptCurrentRun 返回 false）时，
    // 「⚡ 立即执行」成功路径的 toast 不得包含"已停止当前任务"——没有停掉任何
    // 任务就不能宣称停过；"您的消息将立即执行"的承诺仍须保留。
    //
    // 缺失会导致什么问题：interruptCurrentRun 的返回值 `stopped` 被丢弃，toast
    // 恒为"⚡ 已停止当前任务，清除了 N 条…"，在无 run 可停时（链上只有排队任务、
    // 头部任务不是 run）对用户撒谎（review P3 finding）。
    //
    // 依据：router handleQueueImmediate 步骤 2 捕获 `stopped`（interruptCurrentRun
    // 是否真的停到了 run），最终 toast 是对事实的承诺——没有停止就不写停止；
    // A16/A17/A20 已确立"toast 不得与队列事实矛盾"的反馈契约。
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

    // --- 步骤 3：对 T 点「⚡ 立即执行」——workspace 无活跃 run，stopped=false ---
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'mT' },
      ctx,
    );

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
