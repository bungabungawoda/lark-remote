import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentSessionReader } from '../../../src/runner/index.js';

// P2-28 anchor (red): handleQueueDiagnose 的诊断卡片仍是 CardKit V1 结构
// （缺 schema:'2.0'，缺 body:{elements}，顶层用 elements）。
// 这是全项目最后一张 V1 卡。本测试复现该缺陷，待绿 agent 修复 src。

const stubSessionReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({
    events: [],
    aiTitle: undefined,
    recap: undefined,
    displayTitle: undefined,
    usage: undefined,
    reason: 'not_found',
  }),
  isSessionActive: () => false,
};

function createStubSessionReaderRegistry(): SessionReaderRegistry {
  const registry = new SessionReaderRegistry();
  registry.register('claude', stubSessionReader);
  registry.register('codex', stubSessionReader);
  registry.register('opencode', stubSessionReader);
  registry.register('pi', stubSessionReader);
  registry.register('kimi', stubSessionReader);
  return registry;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-anchor-queue-diag-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('anchor: queue diagnose card v2', () => {
  it('test_anchor_queue_diagnose_card_must_be_cardkit_2_0', async () => {
    // 通过 handleCardAction 触发 queue.diagnose。handleQueueDiagnose 只读取
    // bridge.getQueuedTask / getQueueInfo / getAllActiveRuns，然后用
    // bridge.sendResult 发卡片。我们用一个伪造 bridge 满足这几个 seam，
    // 并捕获 sendResult 收到的诊断卡片做断言。
    const sentCards: object[] = [];
    const fakeBridge = {
      setIdleTimeout: () => {},
      sendResult: async (result: { card?: object }) => {
        if (result.card) sentCards.push(result.card);
        return true;
      },
      getQueuedTask: () => ({
        messageId: 'queued-msg-1',
        messagePreview: 'hello preview',
        text: 'hello',
      }),
      getQueueInfo: () => ({ position: 1, tasksAhead: 0, isRunning: true }),
      getAllActiveRuns: () => new Map(),
    } as unknown as Bridge;

    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    const router = new CommandRouter({
      sessionStore,
      bridge: fakeBridge,
      config: makeConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    await router.handleCardAction(
      {
        cmd: 'queue.diagnose',
        workspace: fs.realpathSync(tmpDir),
        messageId: 'queued-msg-1',
        userId: 'user1',
        chatId: 'chat1',
      },
      ctx,
    );

    expect(sentCards.length).toBe(1);
    const card = sentCards[0] as {
      schema?: string;
      body?: { elements?: unknown[] };
      elements?: unknown[];
      config?: { wide_screen_mode?: boolean };
    };
    const cardStr = JSON.stringify(card);

    // 缺陷契约 1：必须含 schema:'2.0'（当前缺 → fail）
    expect(cardStr).toMatch(/"schema"\s*:\s*"2\.0"/);

    // 缺陷契约 2：必须用 body:{elements} 而非顶层 elements（当前用顶层 → fail）
    expect(card.body).toBeDefined();
    expect(Array.isArray(card.body?.elements)).toBe(true);
    expect(card.elements).toBeUndefined();

    // 200861 铁律正则：禁止 V1/V2 混用
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    // NOTE: wide_screen_mode 是合法 CardKit 2.0 config 字段（/active、/ls、/order 卡
    // 均在 schema:'2.0' 下使用），不是 V1 残留。故不断言 card.config 为 undefined。
    // P2-28 真正的缺陷是缺 schema:'2.0' + 缺 body:{elements} + 顶层 elements，已由上面三条断言覆盖。
  });
});
