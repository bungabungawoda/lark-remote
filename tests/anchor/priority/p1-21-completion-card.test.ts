/**
 * P1-21 anchors: completion notification card must cap events and go through
 * the card-budget path.
 *
 * sendCompletionNotificationCard calls readSessionContent WITHOUT maxEvents,
 * so claude returns EVERY event after the last user message; events.forEach
 * dumps all of them into the card, which is then sent via connector directly
 * (bypassing sendResult's enforceCardBudget). Long sessions exceed Feishu's
 * 28KB card limit and are silently rejected (warn log only) — the user never
 * sees the completion notification.
 *
 * review.md §P1-21: "readSessionContent(sessionId, cwd, { maxEvents:
 * AUTO_RESUME_MAX_EVENTS 同款 })，发送改走 this.sendResult({ card }, ctx)".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore, SessionReaderRegistry } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { createStubAgentRegistry } from '../../lib/bridge-stubs.js';
import type {
  AgentEvent,
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
  Runner,
  SessionContent,
  AgentSessionUsage,
} from '../../../src/runner/index.js';

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

const CARD_BUDGET_BYTES = 28 * 1024;

function createStreamRejectingConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => {
      throw new Error('stream unavailable');
    },
    updateCard: async () => {},
    connected: true,
    _sent: sent,
  };
}

function createDoneRunner(): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* (_message: string, opts: { cwd: string }) {
      const events: AgentEvent[] = [
        { type: 'system', subtype: 'init', session_id: 'sess-1', cwd: opts.cwd, model: 'opus' },
        { type: 'result', subtype: 'success', session_id: 'sess-1' },
      ];
      for (const e of events) yield e;
    },
  };
}

function makeFakeReader(eventsFactory: () => AgentSessionContentEvent[]): {
  reader: AgentSessionReader;
  readContent: ReturnType<typeof vi.fn>;
} {
  const readContent = vi.fn(
    (_sessionId: string, _cwd: string, opts?: { maxEvents?: number }): SessionContent => {
      const all = eventsFactory();
      const events = opts?.maxEvents !== undefined ? all.slice(-opts.maxEvents) : all;
      const usage: AgentSessionUsage | undefined = undefined;
      return { events, usage };
    },
  );
  const reader: AgentSessionReader = {
    listSessions: (): { sessions: AgentSession[]; total: number } => ({
      sessions: [],
      total: 0,
    }),
    getNewestSession: (): AgentSession | null => null,
    readSessionContent: readContent,
    isSessionActive: (): boolean => false,
  };
  return { reader, readContent };
}

describe('P1-21 completion notification card', () => {
  afterEach(() => {
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  async function runBridgeWithReader(events: AgentSessionContentEvent[]) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-21-completion-'));
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      workspace: { default: '' },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
    const sessionStore = new SessionStore();
    sessionStore.setCwd('u1', tmpDir);
    const connector = createStreamRejectingConnector();
    const { reader, readContent } = makeFakeReader(() => events);
    const registry = new SessionReaderRegistry();
    registry.register('claude', reader);
    const bridgeRunner = createDoneRunner();
    const bridge = new Bridge({
      agentRegistry: createStubAgentRegistry(bridgeRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };
    await bridge.forwardToClaude('hi', ctx);
    return { connector, readContent, tmpDir };
  }

  it('test_anchor_completion_notification_reads_max_events', async () => {
    // ① 验证什么行为：完成通知卡读取会话内容必须带 maxEvents 上限，长会话不
    //    再把「最后一个 user 之后」的全部事件塞进卡片。
    // ② 缺失/错误会导致什么：claude reader 返回 last user 后全部事件，events
    //    forEach 全量入卡 → 卡片超 28KB 被飞书拒绝，静默降级为 warn 日志，
    //    用户永远看不到完成通知。
    // ③ 依据：review.md §P1-21「readSessionContent(sessionId, cwd) 不传
    //    maxEvents → claude reader 返回 last user 之后的全部事件」。
    const { readContent, tmpDir } = await runBridgeWithReader([]);
    try {
      const calls = readContent.mock.calls as [string, string, { maxEvents?: number }?][];
      const capped = calls.find((c) => c.length >= 3 && c[2]?.maxEvents !== undefined);
      expect(capped).toBeDefined();
      expect(capped![2]!.maxEvents).toBeGreaterThan(0);
      expect(capped![2]!.maxEvents).toBeLessThanOrEqual(10);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_anchor_completion_notification_card_within_budget', async () => {
    // ① 验证什么行为：长会话（最后一个 user 后事件文本巨大）的完成通知卡必须
    //    落在飞书 28KB 卡片预算内（maxEvents 截断或预算兜底，不可直接原样发送）。
    // ② 缺失/错误会导致什么：events.forEach 全量入卡后绕过 enforceCardBudget
    //    直接 connector.sendWithRetry，卡片超 28KB 被飞书拒绝 → 完成通知静默
    //    丢失。
    // ③ 依据：review.md §P1-21「长会话下卡片超 28KB 被飞书拒绝，静默降级为
    //    warn 日志」。
    const bigEvents: AgentSessionContentEvent[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'text',
      content: `event-${i} ` + 'x'.repeat(4000),
    }));
    const { connector, tmpDir } = await runBridgeWithReader(bigEvents);
    try {
      const cards = connector._sent
        .map((m) => (m.input as { card?: object } | undefined)?.card)
        .filter((c): c is object => !!c);
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(JSON.stringify(card).length).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
