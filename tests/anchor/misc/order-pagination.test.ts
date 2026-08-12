import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrderStore } from '../../../src/order/index.js';
import { CommandRouter, isImmediateAction } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
  createStubConnector,
} from '../../lib/bridge-stubs.js';

let tmpDir: string;
let ordersFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-pagination-test-'));
  ordersFile = path.join(tmpDir, 'orders.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter(overrides?: { ordersPath?: string }) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner = createStubRunner({ mode: 'empty' });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
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
    sessionReaderRegistry: new SessionReaderRegistry(),
  });

  return { router, connector, bridge };
}

/** Access private cmdOrder method for unit testing pagination logic. */
function cmdOrderOf(router: CommandRouter) {
  const internals = router as unknown as {
    cmdOrder(
      args: string[],
      ctx: { userId: string; chatId: string; messageId: string },
      offset?: number,
    ): { card?: object };
  };
  return internals.cmdOrder.bind(router);
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('/order pagination anchor tests', () => {
  it('test_anchor_order_no_pagination_bar_when_20_or_fewer_items', async () => {
    const orderStore = new OrderStore(ordersFile);
    // Exactly 20 items — should NOT show pagination
    for (let i = 0; i < 20; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router } = createRouter();
    const result = await router.handle('/order', ctx);
    const r = Array.isArray(result) ? result[0] : result;
    const cardStr = JSON.stringify(r.card);

    expect(cardStr).not.toContain('上一页');
    expect(cardStr).not.toContain('下一页');
    expect(cardStr).not.toContain('order.page');
  });

  it('test_anchor_order_pagination_bar_shown_when_more_than_20_items', async () => {
    const orderStore = new OrderStore(ordersFile);
    // 25 items (> 20) — should show pagination
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router } = createRouter();
    const result = await router.handle('/order', ctx);
    const r = Array.isArray(result) ? result[0] : result;
    const cardStr = JSON.stringify(r.card);

    // Page 1: "下一页" shown, "上一页" not shown
    expect(cardStr).not.toContain('上一页');
    expect(cardStr).toContain('下一页');
    expect(cardStr).toContain('order.page');
  });

  it('test_anchor_order_pagination_shows_correct_page_info', async () => {
    const orderStore = new OrderStore(ordersFile);
    // 25 items → 2 pages (20 + 5)
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router } = createRouter();
    const result = await router.handle('/order', ctx);
    const r = Array.isArray(result) ? result[0] : result;
    const cardStr = JSON.stringify(r.card);

    // Should show page 1/2, total 25
    expect(cardStr).toContain('第 1/2 页');
    expect(cardStr).toContain('共 25 条');
  });

  it('test_anchor_order_page_2_shows_previous_button', () => {
    const orderStore = new OrderStore(ordersFile);
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router } = createRouter();
    // Simulate page 2 by calling cmdOrder with offset=20
    const page2Result = cmdOrderOf(router)([], ctx, 20);
    const cardStr = JSON.stringify(page2Result.card);

    // Page 2: "上一页" shown, "下一页" not shown (last page)
    expect(cardStr).toContain('上一页');
    expect(cardStr).not.toContain('下一页');
    expect(cardStr).toContain('第 2/2 页');
  });

  it('test_anchor_order_empty_list_no_pagination', async () => {
    // No orders saved
    const { router } = createRouter();
    const result = await router.handle('/order', ctx);
    const r = Array.isArray(result) ? result[0] : result;
    const cardStr = JSON.stringify(r.card);

    expect(cardStr).toContain('暂无指令');
    expect(cardStr).not.toContain('上一页');
    expect(cardStr).not.toContain('下一页');
    expect(cardStr).not.toContain('order.page');
  });

  it('test_anchor_order_page_is_immediate_action', () => {
    // order.page should be recognized as immediate action (bypasses queue)
    expect(isImmediateAction('order.page')).toBe(true);
  });

  it('test_anchor_order_page_callback_updates_card_in_place', async () => {
    const orderStore = new OrderStore(ordersFile);
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router, connector } = createRouter();
    // Simulate order.page card action
    const response = await router.handleCardAction(
      { cmd: 'order.page', offset: 20 } as { cmd: string; offset: number },
      ctx,
    );

    // Should update card in place (connector._cards), not send a new message
    const updatedCards = connector._cards;
    expect(updatedCards.length).toBeGreaterThanOrEqual(1);
    const lastCard = updatedCards[updatedCards.length - 1] as { body?: { elements?: unknown[] } };
    const cardStr = JSON.stringify(lastCard);
    // Page 2 content
    expect(cardStr).toContain('第 2/2 页');

    // Should return a toast (immediate feedback)
    expect(response).toBeDefined();
    const resp = response as { toast?: { type: string; content: string } };
    expect(resp.toast).toBeDefined();
    expect(resp.toast!.type).toBe('success');
  });

  it('test_anchor_order_pagination_no_v1_action_container_regression_200861', async () => {
    const orderStore = new OrderStore(ordersFile);
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router } = createRouter();
    const result = await router.handle('/order', ctx);
    const r = Array.isArray(result) ? result[0] : result;
    const cardStr = JSON.stringify(r.card);

    // 2.0 cards MUST NOT mix in 1.x `tag:"action"` containers (200861)
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    expect(cardStr).toContain('"schema":"2.0"');
  });

  it('test_anchor_order_page_only_shows_items_on_current_page', () => {
    const orderStore = new OrderStore(ordersFile);
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router } = createRouter();
    // Page 1 (offset=0): should show items 1-20, NOT items 21-25
    const page1 = cmdOrderOf(router)([], ctx, 0);
    const page1Str = JSON.stringify(page1.card);
    expect(page1Str).toContain('指令 1');
    expect(page1Str).toContain('指令 20');
    expect(page1Str).not.toContain('指令 21');

    // Page 2 (offset=20): should show items 21-25, NOT items 1-20
    const page2 = cmdOrderOf(router)([], ctx, 20);
    const page2Str = JSON.stringify(page2.card);
    expect(page2Str).toContain('指令 21');
    expect(page2Str).toContain('指令 25');
    expect(page2Str).not.toContain('指令 1');
  });

  it('test_anchor_order_delete_on_paginated_page_preserves_current_page', async () => {
    const orderStore = new OrderStore(ordersFile);
    for (let i = 0; i < 25; i++) {
      orderStore.save(`指令 ${i + 1}`);
    }

    const { router, connector } = createRouter();
    // Delete an item on page 2 (offset=20)
    const allOrders = orderStore.get();
    const order21 = allOrders[20]; // item 21 (0-indexed)

    const response = await router.handleCardAction(
      { cmd: 'order.delete', orderId: order21.id, offset: 20 } as {
        cmd: string;
        orderId: string;
        offset: number;
      },
      ctx,
    );

    // Card should be updated in place
    const updatedCards = connector._cards;
    expect(updatedCards.length).toBeGreaterThanOrEqual(1);
    const lastCard = updatedCards[updatedCards.length - 1];
    const cardStr = JSON.stringify(lastCard);
    expect(cardStr).not.toContain('指令 21');
    // Total should now be 24
    expect(cardStr).toContain('共 24 条');
    // Should stay on page 2 (offset=20 preserved after delete)
    expect(cardStr).toContain('第 2/2 页');

    // Toast response
    expect(response).toBeDefined();
    const resp = response as { toast?: { type: string } };
    expect(resp.toast?.type).toBe('success');
  });
});
