import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from './index.js';
import { SessionStore, SessionReaderRegistry } from '../session/index.js';
import { OrderStore } from '../order/index.js';
import { Bridge } from '../bridge/index.js';
import { AppConfigSchema } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { Runner, AgentSessionReader } from '../runner/index.js';

import { createStubAgentRegistry } from '../test-helpers.js';
// Stub session reader for tests
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

function createStubRunner() {
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter(overrides?: {
  runner?: Runner;
  sessionStore?: SessionStore;
  ordersPath?: string;
}) {
  const sessionStore = overrides?.sessionStore ?? new SessionStore();
  const connector = createStubConnector();
  const runner: Runner = overrides?.runner ?? createStubRunner();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      stopGraceMs: 5000,
    },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });

  // Use ordersPath if provided, otherwise use default
  const ordersPath = overrides?.ordersPath ?? path.join(tmpDir, 'orders.json');

  // Create bridge mock
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
    ordersPath,
    exitHandler: () => {},
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });

  return { router, sessionStore, connector, bridge, ordersPath };
}

// order.exec no longer has a router-level cardAction handler: index.ts
// intercepts it at the enqueue boundary (resolveOrderExecForQueue) and routes
// it through router.handle(orderText) — the same path as a hand-typed message.
// The contracts previously tested here (sessionId reuse, cwd-agnostic
// forwarding, no-session creation) are now covered by the hand-typed-message
// path (router.handle → forwardToClaude), which has its own coverage. Only the
// crash-safe usedAt contract is order-specific and is retained below.

describe('order.exec usedAt crash-safety (resolve-time)', () => {
  it('records and persists usedAt at resolve time, before the task runs', () => {
    const ordersPath = path.join(tmpDir, 'orders-h3.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('usedat target');

    const { router } = createRouter({ ordersPath });

    // Resolve at enqueue time (mirrors what index.ts does on the cardAction
    // path). usedAt must be recorded here, before any forwardToClaude.
    const resolved = router.resolveOrderExecForQueue(order.id);
    expect(resolved).not.toBeNull();
    expect(resolved?.orderText).toBe('usedat target');

    // Re-load from disk — simulates a process restart so we also catch
    // load() stripping usedAt.
    const reloaded = new OrderStore(ordersPath);
    const entries = reloaded.get();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(order.id);
    expect(entries[0].usedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Plan A: order.exec is resolved to its text at the enqueue boundary and
// enters the serial queue as an equivalent user message — same path as a
// hand-typed message. resolveOrderExecForQueue is the router-side helper that
// index.ts calls before bridge.enqueue; it returns the order text (for
// messagePreview / edit default_value / forwardToClaude) plus an internal
// unique key (since one order card can be clicked many times, the Feishu card
// messageId is 1:N with enqueue actions and must not be reused as the queue
// dedup key).
// ---------------------------------------------------------------------------
describe('resolveOrderExecForQueue: order.exec → equivalent queued message', () => {
  it('returns the order text and a unique internal key', () => {
    const ordersPath = path.join(tmpDir, 'orders-resolve1.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('build the project');

    const { router } = createRouter({ ordersPath });

    const resolved = router.resolveOrderExecForQueue(order.id);
    expect(resolved).not.toBeNull();
    expect(resolved?.orderText).toBe('build the project');
    // internalKey is unique per call (timestamp-suffixed), not the Feishu card id
    expect(resolved?.internalKey).toMatch(/^order-/);
    expect(resolved?.internalKey).toContain(order.id);
  });

  it('returns a different internalKey on each call (no card-messageId collision)', () => {
    const ordersPath = path.join(tmpDir, 'orders-resolve2.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('repeated order');

    const { router } = createRouter({ ordersPath });

    const a = router.resolveOrderExecForQueue(order.id);
    const b = router.resolveOrderExecForQueue(order.id);
    expect(a?.internalKey).not.toBe(b?.internalKey);
    expect(a?.orderText).toBe('repeated order');
    expect(b?.orderText).toBe('repeated order');
  });

  it('returns null when the order no longer exists', () => {
    const ordersPath = path.join(tmpDir, 'orders-resolve3.json');
    const { router } = createRouter({ ordersPath });

    expect(router.resolveOrderExecForQueue('non-existent-id')).toBeNull();
  });

  it('records usedAt at resolve time (crash-safe, before the task runs)', () => {
    const ordersPath = path.join(tmpDir, 'orders-resolve4.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('usedat at resolve');

    const { router } = createRouter({ ordersPath });
    router.resolveOrderExecForQueue(order.id);

    const reloaded = new OrderStore(ordersPath);
    expect(reloaded.get()[0]?.usedAt).toBeDefined();
  });
});
