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
import type { Runner, AgentRunner, AgentSessionReader } from '../../src/runner/index.js';
import { AgentRegistry } from '../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import { ClaudeSessionReader } from '../../src/session/claude/index.js';
import type { Bridge } from '../../src/bridge/index.js';

// ── Agent registry ──────────────────────────────────────────────────

/** Create a minimal AgentRegistry that maps all agent kinds to the given runner. */
export function createStubAgentRegistry(runner: Runner): AgentRegistry {
  const reg = new AgentRegistry();
  const asAgent = () => runner as unknown as AgentRunner;
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
  /** When provided, streamCard update calls also push to this array. */
  recordUpdates?: { sent: unknown[] };
}

/**
 * Create a stub connector that records sent messages and cards.
 *
 * Mainstream version used by ~22 test files. Two optional params:
 * - `addReactionSpy`: useful for reaction-related tests
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

// ── Mock session reader registry ────────────────────────────────────

/**
 * Create a mock SessionReaderRegistry using `as unknown as` cast.
 *
 * Used by tests that need `listRegistered` to return specific agent kinds
 * without registering real readers. Two variants:
 * - Default: `{ listRegistered, get }` only (get returns undefined).
 * - `{ withGet: true }`: `get` returns a stub reader with empty results.
 * - `{ agentKinds: [...] }`: override which agent kinds listRegistered returns.
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
  const kinds = opts?.agentKinds ?? ['claude', 'codex', 'pi', 'opencode', 'kimi'];
  return {
    listRegistered: vi.fn().mockReturnValue(kinds),
    get: opts?.withGet
      ? vi.fn().mockReturnValue({
          listSessions: () => ({ sessions: [], total: 0 }),
          getNewestSession: () => null,
          readSessionContent: () => ({ events: [] }),
          isSessionActive: () => false,
        })
      : vi.fn(),
    register: vi.fn(),
  } as unknown as SessionReaderRegistry;
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
    ...overrides,
  } as Bridge;
}
