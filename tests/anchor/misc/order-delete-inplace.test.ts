import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrderStore } from '../../../src/order/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentEvent, Runner } from '../../../src/runner/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
let tmpDir: string;
let ordersFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-delete-test-'));
  ordersFile = path.join(tmpDir, 'orders.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Stubs ---
function createRouter(overrides?: {
  runner?: Runner;
  sessionStore?: SessionStore;
  ordersPath?: string;
}) {
  const sessionStore = overrides?.sessionStore ?? new SessionStore();
  const connector = createStubConnector();
  const runner: Runner = overrides?.runner ?? createStubRunner({ mode: 'streaming' });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      effort: 'medium',
      stopGraceMs: 5000,
    },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });

  const ordersPath = overrides?.ordersPath ?? ordersFile;

  const bridge = new Bridge({
    runner,
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
    sessionReaderRegistry: new SessionReaderRegistry(),
  });

  return { router, sessionStore, connector, bridge, ordersPath };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Anchor: order.delete updates card in place', () => {
  it('test_anchor_order_delete_updates_card_in_place', async () => {
    // Setup: save two orders
    const orderStore = new OrderStore(ordersFile);
    const order1 = orderStore.save('first order');
    orderStore.save('second order');

    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    // Act: delete order1 via card action
    const response = await router.handleCardAction(
      { cmd: 'order.delete', orderId: order1.id } as { cmd: string; orderId: string },
      ctx,
    );

    // Assert 1: card was updated IN PLACE via updateCard (connector._cards),
    //   NOT by sending a new card via sendWithRetry (connector._sent).
    //   The updated card should reflect the remaining order.
    const updatedCards = connector._cards;
    expect(updatedCards.length).toBeGreaterThanOrEqual(1);

    // The last card update should be the refreshed /order list
    const lastCard = updatedCards[updatedCards.length - 1] as { body?: { elements?: unknown[] } };
    const cardStr = JSON.stringify(lastCard);
    // Deleted order should NOT appear
    expect(cardStr).not.toContain('first order');
    // Remaining order should still appear
    expect(cardStr).toContain('second order');

    // Assert 2: NO new message was sent via sendWithRetry for the refreshed card.
    //   The old code did: sendResult({text:'✅ 已删除指令'}) + sendResult(cardResult)
    //   The new code should use updateCardInPlace instead.
    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string }).text ?? '')
      .filter(Boolean);
    // Should NOT have sent "✅ 已删除指令" as a separate message
    expect(sentTexts).not.toContain('✅ 已删除指令');

    // Assert 3: the response should return a toast (immediate feedback)
    expect(response).toBeDefined();
    const resp = response as { toast?: { type: string; content: string } };
    expect(resp.toast).toBeDefined();
    expect(resp.toast!.type).toBe('success');
  });
});
