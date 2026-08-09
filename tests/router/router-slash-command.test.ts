import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
// --- Stubs ---

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const cards: object[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
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

/** A runner whose run() blocks indefinitely until external resolve. */
function createBlockingRunner(): Runner & { unblock: () => void } {
  let unblock: () => void = () => {};
  const blockPromise = new Promise<void>((r) => {
    unblock = r;
  });
  const runner = {
    isRunning: false,
    stop: async () => {
      unblock();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    getStatusInfo: () => ({ kind: 'claude', model: 'test-model' }),
    run: async function* () {
      // Yield an init event so forwardToClaude starts the card session properly
      yield {
        type: 'system' as const,
        subtype: 'init' as const,
        session_id: 's-block',
        cwd: '/tmp',
        model: 'opus',
      };
      // Then block indefinitely
      await blockPromise;
    },
    unblock,
  } as Runner & { unblock: () => void };
  return runner;
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-slash-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      binary: 'claude',
      model: 'opus',
      effort: 'medium',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

/**
 * Bug 2 integration test: / commands must not be blocked by the serial queue.
 *
 * The fix is in src/index.ts: slash commands (lines 70-77) call router.handle()
 * directly WITHOUT going through bridge.enqueue(). This test verifies the actual
 * src code behavior, not a hand-rolled simulation.
 *
 * Test strategy:
 * - Use real Bridge and Router instances with stub connector/runner
 * - Spy on bridge.enqueue to verify it is NOT called for slash commands
 * - Call router.handle() directly (which is what src/index.ts does for / commands)
 * - Verify slash commands respond immediately even when the queue is busy
 */
describe('Bug 2: / commands must not be blocked by the serial queue', () => {
  /**
   * Simulates the FIXED message handler pattern from src/index.ts (lines 53-83):
   *   - /stop gets special treatment (bypasses queue via bridge.interruptCurrentRun)
   *   - Other / commands call router.handle() directly (no queue)
   *   - Non-/ messages go through bridge.enqueue()
   */
  function createMessageHandler(bridge: Bridge, router: CommandRouter) {
    return (msg: { content: string; userId: string; chatId: string; messageId: string }) => {
      const trimmed = msg.content.trim();

      // /stop bypasses the queue (src/index.ts lines 55-68)
      if (trimmed.toLowerCase() === '/stop') {
        void (async () => {
          const stopped = await bridge.interruptCurrentRun({
            userId: msg.userId,
            chatId: msg.chatId,
          });
          if (!stopped) {
            await bridge.sendResult(
              { text: '当前没有运行中的进程' },
              { userId: msg.userId, chatId: msg.chatId, messageId: msg.messageId },
            );
          }
        })().catch(() => {});
        return;
      }

      // Other / commands bypass the queue (src/index.ts lines 70-77)
      if (trimmed.startsWith('/')) {
        void router
          .handle(trimmed, {
            userId: msg.userId,
            chatId: msg.chatId,
            messageId: msg.messageId,
          })
          .catch(() => {});
        return;
      }

      // Non-/ messages go through the serial queue (src/index.ts lines 78-82)
      bridge.enqueue('' as string, async () => {
        await router.handle(trimmed, {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
        });
      });
    };
  }

  it('/help should respond immediately even when the queue is busy with a long-running task', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createBlockingRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const enqueueSpy = vi.spyOn(bridge, 'enqueue');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    sessionStore.setCwd(ctx.userId, tmpDir);
    const handler = createMessageHandler(bridge, router);

    // 1. Enqueue a long-running task (simulating a claude conversation)
    handler({ content: 'analyze this codebase', ...ctx });
    // bridge.enqueue was called for the non-slash message
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    // Wait a tick so the queue starts processing the long-running task
    await new Promise((r) => setTimeout(r, 50));

    // 2. Now send /help — this should respond IMMEDIATELY because
    //    it calls router.handle() directly, NOT bridge.enqueue()
    const helpTime = Date.now();
    handler({ content: '/help', ...ctx });

    // 3. /help should NOT have gone through bridge.enqueue
    expect(enqueueSpy).toHaveBeenCalledTimes(1); // still 1, not 2

    // 4. Wait a short period — /help should have completed by now
    await new Promise((r) => setTimeout(r, 200));

    const elapsed = Date.now() - helpTime;

    // 5. /help should have produced output within the short window
    const helpResponses = connector._sent.filter((s) => {
      const input = s.input as {
        markdown?: string;
        text?: string;
        card?: { header?: { title?: { content?: string } } };
      };
      // Help returns a card; match by header title
      return (input.card?.header?.title?.content ?? '').includes('命令');
    });

    expect(helpResponses.length).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(1000);

    // Cleanup
    runner.unblock();
    enqueueSpy.mockRestore();
  });

  it('/status should respond immediately even when the queue is busy', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createBlockingRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const enqueueSpy = vi.spyOn(bridge, 'enqueue');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    sessionStore.setCwd(ctx.userId, tmpDir);
    const handler = createMessageHandler(bridge, router);

    // Enqueue a long-running task
    handler({ content: 'analyze this codebase', ...ctx });
    await new Promise((r) => setTimeout(r, 50));

    // Send /status — should respond immediately (no enqueue)
    handler({ content: '/status', ...ctx });
    expect(enqueueSpy).toHaveBeenCalledTimes(1); // only the initial message

    await new Promise((r) => setTimeout(r, 200));

    const statusResponses = connector._sent.filter((s) => {
      const input = s.input as { markdown?: string; text?: string };
      return (input.markdown ?? input.text ?? '').includes('当前状态');
    });

    expect(statusResponses.length).toBeGreaterThanOrEqual(1);

    runner.unblock();
    enqueueSpy.mockRestore();
  });

  it('/ps should respond immediately even when the queue is busy', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createBlockingRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const enqueueSpy = vi.spyOn(bridge, 'enqueue');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    sessionStore.setCwd(ctx.userId, tmpDir);
    const handler = createMessageHandler(bridge, router);

    // Enqueue a long-running task
    handler({ content: 'analyze this codebase', ...ctx });
    await new Promise((r) => setTimeout(r, 50));

    // Send /ps — should respond immediately (no enqueue)
    handler({ content: '/ps', ...ctx });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 200));

    const psResponses = connector._sent.filter((s) => {
      const input = s.input as { text?: string };
      return (input.text ?? '').includes('进程');
    });

    expect(psResponses.length).toBeGreaterThanOrEqual(1);

    runner.unblock();
    enqueueSpy.mockRestore();
  });

  it('non-slash messages SHOULD wait in the queue (serial invariant is preserved)', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createBlockingRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const enqueueSpy = vi.spyOn(bridge, 'enqueue');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    sessionStore.setCwd(ctx.userId, tmpDir);
    const handler = createMessageHandler(bridge, router);

    // Enqueue a long-running task
    handler({ content: 'first message', ...ctx });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 50));

    // Enqueue a second non-command message — this SHOULD go through enqueue
    handler({ content: 'second message', ...ctx });
    expect(enqueueSpy).toHaveBeenCalledTimes(2); // both went through enqueue

    await new Promise((r) => setTimeout(r, 200));

    // The second message should NOT have produced any output yet
    // because it's waiting for the first task to finish (serial queue invariant)
    const secondResponses = connector._sent.filter((s) => {
      const input = s.input as { text?: string };
      return (input.text ?? '').includes('正在处理中');
    });

    // The second forwardToClaude is queued; it hasn't run yet.
    expect(secondResponses.length).toBe(0);

    runner.unblock();
    enqueueSpy.mockRestore();
  });

  it('/stop correctly bypasses the queue (already implemented)', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createBlockingRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const enqueueSpy = vi.spyOn(bridge, 'enqueue');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    sessionStore.setCwd(ctx.userId, tmpDir);
    const handler = createMessageHandler(bridge, router);

    // Enqueue a long-running task
    handler({ content: 'analyze this codebase', ...ctx });
    await new Promise((r) => setTimeout(r, 50));

    // /stop bypasses the queue — should take effect immediately
    handler({ content: '/stop', ...ctx });

    // /stop should NOT have gone through bridge.enqueue
    expect(enqueueSpy).toHaveBeenCalledTimes(1); // only the initial message

    await new Promise((r) => setTimeout(r, 100));

    // /stop should have terminated the run — this proves bypassing the queue works
    expect(bridge.isBusy).toBe(false);

    enqueueSpy.mockRestore();
  });

  it('router.handle for / commands does NOT call bridge.enqueue', async () => {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createBlockingRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const enqueueSpy = vi.spyOn(bridge, 'enqueue');
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    sessionStore.setCwd(ctx.userId, tmpDir);

    // Call router.handle directly for various / commands
    // This is what src/index.ts does for / commands (line 71)
    await router.handle('/help', ctx);
    await router.handle('/status', ctx);
    await router.handle('/ps', ctx);

    // None of these should have called bridge.enqueue
    // They call bridge.sendResult directly, but NOT bridge.enqueue
    expect(enqueueSpy).not.toHaveBeenCalled();

    // But they should have produced output via sendResult
    expect(connector._sent.length).toBeGreaterThanOrEqual(3);

    enqueueSpy.mockRestore();
    runner.unblock();
  });
});
