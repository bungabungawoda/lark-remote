import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { AppConfigSchema, type AppConfig } from '../../src/config/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
} from './bridge-stubs.js';

export interface TwoTaskQueueScenario {
  /** 拦截到的 updateCard 调用（task 状态卡 PATCH）。 */
  updateCardCalls: Array<{ messageId: string; card: object }>;
  /** 初始排队卡（header orange + 标题含「排队」）。 */
  initialCards: Array<{ chatId: string; input: unknown; opts?: unknown }>;
  /** 释放 task1，让队列前进到 task2。 */
  release1: () => void;
  /** 恢复 connector.updateCard 原实现（测试收尾用）。 */
  restoreUpdateCard: () => void;
}

/**
 * 搭建「task1 挂起 + task2 排队」的双任务场景，并拦截 updateCard 调用。
 *
 * queue-message-edit / bridge-queue-card 两个测试此前复制了同一份 ~60 行
 * setup（DRY），收敛到这里；各自只保留后半段断言。
 */
export async function setupTwoTaskQueueScenario(
  bridge: Bridge,
  connector: ReturnType<typeof createStubConnector>,
  workspace: string,
  opts: {
    secondMessagePreview?: string;
    firstMessageId?: string;
    firstMessagePreview?: string;
    secondMessageId?: string;
    /** 拦截 updateCard 记录调用（需要断言 PATCH 卡的用例开；默认开）。 */
    interceptUpdateCard?: boolean;
  } = {},
): Promise<TwoTaskQueueScenario> {
  const updateCardCalls: Array<{ messageId: string; card: object }> = [];
  const originalUpdateCard = connector.updateCard;
  if (opts.interceptUpdateCard !== false) {
    connector.updateCard = async (messageId: string, card: object) => {
      updateCardCalls.push({ messageId, card });
      connector._cards.push(card);
    };
  }

  let release1: () => void = () => {};
  const hang1 = new Promise<void>((resolve) => {
    release1 = resolve;
  });

  // Task 1: starts immediately, blocks
  bridge.enqueue(
    workspace,
    async () => {
      await hang1;
    },
    {
      taskMeta: {
        userId: 'u1',
        chatId: 'c1',
        messageId: opts.firstMessageId ?? 'msg-1',
        messagePreview: opts.firstMessagePreview ?? 'long task',
      },
    },
  );

  // Give task1 time to start
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Task 2: queued behind task 1 (taskList.length > 1 triggers queue card)
  bridge.enqueue(workspace, async () => {}, {
    taskMeta: {
      userId: 'u1',
      chatId: 'c1',
      messageId: opts.secondMessageId ?? 'msg-2',
      messagePreview: opts.secondMessagePreview ?? 'original message content',
    },
  });

  // Wait for queue card to be sent
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify initial queue card was sent (header: orange, title: "排队中")
  // FIXED: Use header.title?.content instead of String(header?.title)
  const initialCards = connector._sent.filter((s: { input: unknown }) => {
    const inp = s.input as Record<string, unknown>;
    const card = inp.card as Record<string, unknown> | undefined;
    if (!card) return false;
    const header = card.header as Record<string, unknown> | undefined;
    const titleContent = (header?.title as { content?: string } | undefined)?.content;
    return header?.template === 'orange' && (titleContent?.includes('排队') ?? false);
  });

  return {
    updateCardCalls,
    initialCards,
    release1,
    restoreUpdateCard: () => {
      if (opts.interceptUpdateCard !== false) {
        connector.updateCard = originalUpdateCard;
      }
    },
  };
}

// ===========================================================================
// W3.3：queue 测试共享接线（原先 6 个文件各持 ~54 行 header + 每 it ~20 行
// Bridge/Router 接线；queue-message-edit 已验证共享路径可行）。
// 注意：vi.mock('<相对路径>/logger/index.js') 必须留在每个测试文件内
// （vitest 按文件 hoist），这里只共享工厂体之外的纯接线。
// ===========================================================================

export interface QueueTestContext {
  tmpDir: string;
  config: AppConfig;
  sessionStore: SessionStore;
  connector: ReturnType<typeof createStubConnector>;
  bridge: Bridge;
  router: CommandRouter;
}

/** 一把梭：tmpDir + config + stub connector/runner + Bridge + Router 接线。 */
export function makeQueueTestContext(): QueueTestContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-test-'));
  const config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    workspace: { default: '' },
  });
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner = createStubRunner();
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
    sessionReaderRegistry: new SessionReaderRegistry(),
  });
  return { tmpDir, config, sessionStore, connector, bridge, router };
}

/** 测试收尾：清理 tmpDir（beforeEach/afterEach 配对使用）。 */
export function cleanupQueueTestContext(ctx: QueueTestContext): void {
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}
