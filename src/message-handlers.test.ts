import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
    currentBinding: vi.fn((): unknown => undefined),
    enqueue: vi.fn((_cwd: string, task: () => Promise<void>, _opts?: unknown) => {
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
  const workspaceStore = {
    list: vi.fn((): Array<{ path: string; lastUsedAt: number }> => []),
  };
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
    workspaceStore,
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

/**
 * setupMessageHandlers 各 handler 分支的当前行为（ub 结构等价 characterization）。
 * 拆分时把闭包抽成模块级命名函数，这些可观察行为必须逐字不变。
 */
describe('setupMessageHandlers 分支口径（ub characterization）', () => {
  it('/stop 且无运行中进程 → 回「当前没有运行中的进程」', async () => {
    const h = makeHarness();
    h.handlers.message?.(message('/stop'));
    await vi.waitFor(() =>
      expect(h.bridge.sendResult).toHaveBeenCalledWith(
        { text: '当前没有运行中的进程' },
        { userId: 'u1', chatId: 'c1', messageId: 'm1' },
      ),
    );
    expect(h.bridge.interruptCurrentRunDetailed).toHaveBeenCalledWith({
      userId: 'u1',
      chatId: 'c1',
    });
  });

  it('/t 且停止多个 → 回「已停止 N 个运行中的任务」', async () => {
    const h = makeHarness();
    h.bridge.interruptCurrentRunDetailed.mockResolvedValue({ stopped: true, stoppedCount: 3 });
    h.handlers.message?.(message('/t'));
    await vi.waitFor(() =>
      expect(h.bridge.sendResult).toHaveBeenCalledWith(
        { text: '✅ 已停止 3 个运行中的任务' },
        expect.anything(),
      ),
    );
  });

  it('clone 活跃期 /stop 仍走中断（isStopCommand 排除 clone 拦截）', async () => {
    const h = makeHarness({ cloneActive: true });
    h.handlers.message?.(message('/stop'));
    await vi.waitFor(() => expect(h.bridge.interruptCurrentRunDetailed).toHaveBeenCalled());
    expect(h.cloneSession.handleMessage).not.toHaveBeenCalled();
  });

  it('! 前缀命令 → router.handle(..., allowCommandPrefix:true)', async () => {
    const h = makeHarness();
    h.handlers.message?.(message('!status'));
    await vi.waitFor(() =>
      expect(h.router.handle).toHaveBeenCalledWith(
        '!status',
        expect.objectContaining({ messageId: 'm1' }),
        { allowCommandPrefix: true },
      ),
    );
  });

  it('媒体入口 enabled → 下载 + 保存', async () => {
    const h = makeHarness();
    h.handlers.media?.(message(''));
    expect(h.connector.downloadInboundMedia).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.bridge.saveInboundMedia).toHaveBeenCalled());
  });

  it('媒体入口 disabled → 不下载（ingest rejected）', () => {
    const h = makeHarness();
    h.router.config.inboundMedia.enabled = false;
    h.handlers.media?.(message(''));
    expect(h.connector.downloadInboundMedia).not.toHaveBeenCalled();
  });

  it('非 owner 的卡片动作 → 记录拒绝且不处理', async () => {
    const h = makeHarness();
    h.binder.isOwner.mockReturnValue(false);
    await h.handlers.card?.(cardAction('approval.respond'));
    expect(h.binder.recordRejectedCardAction).toHaveBeenCalledWith('u1');
    expect(h.router.handleCardAction).not.toHaveBeenCalled();
  });

  it('卡片动作无 cmd → 静默返回', async () => {
    const h = makeHarness();
    const noCmd: CardAction = {
      operator: { openId: 'u1' },
      chatId: 'c1',
      messageId: 'card-m1',
      action: { value: {} },
    };
    await h.handlers.card?.(noCmd);
    expect(h.router.handleCardAction).not.toHaveBeenCalled();
    expect(h.bridge.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * 首次 owner 绑定（handleBind）：由 binder.authorize 返回 bind_success 触发，
 * 断言用户实际收到的 onboarding 消息与默认 cwd 的写入，而不是回调次数。
 */
describe('setupMessageHandlers 首次绑定 onboarding', () => {
  it('bind_success writes a default cwd and sends welcome text + help card', async () => {
    const h = makeHarness();
    h.binder.authorize.mockReturnValue({ kind: 'bind_success' });
    h.sessionStore.getCwd.mockReturnValue('');

    h.handlers.message?.(message('你好'));

    await vi.waitFor(() => expect(h.connector.sendWithRetry).toHaveBeenCalledTimes(2));
    expect(h.sessionStore.setCwd).toHaveBeenCalledWith('u1', fs.realpathSync(process.cwd()));
    const welcome = h.connector.sendWithRetry.mock.calls[0][1] as { text: string };
    expect(h.connector.sendWithRetry.mock.calls[0][0]).toBe('c1');
    expect(welcome.text).toContain('已绑定到本账号');
    expect(welcome.text).toContain('当前工作目录');
    expect(welcome.text).toContain('默认 Agent');
    expect(welcome.text).toContain(fs.realpathSync(process.cwd()));
    expect(h.connector.sendWithRetry.mock.calls[1][1]).toEqual({ card: { schema: '2.0' } });
    // 绑定消息本身不转发给 coding agent
    expect(h.router.handle).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing cwd on bind', async () => {
    const h = makeHarness();
    h.binder.authorize.mockReturnValue({ kind: 'bind_success' });

    h.handlers.message?.(message('你好'));

    await vi.waitFor(() => expect(h.connector.sendWithRetry).toHaveBeenCalled());
    expect(h.sessionStore.setCwd).not.toHaveBeenCalled();
  });

  it('sends only the welcome text when no help card is available', async () => {
    const h = makeHarness();
    h.binder.authorize.mockReturnValue({ kind: 'bind_success' });
    h.router.cmdHelp.mockReturnValue({} as never);

    h.handlers.message?.(message('你好'));

    await vi.waitFor(() => expect(h.connector.sendWithRetry).toHaveBeenCalled());
    expect(h.connector.sendWithRetry).toHaveBeenCalledTimes(1);
    expect(h.connector.sendWithRetry.mock.calls[0][1]).toEqual({ text: expect.any(String) });
  });

  it('logs onboarding send failures without breaking inbound handling', async () => {
    const h = makeHarness();
    h.binder.authorize.mockReturnValue({ kind: 'bind_success' });
    h.connector.sendWithRetry.mockRejectedValue(new Error('network down'));

    expect(() => h.handlers.message?.(message('你好'))).not.toThrow();
    await vi.waitFor(() =>
      expect(h.logger.error).toHaveBeenCalledWith(
        '[binder] onboarding send failed:',
        expect.any(Error),
      ),
    );
  });

  it('falls back to process.cwd() when realpath fails', async () => {
    const h = makeHarness();
    h.binder.authorize.mockReturnValue({ kind: 'bind_success' });
    h.sessionStore.getCwd.mockReturnValue('');
    const realRealpath = fs.realpathSync;
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (p === process.cwd()) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return (realRealpath as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.realpathSync);
    try {
      h.handlers.message?.(message('你好'));
      await vi.waitFor(() =>
        expect(h.sessionStore.setCwd).toHaveBeenCalledWith('u1', process.cwd()),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

/** 文本 turn 提交（handleTurnCommit）：cwd 回退、binding 透传、preview 截断。 */
describe('setupMessageHandlers 文本 turn 提交', () => {
  it('uses the most recently used workspace when the user has no cwd', async () => {
    const h = makeHarness();
    h.sessionStore.getCwd.mockReturnValue('');
    h.workspaceStore.list.mockReturnValue([
      { path: '/old', lastUsedAt: 10 },
      { path: '/recent', lastUsedAt: 999 },
      { path: '/mid', lastUsedAt: 50 },
    ]);

    h.handlers.message?.(message('hello', 'm1'));
    h.handlers.message?.(message('$help', 'm2'));

    await vi.waitFor(() =>
      expect(h.bridge.enqueue).toHaveBeenCalledWith(
        '/recent',
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it('threads the current binding into the queued task and router.handle', async () => {
    const h = makeHarness();
    const binding = { runId: 'run-1', sessionId: 'sess-1' };
    h.bridge.currentBinding.mockReturnValue(binding);

    h.handlers.message?.(message('hello', 'm1'));
    h.handlers.message?.(message('$help', 'm2'));

    await vi.waitFor(() =>
      expect(h.bridge.enqueue).toHaveBeenCalledWith(
        '/tmp/ws',
        expect.any(Function),
        expect.objectContaining({ taskMeta: expect.objectContaining({ binding }) }),
      ),
    );
    await vi.waitFor(() =>
      expect(h.router.handle).toHaveBeenCalledWith(
        'hello',
        expect.objectContaining({ userId: 'u1', chatId: 'c1', messageId: 'm1' }),
        { cwdOverride: '/tmp/ws', binding, allowCommandPrefix: false },
      ),
    );
  });

  it('truncates the queued task preview to 3000 characters', async () => {
    const h = makeHarness();
    h.handlers.message?.(message('x'.repeat(4000), 'm1'));
    h.handlers.message?.(message('$help', 'm2'));

    await vi.waitFor(() => {
      const calls = h.bridge.enqueue.mock.calls as unknown as Array<
        [string, () => Promise<void>, { taskMeta?: { messagePreview?: string } }]
      >;
      expect(calls.some((c) => c[2]?.taskMeta?.messagePreview?.length === 3000)).toBe(true);
    });
  });
});
