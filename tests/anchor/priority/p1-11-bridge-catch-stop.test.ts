/**
 * Anchor Test: P1-11 — bridge agent 路径 catch 必须调 runner.stop()
 *
 * ① 验证什么行为：
 *   runner.run() 生成器在流中间抛错（模拟 cardSession.push flush 抛错、
 *   sessionStore 磁盘写失败等循环体异常）时，bridge 的 catch 必须调用
 *   runner.stop()（与 bash 路径 executeBash 的 catch 对齐，双保险）。
 *
 * ② 缺失/错误会导致什么问题：
 *   run() 的 finally 修复（A11.1）已覆盖「生成器关闭即杀子进程」，但 bridge
 *   catch 路径若依赖 runner 内部 finally 就漏掉了一层纵深——任何未来 runner
 *   重构只要漏掉 finally 清理，异常路径就会把子进程留在后台（review §P1-11
 *   修复建议「bridge agent 路径 catch 里补 runner.stop() 与 bash 路径对齐」）。
 *
 * ③ 依据：review.md §P1-11 前因后果（bridge for-await 循环体内异常 →
 *   隐式 .return()）与修复建议双保险条款；对照 bash 路径
 *   src/bridge/index.ts executeBash catch（1470-1478 明确调用 bashRunner.stop()）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentEvent, Runner } from '../../../src/runner/index.js';

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
  const cards: object[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown) => {
      cards.push(input as object);
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
    _cards: cards,
  };
}

describe('P1-11: bridge catch calls runner.stop()', () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-11-bridge-anchor-'));
    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_bridge_calls_runner_stop_on_agent_stream_error', async () => {
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    const stopCalled = vi.fn();
    const runner: Runner = {
      isRunning: false,
      stop: stopCalled,
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
          cwd: '/tmp',
          model: 'm',
        } as AgentEvent;
        throw new Error('stream boom');
      },
    };

    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector: createStubConnector() as never,
      sessionStore,
      config,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    // 当前 bug：agent 路径 catch 不调 stop（bash 路径有）→ 未调用 → RED
    expect(stopCalled).toHaveBeenCalled();
  });
});
