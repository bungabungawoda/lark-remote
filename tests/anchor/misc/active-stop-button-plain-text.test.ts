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

import { createStubAgentRegistry } from '../../lib/bridge-stubs.js';
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
    streamCard: async () => 'stream-msg-id',
    updateCard: async () => {},
    connected: true,
    _sent: sent,
  };
}

function createStubRunner() {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    getStatusInfo: () => ({ kind: 'claude', model: 'test-model' }),
    run: async function* () {
      throw new Error('run not expected in stub');
    },
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-anchor-active-stop-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type CardElement = {
  tag?: string;
  text?: { tag?: string; content?: string };
  behaviors?: Array<{ value?: { cmd?: string } }>;
  elements?: CardElement[];
  columns?: Array<{ elements?: CardElement[] }>;
};

function collectStopButtons(el: CardElement | undefined, out: CardElement[] = []): CardElement[] {
  if (!el) return out;
  if (el.tag === 'button' && el.behaviors?.some((b) => b.value?.cmd === 'stop')) {
    out.push(el);
  }
  if (el.elements) for (const c of el.elements) collectStopButtons(c, out);
  if (el.columns)
    for (const c of el.columns) for (const e of c.elements ?? []) collectStopButtons(e, out);
  return out;
}

describe('P2-27: /active card stop buttons must have tag:plain_text', () => {
  it('test_anchor_active_card_stop_buttons_have_plain_text_tag', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
    const bridge = new Bridge({
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });

    const activeRuns = [
      {
        runId: 'run-1',
        sessionId: 'sess-1',
        cwd: '/tmp/test-cwd',
        userId: 'user1',
        chatId: 'chat1',
        terminal: 'running' as const,
      },
    ];
    const activeBashRuns = [
      {
        runId: 'bash-1',
        cwd: '/tmp/test-cwd',
        userId: 'user1',
        chatId: 'chat1',
        terminal: 'running' as const,
        command: 'ls -la',
      },
    ];

    (bridge as unknown as { getActiveRuns: () => typeof activeRuns }).getActiveRuns = () =>
      activeRuns;
    (bridge as unknown as { getActiveBashRuns: () => typeof activeBashRuns }).getActiveBashRuns =
      () => activeBashRuns;

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    await router.handle('/active', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    const response = connector._sent[0].input as { card?: { body?: { elements?: CardElement[] } } };
    expect(response.card).toBeDefined();

    const elements = response.card?.body?.elements ?? [];
    const stopButtons: CardElement[] = [];
    for (const el of elements) collectStopButtons(el, stopButtons);

    // We expect at least two stop buttons (one for run, one for bash)
    expect(stopButtons.length).toBeGreaterThanOrEqual(2);

    // Every stop button's text must have tag === 'plain_text' (CardKit 2.0 contract)
    for (const btn of stopButtons) {
      expect(btn.text?.tag).toBe('plain_text');
    }
  });
});
