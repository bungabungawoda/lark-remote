import { describe, expect, it, vi } from 'vitest';
import { setupMessageHandlers } from './message-handlers.js';

type Message = {
  userId: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  rawContentType: string;
  content: string;
};

type CardAction = {
  operator: { openId: string };
  chatId: string;
  messageId: string;
  action: { value: Record<string, unknown> };
};

function makeHarness(opts: { cloneActive?: boolean } = {}) {
  const handlers: {
    message?: (msg: Message) => void;
    card?: (action: CardAction) => Promise<unknown>;
    media?: (msg: Message) => void;
  } = {};
  const order: string[] = [];

  const connector = {
    setMessageHandler: vi.fn((fn) => (handlers.message = fn)),
    setCardActionHandler: vi.fn((fn) => (handlers.card = fn)),
    setInboundMediaDetectedHandler: vi.fn((fn) => (handlers.media = fn)),
    sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
    addReaction: vi.fn().mockResolvedValue(undefined),
    downloadInboundMedia: vi.fn().mockResolvedValue({ media: [], failures: [] }),
  };
  const router = {
    config: {
      defaultAgent: 'claude',
      inboundMedia: { enabled: true, maxFileSizeMb: 100 },
    },
    setInboundFlusher: vi.fn(),
    expandAliasMessage: vi.fn((text: string) => (text === '$help' ? '/help' : text)),
    handle: vi.fn(async (text: string) => {
      order.push(`handle:${text}`);
    }),
    handleCardAction: vi.fn(async (value: { cmd: string }) => {
      order.push(`card:${value.cmd}`);
      return { toast: { type: 'error', content: 'action failed' } };
    }),
    cmdHelp: vi.fn(() => ({ card: { schema: '2.0' } })),
    mintQueueTaskKey: vi.fn((kind: string, cmd: string) => `${kind}:${cmd}:1`),
  };
  const bridge = {
    currentBinding: vi.fn(() => undefined),
    enqueue: vi.fn((_cwd: string, task: () => Promise<void>) => {
      order.push('enqueue:text');
      void task();
    }),
    enqueueImmediate: vi.fn((_cwd: string, task: () => Promise<void>) => {
      order.push('enqueue:immediate');
      void task();
    }),
    sendResult: vi.fn().mockResolvedValue(true),
    interruptCurrentRunDetailed: vi.fn().mockResolvedValue({ stopped: false }),
    saveInboundMedia: vi.fn().mockResolvedValue({ attachments: [], rejected: [] }),
  };
  const binder = {
    authorize: vi.fn(() => ({ kind: 'owner' })),
    isOwner: vi.fn(() => true),
    recordRejectedCardAction: vi.fn(),
  };
  const sessionStore = {
    getCwd: vi.fn(() => '/tmp/ws'),
    setCwd: vi.fn(),
  };
  const workspaceStore = { list: vi.fn(() => []) };
  const cloneSession = {
    isActive: vi.fn(() => opts.cloneActive ?? false),
    handleMessage: vi.fn(async () => {}),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  setupMessageHandlers({
    connector,
    router,
    bridge,
    sessionStore,
    workspaceStore,
    binder,
    logger,
    config: { defaultAgent: 'claude' },
    cloneSession,
  } as never);

  return {
    handlers,
    order,
    connector,
    router,
    bridge,
    binder,
    sessionStore,
    cloneSession,
    logger,
  };
}

const message = (content: string, messageId = 'm1'): Message => ({
  userId: 'u1',
  chatId: 'c1',
  messageId,
  rawContentType: 'text',
  content,
});

const cardAction = (cmd: string): CardAction => ({
  operator: { openId: 'u1' },
  chatId: 'c1',
  messageId: 'card-m1',
  action: { value: { cmd } },
});

describe('setupMessageHandlers', () => {
  it('flushes an earlier text turn before dispatching a command', async () => {
    const h = makeHarness();

    h.handlers.message?.(message('hello', 'm1'));
    h.handlers.message?.(message('$help', 'm2'));

    await vi.waitFor(() =>
      expect(h.router.handle).toHaveBeenCalledWith(
        '/help',
        expect.objectContaining({ messageId: 'm2' }),
        { allowCommandPrefix: true },
      ),
    );
    expect(h.order).toEqual(['enqueue:text', 'handle:hello', 'handle:/help']);
  });

  it('routes clone-active input before alias expansion or agent dispatch', async () => {
    const h = makeHarness({ cloneActive: true });

    h.handlers.message?.(message('$help'));

    expect(h.cloneSession.handleMessage).toHaveBeenCalledWith(
      '$help',
      expect.objectContaining({ userId: 'u1', chatId: 'c1', messageId: 'm1' }),
    );
    expect(h.router.expandAliasMessage).not.toHaveBeenCalled();
    expect(h.router.handle).not.toHaveBeenCalled();
  });

  it('returns direct card actions synchronously instead of queueing them', async () => {
    const h = makeHarness();

    const response = await h.handlers.card?.(cardAction('approval.respond'));

    expect(response).toEqual({ toast: { type: 'error', content: 'action failed' } });
    expect(h.router.handleCardAction).toHaveBeenCalledTimes(1);
    expect(h.bridge.enqueue).not.toHaveBeenCalled();
    expect(h.bridge.enqueueImmediate).not.toHaveBeenCalled();
  });

  it('queues non-direct card actions under a unique task key and forwards feedback', async () => {
    const h = makeHarness();

    await h.handlers.card?.(cardAction('unknown.action'));

    await vi.waitFor(() =>
      expect(h.bridge.sendResult).toHaveBeenCalledWith(
        { text: 'action failed' },
        { userId: 'u1', chatId: 'c1', messageId: 'card-m1' },
      ),
    );
    expect(h.bridge.enqueue).toHaveBeenCalledWith(
      '/tmp/ws',
      expect.any(Function),
      expect.objectContaining({
        taskMeta: expect.objectContaining({
          messageId: 'card:unknown.action:1',
          feishuReplyTo: 'card-m1',
        }),
      }),
    );
    expect(h.bridge.enqueue).not.toHaveBeenCalledWith(
      '/tmp/ws',
      expect.any(Function),
      expect.objectContaining({
        taskMeta: expect.objectContaining({ messageId: 'card-m1' }),
      }),
    );
  });

  it('flushes pending text before a session-mutating card action', async () => {
    const h = makeHarness();

    h.handlers.message?.(message('old workspace message', 'm1'));
    await h.handlers.card?.(cardAction('config.save'));

    expect(h.order).toEqual(['enqueue:text', 'handle:old workspace message', 'card:config.save']);
    expect(h.router.handleCardAction).toHaveBeenCalledTimes(1);
  });

  it('rejects non-owner media before download', () => {
    const h = makeHarness();
    h.binder.authorize.mockReturnValue({ kind: 'rejected' });

    h.handlers.media?.(message(''));

    expect(h.connector.downloadInboundMedia).not.toHaveBeenCalled();
  });
});
