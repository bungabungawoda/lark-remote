/**
 * Shared stub factories for Bridge dependency registries and test doubles.
 *
 * Every test file that constructs `new Bridge({ ... })` must pass
 * `agentRegistry` and `sessionReaderRegistry` (both are required since
 * the registry-mandatory refactor). Import from here to avoid duplicating
 * boilerplate across 60+ test files.
 *
 * Usage:
 *   import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
 *   const bridge = new Bridge({
 *     runner,
 *     connector,
 *     sessionStore,
 *     config,
 *     agentRegistry: createStubAgentRegistry(runner),
 *     sessionReaderRegistry: createStubSessionReaderRegistry(),
 *   });
 */

import { vi } from 'vitest';
import type { Runner, AgentSessionReader } from '../../src/runner/index.js';
import { AgentRegistry } from '../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import { ClaudeSessionReader } from '../../src/session/claude/index.js';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';

// ── Agent registry ──────────────────────────────────────────────────

/** Create a minimal AgentRegistry that maps all agent kinds to the given runner. */
export function createStubAgentRegistry(runner: Runner): AgentRegistry {
  const reg = new AgentRegistry();
  // AgentRegistry factories are typed `() => Runner` (see registry.ts), so a
  // shared stub runner registers directly — no cast needed.
  const asAgent = () => runner;
  reg.register('claude', asAgent);
  reg.register('codex', asAgent);
  reg.register('opencode', asAgent);
  reg.register('pi', asAgent);
  reg.register('kimi', asAgent);
  return reg;
}

// ── Session reader registry ─────────────────────────────────────────

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

/**
 * 返回一个「空结果 / not_found」的 AgentSessionReader。
 *
 * 此前 router.test.ts / bridge.test.ts 各自内联了同一形状的 reader（DRY），
 * 统一从这里取。reader 无状态，可安全共享同一实例。
 */
export function createStubSessionReader(): AgentSessionReader {
  return stubSessionReader;
}

export interface StubSessionReaderRegistryOpts {
  /** Register stub readers for all 5 agent kinds. */
  registerStubReaders?: boolean;
  /** Inject a real ClaudeSessionReader pointing to this directory. */
  claudeProjectsDir?: string;
}

/**
 * Create a SessionReaderRegistry.
 *
 * - Default (no opts): registers 5 stub readers returning empty results.
 * - `{ registerStubReaders: false }`: empty registry (no readers registered).
 * - `{ claudeProjectsDir: string }`: register a real ClaudeSessionReader (overrides stub).
 */
export function createStubSessionReaderRegistry(
  opts?: StubSessionReaderRegistryOpts,
): SessionReaderRegistry {
  const registry = new SessionReaderRegistry();

  if (opts?.registerStubReaders !== false) {
    registry.register('claude', stubSessionReader);
    registry.register('codex', stubSessionReader);
    registry.register('opencode', stubSessionReader);
    registry.register('pi', stubSessionReader);
    registry.register('kimi', stubSessionReader);
  }

  if (opts?.claudeProjectsDir) {
    registry.register('claude', new ClaudeSessionReader({ projectsDir: opts.claudeProjectsDir }));
  }

  return registry;
}

// ── Stub connector ──────────────────────────────────────────────────

export interface StubConnectorOpts {
  /** When true, addReaction returns a vi.fn().mockResolvedValue(undefined) spy. */
  addReactionSpy?: boolean;
  /** When true, removeReactionByEmoji returns a vi.fn().mockResolvedValue(undefined) spy. */
  removeReactionSpy?: boolean;
  /** When provided, streamCard update calls also push to this array. */
  recordUpdates?: { sent: unknown[] };
}

/**
 * Create a stub connector that records sent messages and cards.
 *
 * Mainstream version used by ~22 test files. Two optional params:
 * - `addReactionSpy`: useful for reaction-related tests
 * - `removeReactionSpy`: useful for reaction-retract tests
 * - `recordUpdates`: useful for bash-command tests that need to track card updates
 */
export function createStubConnector(opts?: StubConnectorOpts) {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const cards: object[] = [];
  const updates: { card: object }[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts2?: unknown) => {
      sent.push({ chatId, input, opts: opts2 });
      return 'msg-id';
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined });
      return 'file-msg-id';
    },
    reconnect: async () => {},
    addReaction: opts?.addReactionSpy ? vi.fn().mockResolvedValue(undefined) : async () => {},
    removeReactionByEmoji: opts?.removeReactionSpy
      ? vi.fn().mockResolvedValue(undefined)
      : async () => {},
    streamCard: async (
      chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
      opts2?: unknown,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts: opts2 });
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
          // Record updates so tests can see final card
          sent.push({ chatId, input: { card: current }, opts: opts2 });
          opts?.recordUpdates?.sent.push({ chatId, input: { card: current }, opts: opts2 });
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async (messageId: string, card: object) => {
      cards.push(card);
      updates.push({ messageId, card });
    },
    connected: true,
    _sent: sent,
    _cards: cards,
    _updates: updates,
    _updateCardCalls: updates,
  };
}

/**
 * Connector 变体：card PATCH（updateCard）挂起直到测试 release。
 *
 * 复现生产竞态：飞书 updateCard API 往返期间串行队列链继续推进。
 * 行为变体按 AGENTS.md 约定收敛到共享工厂（独立命名导出）。
 */
export function createStubConnectorWithGatedCardUpdate() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
  const cards: object[] = [];
  const updateCalls: string[] = [];
  const gateResolvers: Array<() => void> = [];

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
      const header = (card as { header?: { title?: { content?: string } } }).header;
      updateCalls.push(header?.title?.content ?? '');
      // Block the card PATCH until the test releases it.
      await new Promise<void>((resolve) => gateResolvers.push(resolve));
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
    _updateCalls: updateCalls,
    // Resolve ALL parked card updates: with the fix, several updateCard calls
    // (cancelled A/B cards + the target's executing card, incl. the begin-path
    // update) can be parked concurrently; a single-last-resolver gate would
    // leave the handler awaiting an older gate forever.
    releaseCardGate: () => {
      for (const resolve of gateResolvers.splice(0)) resolve();
    },
  };
}

/**
 * Connector 变体：队列状态卡（sendWithRetry({ card })）的发送挂起直到测试
 * release；文本发送立即 resolve。
 *
 * 复现 A5 生产竞态：飞书 API 延迟 / 99991400 限流重试使排队卡 send promise
 * pending，而运行中任务被 stop、settle 推进队列链。
 */
export function createStubConnectorWithPendingQueueCard() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
  const cards: object[] = [];
  let resolveQueueCardSend: (() => void) | undefined;

  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      const hasCard =
        !!input && typeof input === 'object' && 'card' in (input as Record<string, unknown>);
      if (hasCard) {
        // Queue status card send stays pending until the test releases it.
        return new Promise<string>((resolve) => {
          resolveQueueCardSend = () => resolve('queue-card-msg');
        });
      }
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
    resolveQueueCardSend: () => resolveQueueCardSend?.(),
  };
}

// ── Mock session reader registry ────────────────────────────────────

/**
 * Create a mock SessionReaderRegistry.
 *
 * Builds a real registry so no `as unknown as` cast is needed. Two variants:
 * - Default: empty registry (no readers registered).
 * - `{ withGet: true }`: `get` returns a stub reader with empty results.
 * - `{ agentKinds: [...] }`: override the (mock-only) listRegistered probe.
 */
export interface MockSessionReaderRegistryOpts {
  /** Agent kinds returned by listRegistered. Default: all 5. */
  agentKinds?: string[];
  /** When true, get() returns a stub reader instead of undefined. */
  withGet?: boolean;
}

export function createMockSessionReaderRegistry(
  opts?: MockSessionReaderRegistryOpts,
): SessionReaderRegistry {
  const registry = new SessionReaderRegistry();
  const kinds = opts?.agentKinds ?? ['claude', 'codex', 'pi', 'opencode', 'kimi'];
  if (opts?.withGet) {
    vi.spyOn(registry, 'get').mockReturnValue(stubSessionReader);
  } else {
    // Legacy semantics: get() returns undefined (callers guard for it, e.g.
    // the config.save restore fallback), NOT the real registry's throw.
    vi.spyOn(registry, 'get').mockImplementation(() => undefined);
  }
  // Legacy mock-only member (not on the real class): keep for any consumer
  // that still probes registered agent kinds.
  Object.assign(registry, { listRegistered: vi.fn().mockReturnValue(kinds) });
  return registry;
}

// ── Stub runner ─────────────────────────────────────────────────────

export interface StubRunnerOpts {
  /**
   * 'throw' (default): run() throws an error — catches accidental invocations.
   * 'empty': run() is an empty generator — for tests that iterate over run output.
   * 'streaming': run() yields the provided events — for tests that need AgentEvent output.
   */
  mode?: 'throw' | 'empty' | 'streaming';
  /** Events to yield when mode is 'streaming'. */
  events?: import('../../src/runner/index.js').AgentEvent[];
  /** When true, include getStatusInfo returning { kind: 'claude', model: 'test-model' }. */
  withStatusInfo?: boolean;
  /**
   * When true, skip auto-injecting a synthetic system.init before the first
   * result event (§9.22). Use this for tests that intentionally cover the
   * "no init arrived" path (e.g. stream-failure fallback).
   */
  noAutoInit?: boolean;
}

/**
 * Create a stub runner.
 *
 * Three modes with different semantics (do NOT merge):
 * - `'throw'` (default): run() throws. Use when tests should never trigger run.
 * - `'empty'`: run() is an empty generator. Use when tests iterate over run output.
 * - `'streaming'`: run() yields provided events. Use when tests need AgentEvent output.
 */
export function createStubRunner(opts?: StubRunnerOpts): Runner {
  const mode = opts?.mode ?? 'throw';
  // §9.22: bridge pre-init result guard requires system.init before result.
  // Auto-inject a synthetic init when the events list has a result but no init,
  // so existing test mocks don't all need manual init events.
  // Skip when noAutoInit is set (for tests that intentionally cover no-init paths).
  let events = opts?.events ?? [];
  if (mode === 'streaming' && !opts?.noAutoInit && events.length > 0) {
    const hasInit = events.some(
      (e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init',
    );
    const hasResult = events.some((e) => e.type === 'result');
    if (hasResult && !hasInit) {
      events = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'stub-session',
        } as import('../../src/runner/index.js').AgentEvent,
        ...events,
      ];
    }
  }
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    ...(opts?.withStatusInfo
      ? { getStatusInfo: () => ({ kind: 'claude', model: 'test-model' }) }
      : {}),
    ...(mode === 'throw'
      ? {
          run: async function* () {
            throw new Error('run not expected in stub');
          },
        }
      : mode === 'streaming'
        ? {
            run: async function* () {
              for (const e of events) yield e;
            },
          }
        : {
            run: async function* () {},
          }),
  } as Runner;
}

// ── Bridge factory ──────────────────────────────────────────────────

export interface MakeBridgeOpts {
  runner?: Runner;
  idleTimeoutMs?: number;
  connector?: ReturnType<typeof createStubConnector>;
  /** 覆盖默认测试 config；不传时使用 defaultTestConfig()。 */
  config?: AppConfig;
}

/**
 * 组装一个接好共享 stub 的 Bridge（agent registry + session reader registry
 * + connector + session store）。
 *
 * 此前 5 个测试文件各自复制了同一份 ~20 行样板（DRY），统一收敛到这里。
 * runner 默认 throw-stub；需要特定 runner 时经 opts.runner 注入。
 */
export function makeBridge(opts: MakeBridgeOpts = {}) {
  const sessionStore = new SessionStore();
  const connector = opts.connector ?? createStubConnector();
  const runner = opts.runner ?? createStubRunner();
  const bridge = new Bridge({
    runner,
    connector,
    sessionStore,
    config: opts.config ?? defaultTestConfig(),
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  });
  return { bridge, sessionStore, connector, runner };
}

/** 各测试 beforeEach 里 AppConfigSchema.parse(...) 的公共最小配置。 */
function defaultTestConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
}

// ── Mock bridge ─────────────────────────────────────────────────────

/**
 * Create a mock Bridge with vi.fn() stubs for all methods.
 *
 * `sendResult` defaults to `vi.fn().mockResolvedValue(true)` (real success).
 * Override to `undefined` with `{ sendResult: vi.fn().mockResolvedValue(undefined) }`.
 */
export function createMockBridge(overrides?: Partial<Bridge>): Bridge {
  return {
    sendResult: vi.fn().mockResolvedValue(true),
    forwardToClaude: vi.fn().mockResolvedValue(undefined),
    isBusy: false,
    isBusyFor: vi.fn().mockReturnValue(false),
    enqueue: vi.fn(),
    interruptCurrentRun: vi.fn().mockResolvedValue(false),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn(),
    setIdleTimeout: vi.fn(),
    removeFromQueue: vi.fn().mockReturnValue(false),
    getQueuedTasks: vi.fn().mockReturnValue([]),
    getQueuedTask: vi.fn().mockReturnValue(undefined),
    getQueueInfo: vi.fn().mockReturnValue({ position: 0, isRunning: false, tasksAhead: 0 }),
    getAllActiveRuns: vi.fn().mockReturnValue(new Map()),
    sendFile: vi.fn().mockResolvedValue(''),
    getActiveRunFor: vi.fn().mockReturnValue(undefined),
    updateCardInPlace: vi.fn().mockResolvedValue(undefined),
    hasRunCompact: vi.fn().mockReturnValue(false),
    syncActiveApprovalModes: vi.fn(),
    onInboundMedia: vi.fn().mockResolvedValue(undefined),
    flushMediaNotifications: vi.fn(),
    flushAllMediaNotifications: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Bridge;
}
