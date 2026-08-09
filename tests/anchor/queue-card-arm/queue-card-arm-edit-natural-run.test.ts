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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-edit-natural-test-'));
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
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // 前置条件：编辑必须已落到 QueuedTask（否则断言失败是测试设置问题，
    // 不是行为缺失）。
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')?.editedMessage).toBe('edited message');
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')?.messagePreview).toBe('edited message');

    // --- 步骤 4：T1 正常结束（非 interrupt），队列自然推进到 T2 ---
    release1();
    await new Promise((r) => setTimeout(r, 300));

    // 当前实现：handleQueueInput 未注册 replacement，begin 路径执行原始闭包
    // → forwardToClaude('original message')。这里必须真红：期望 edited content。
    expect(fwdSpy.mock.calls.map((c) => c[0] as string)).toEqual(['edited message']);
  });
});
