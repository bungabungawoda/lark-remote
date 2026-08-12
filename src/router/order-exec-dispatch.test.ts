import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from './index.js';
import { SessionStore, SessionReaderRegistry } from '../session/index.js';
import { OrderStore } from '../order/index.js';
import { Bridge } from '../bridge/index.js';
import { AppConfigSchema } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { Runner } from '../runner/index.js';
import { dispatchOrderExecForQueue } from './order-exec-dispatch.js';

import {
  createStubAgentRegistry,
  createStubRunner,
  createStubSessionReaderRegistry,
} from '../../tests/lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

/** A promise that stays pending until `release()` is called. Keeps a task
 *  blocking the serial queue so subsequently enqueued tasks stay queued. */
function hang(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-dispatch-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter(ordersPath: string) {
  const sessionStore = new SessionStore();
  const sent: { chatId: string; input: unknown; opts?: { replyTo?: string } }[] = [];
  const connector = {
    sendWithRetry: async (chatId: string, input: unknown, opts?: { replyTo?: string }) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => 'stream-msg-id',
    updateCard: async () => {},
    connected: true,
    _sent: sent,
  };
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
  const stubRunner = createStubRunner() as Runner;
  const bridge = new Bridge({
    runner: stubRunner,
    agentRegistry: createStubAgentRegistry(stubRunner),
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
  return { router, bridge, sessionStore, connector };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'card-msg-1' };

describe('dispatchOrderExecForQueue: order.exec → equivalent queued message', () => {
  it('enqueues with the real order text as messagePreview and a unique internal key', async () => {
    const ordersPath = path.join(tmpDir, 'orders.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('build the project');
    const { router, bridge } = createRouter(ordersPath);
    const workspace = '/some/ws';

    // Block the serial queue so the dispatched task stays queued (otherwise the
    // queue chain runs it synchronously and removes it from queuedTasks).
    const blocker = hang();
    bridge.enqueue(workspace, async () => {
      await blocker.promise;
    });
    await new Promise((r) => setTimeout(r, 20));

    const status = await dispatchOrderExecForQueue({
      router,
      bridge,
      workspace,
      orderId: order.id,
      ctx,
    });

    expect(status).toBe('enqueued');
    // The queued task must carry the REAL order text as messagePreview (the
    // original bug showed "card action: order.exec" here) and a unique key.
    const tasks = bridge.getQueuedTasks(workspace);
    const ours = tasks.find((t) => t.messagePreview === 'build the project');
    expect(ours).toBeDefined();
    expect(ours?.messageId).toMatch(/^order-/);
    expect(ours?.messageId).toContain(order.id);
    // The Feishu card messageId must NOT be reused as the queue key.
    expect(ours?.messageId).not.toBe(ctx.messageId);

    blocker.release();
  });

  it('does not collide when the same order card is clicked twice rapidly', async () => {
    const ordersPath = path.join(tmpDir, 'orders2.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('repeated order');
    const { router, bridge } = createRouter(ordersPath);
    const workspace = '/some/ws';

    // Block the queue so both dispatches stay queued together.
    const blocker = hang();
    bridge.enqueue(workspace, async () => {
      await blocker.promise;
    });
    await new Promise((r) => setTimeout(r, 20));

    await dispatchOrderExecForQueue({ router, bridge, workspace, orderId: order.id, ctx });
    await dispatchOrderExecForQueue({ router, bridge, workspace, orderId: order.id, ctx });

    const tasks = bridge
      .getQueuedTasks(workspace)
      .filter((t) => t.messagePreview === 'repeated order');
    expect(tasks).toHaveLength(2);
    const keys = tasks.map((t) => t.messageId);
    expect(keys[0]).not.toBe(keys[1]);
    // Both carry the real text, not the channel metadata.
    expect(tasks.every((t) => t.messagePreview === 'repeated order')).toBe(true);
    // Neither reuses the Feishu card messageId.
    expect(keys.every((k) => k !== ctx.messageId)).toBe(true);

    blocker.release();
  });

  it('forwards the real order text through router.handle (the hand-typed path)', async () => {
    const ordersPath = path.join(tmpDir, 'orders-forward.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('run the tests');
    const { router, bridge } = createRouter(ordersPath);
    const workspace = '/some/ws';

    const handleSpy = vi.spyOn(router, 'handle');

    await dispatchOrderExecForQueue({ router, bridge, workspace, orderId: order.id, ctx });
    // The queue chain runs the closure synchronously (no blocker); let the
    // microtask settle so router.handle is invoked.
    await new Promise((r) => setTimeout(r, 20));

    expect(handleSpy).toHaveBeenCalledTimes(1);
    // First arg is the REAL order text, not "card action: order.exec".
    expect(handleSpy.mock.calls[0]?.[0]).toBe('run the tests');
    // ctx (userId/chatId/messageId) is forwarded for replies/reactions.
    expect(handleSpy.mock.calls[0]?.[1]).toMatchObject(ctx);
  });

  it('replies the queue status card to the Feishu card messageId, not the internal key', async () => {
    const ordersPath = path.join(tmpDir, 'orders-replyto.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('queued behind a runner');
    const { router, bridge, connector } = createRouter(ordersPath);
    const workspace = '/some/ws';

    // Block the queue so the dispatched order.exec task has to wait → a queue
    // status card is sent (the replyTo regression only manifests when waiting).
    // The blocker itself carries taskMeta so it registers as a running task
    // (pendingOrExecutingCount++ / added to queuedTasks); without taskMeta the
    // queue manager skips bookkeeping and the order task would not "wait".
    const blocker = hang();
    bridge.enqueue(
      workspace,
      async () => {
        await blocker.promise;
      },
      {
        taskMeta: {
          userId: ctx.userId,
          chatId: ctx.chatId,
          messageId: 'blocker-key',
          messagePreview: 'blocker',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 20));

    await dispatchOrderExecForQueue({ router, bridge, workspace, orderId: order.id, ctx });
    // sendQueueStatusCard is async (awaits sendCard); let it settle.
    await new Promise((r) => setTimeout(r, 20));

    // The queued task's messageId is the internal key (queue dedup), NOT the
    // Feishu card id — verified by the first test. The queue status card must
    // instead be REPLIED to the real Feishu card messageId (ctx.messageId),
    // because `replyTo` is a Feishu message id, not an internal queue key.
    const tasks = bridge.getQueuedTasks(workspace);
    const ours = tasks.find((t) => t.messagePreview === 'queued behind a runner');
    expect(ours).toBeDefined();
    expect(ours?.messageId).toMatch(/^order-/);

    // Find the queue-status-card send (the only send while waiting). It must
    // carry opts.replyTo === the Feishu card messageId, not the internal key.
    const cardSend = connector._sent.find((s) => typeof s.input === 'object' && s.input !== null);
    expect(cardSend).toBeDefined();
    expect(cardSend?.opts?.replyTo).toBe(ctx.messageId);
    expect(cardSend?.opts?.replyTo).not.toBe(ours?.messageId);

    blocker.release();
  });

  it('surfaces an error when orderId is missing', async () => {
    const ordersPath = path.join(tmpDir, 'orders3.json');
    new OrderStore(ordersPath);
    const { router, bridge } = createRouter(ordersPath);

    const status = await dispatchOrderExecForQueue({
      router,
      bridge,
      workspace: '/ws',
      orderId: undefined,
      ctx,
    });

    expect(status).toBe('missing-id');
    expect(bridge.getQueuedTasks('/ws')).toHaveLength(0);
  });

  it('surfaces an error when the order no longer exists', async () => {
    const ordersPath = path.join(tmpDir, 'orders4.json');
    new OrderStore(ordersPath);
    const { router, bridge } = createRouter(ordersPath);

    const status = await dispatchOrderExecForQueue({
      router,
      bridge,
      workspace: '/ws',
      orderId: 'non-existent-id',
      ctx,
    });

    expect(status).toBe('not-found');
    expect(bridge.getQueuedTasks('/ws')).toHaveLength(0);
  });

  it('test_anchor_order_exec_captures_binding_at_enqueue', async () => {
    const ordersPath = path.join(tmpDir, 'orders-binding.json');
    const orderStore = new OrderStore(ordersPath);
    const order = orderStore.save('capture my binding');
    const { router, bridge, sessionStore } = createRouter(ordersPath);
    const workspace = '/some/ws';

    // Give the claude slot a session so currentBinding captures a non-empty sessionId.
    sessionStore.setSessionIdAndCwd(ctx.userId, 'claude', 'sess-ORDER-1', workspace);

    // Spy on router.handle to capture opts (3rd arg) passed inside the enqueue closure.
    const handleSpy = vi.spyOn(router, 'handle');

    // Block the serial queue so the dispatched order task stays queued (so we can
    // read its taskMeta before it executes).
    const blocker = hang();
    bridge.enqueue(workspace, async () => {
      await blocker.promise;
    });
    await new Promise((r) => setTimeout(r, 20));

    await dispatchOrderExecForQueue({ router, bridge, workspace, orderId: order.id, ctx });
    await new Promise((r) => setTimeout(r, 20));

    // Assertion A (before release): taskMeta.binding captured at enqueue time.
    const tasks = bridge.getQueuedTasks(workspace);
    const ours = tasks.find((t) => t.messagePreview === 'capture my binding');
    expect(ours).toBeDefined();
    expect(ours?.binding).toBeDefined();
    expect(ours?.binding?.agent).toBe('claude');
    expect(ours?.binding?.sessionId).toBe('sess-ORDER-1');

    // Release the blocker so the enqueue closure runs router.handle.
    blocker.release();
    await new Promise((r) => setTimeout(r, 30));

    // Assertion B: router.handle was called with opts.binding captured at enqueue.
    const handleCall = handleSpy.mock.calls.find((c) => c[0] === 'capture my binding');
    expect(handleCall).toBeDefined();
    const opts = handleCall![2] as { binding?: { agent: string; sessionId?: string } } | undefined;
    expect(opts?.binding).toBeDefined();
    expect(opts?.binding?.agent).toBe('claude');
    expect(opts?.binding?.sessionId).toBe('sess-ORDER-1');
  });
});
