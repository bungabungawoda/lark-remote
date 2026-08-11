import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import type { Runner } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
/**
 * Anchor: /ls 卡片分页功能
 *
 * 验证 /ls 卡片在目录条目超过 PAGE_SIZE=30 时显示分页导航栏，
 * 包含"上一页"/"下一页"按钮和页码指示器。
 *
 * 缺失/错误影响：当目录包含大量条目（如 node_modules）时，
 * 卡片被飞书截断，用户无法浏览完整目录内容。
 *
 * 依据：用户需求 - "当前状态：/ls提示截断，这个卡片需要特殊处理，要支持翻页"
 */

// Stub connector that records sent messages (matching router.test.ts pattern)
function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const cards: object[] = [];
  return {
    _sent: sent,
    _cards: cards,
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
    updateCard: async (_messageId: string, card: unknown) => {
      cards.push(card as object);
    },
    start: async () => {},
    stop: async () => {},
  };
}

// Stub runner
function createStubRunner() {
  return {
    run: async function* () {},
    stop: async () => {},
    isRunning: false,
    killOrphan: () => {},
    registerExitHandlers: () => {},
  } as Runner;
}

// Create router with deps
function createRouter(tmpDir: string) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner = createStubRunner();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      stopGraceMs: 5000,
    },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
    agents: {
      claude: { model: 'claude-opus-4-8' },
      codex: {},
      opencode: {},
      pi: {},
    },
  });
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
    ordersPath: path.join(tmpDir, 'orders.json'),
    sessionReaderRegistry: new SessionReaderRegistry(),
  });
  return { router, sessionStore, connector, config, bridge };
}

/** cmdLs 是 CommandRouter 私有方法；测试直接调用验证分页边界（运行时可达）。 */
function cmdLsOf(router: CommandRouter) {
  const internals = router as unknown as {
    cmdLs(
      pathArgs: string[],
      ctx: { userId: string; chatId: string; messageId: string },
      offset?: number,
    ): { card?: object };
  };
  return internals.cmdLs.bind(router);
}

describe('/ls pagination anchor tests', () => {
  const tmpDir = path.join(os.tmpdir(), `ls-pagination-anchor-${Date.now()}`);
  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_ls_no_pagination_bar_when_30_or_fewer_items', async () => {
    const { router, sessionStore, connector } = createRouter(tmpDir);
    // Create exactly 30 items (15 dirs + 15 files) - should NOT show pagination
    for (let i = 0; i < 15; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${i}`));
    }
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'content');
    }
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);

    // Should NOT contain pagination when <= 30 items
    expect(cardStr).not.toContain('上一页');
    expect(cardStr).not.toContain('下一页');
    expect(cardStr).not.toContain('第 1/1 页');
    expect(cardStr).not.toContain('ls.page');
  });

  it('test_anchor_ls_pagination_bar_shown_when_more_than_30_items', async () => {
    const { router, sessionStore, connector } = createRouter(tmpDir);
    // Create 35 items (> 30) - should show pagination
    for (let i = 0; i < 20; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${i}`));
    }
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'content');
    }
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);

    // Should contain pagination bar when > 30 items
    // Page 1: only shows "下一页" (no previous page)
    expect(cardStr).not.toContain('上一页');
    expect(cardStr).toContain('下一页');
    expect(cardStr).toContain('ls.page');
  });

  it('test_anchor_ls_pagination_shows_correct_page_info', async () => {
    const { router, sessionStore, connector } = createRouter(tmpDir);
    // Create 35 items - should show page 1/2
    for (let i = 0; i < 20; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${i}`));
    }
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'content');
    }
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);

    // Should show page 1/2 for 35 items
    expect(cardStr).toContain('第 1/2 页');
    expect(cardStr).toContain('共 35 项');
  });

  it('test_anchor_ls_page_callback_command_is_ls_page', async () => {
    const { router, sessionStore, connector } = createRouter(tmpDir);
    // Create 35 items to trigger pagination
    for (let i = 0; i < 20; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${i}`));
    }
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'content');
    }
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);

    // The pagination buttons should use ls.page command
    expect(cardStr).toContain('"cmd":"ls.page"');
    // Should have offset in the callback value
    expect(cardStr).toContain('offset');
  });

  it('test_anchor_ls_page_2_shows_previous_button', async () => {
    const { router, sessionStore } = createRouter(tmpDir);
    // Create 35 items (> 30) - should show pagination
    for (let i = 0; i < 20; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${i}`));
    }
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'content');
    }
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    // Simulate page 2 by calling cmdLs directly with offset=30
    const page2Card = cmdLsOf(router)([fs.realpathSync(tmpDir)], ctx, 30);
    const cardStr = JSON.stringify(page2Card.card);

    // Page 2: should show "上一页" button
    expect(cardStr).toContain('上一页');
    // Should NOT show "下一页" on last page
    expect(cardStr).not.toContain('下一页');
    // Should show page 2/2
    expect(cardStr).toContain('第 2/2 页');
  });

  it('test_anchor_ls_browse_resets_to_page_0', async () => {
    const { router, sessionStore } = createRouter(tmpDir);
    // Create 35 items
    for (let i = 0; i < 20; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${i}`));
    }
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'content');
    }
    // Create a subdirectory for browsing test
    const subDir = path.join(tmpDir, 'subdir_for_test');
    fs.mkdirSync(subDir);
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    // First, get page 2 card (offset=30)
    const page2Card = cmdLsOf(router)([fs.realpathSync(tmpDir)], ctx, 30);
    expect(JSON.stringify(page2Card.card)).toContain('第 2/2 页');

    // Then browse into a subdirectory - page should reset to 0
    const subdirCard = cmdLsOf(router)([subDir], ctx, 0);
    const cardStr = JSON.stringify(subdirCard.card);

    // Should show page 1/1 (no pagination since subdir is empty)
    expect(cardStr).not.toContain('上一页');
    expect(cardStr).not.toContain('下一页');
  });
});
