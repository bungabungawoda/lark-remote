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
import type { Runner } from '../../../src/runner/index.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-text-edit-test-'));
  ordersFile = path.join(tmpDir, 'orders.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter(overrides?: { runner?: Runner; sessionStore?: SessionStore }) {
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
    ordersPath: ordersFile,
    exitHandler: () => {},
    sessionReaderRegistry: new SessionReaderRegistry(),
  });

  return { router, sessionStore, connector, bridge };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Anchor: order.textEdit opens input card in place', () => {
  it('test_anchor_order_text_edit_opens_input_card_in_place', async () => {
    const orderStore = new OrderStore(ordersFile);
    const order = orderStore.save('原文本');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    const response = await router.handleCardAction(
      { cmd: 'order.textEdit', orderId: order.id, offset: 0 } as {
        cmd: string;
        orderId: string;
        offset: number;
      },
      ctx,
    );

    // assert: edit card was pushed via updateCardInPlace (connector._cards)
    const updatedCards = connector._cards;
    expect(updatedCards.length).toBeGreaterThanOrEqual(1);
    const lastCard = updatedCards[updatedCards.length - 1] as {
      schema?: string;
      header?: { title?: { content?: string } };
      body?: { elements?: object[] };
    };
    const cardStr = JSON.stringify(lastCard);

    // CardKit 2.0 schema
    expect(cardStr).toContain('"schema":"2.0"');
    // 200861 — no V1 action container
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    // header title shows edit intent
    expect(lastCard.header?.title?.content).toContain('编辑指令');
    // input component pre-filled with full current text (not truncated)
    expect(cardStr).toContain('"default_value":"原文本"');
    // input name + behaviors callback cmd
    expect(cardStr).toContain('"name":"text"');
    expect(cardStr).toContain('"cmd":"order.textInput"');
    // handleOrderTextEdit returns void (no toast — the edit card itself is the affordance)
    expect(response).toBeUndefined();
  });
});

describe('Anchor: order.textInput updates card in place', () => {
  it('test_anchor_order_text_input_updates_card_in_place', async () => {
    const orderStore = new OrderStore(ordersFile);
    const order = orderStore.save('原文本');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    // simulate CardKit 2.0 input submit (input_value 经 raw 回传)
    const response = await router.handleCardAction(
      {
        cmd: 'order.textInput',
        orderId: order.id,
        offset: 0,
        inputValue: '更新后文本',
      } as { cmd: string; orderId: string; offset: number; inputValue: string },
      ctx,
    );

    // assert 1: callback response carries raw refreshed list card so Feishu replaces
    // pre-click edit card in place (mirrors handleOrderAliasInput semantics).
    // connector stub does NOT push response.card into _cards; only updateCardInPlace does.
    expect(response).toBeDefined();
    const resp = response as {
      toast?: { type: string; content: string };
      card?: { type?: string; data?: { body?: { elements?: object[] } } };
    };
    expect(resp.toast?.type).toBe('success');
    expect(resp.toast?.content).toContain('已更新指令');
    expect(resp.card?.type).toBe('raw');
    const refreshedCardStr = JSON.stringify(resp.card?.data);
    expect(refreshedCardStr).toContain('更新后文本');
    expect(refreshedCardStr).not.toContain('原文本');
    // 200861 / schema sanity on the refreshed list card
    expect(refreshedCardStr).toContain('"schema":"2.0"');
    expect(refreshedCardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    // assert 2: store actually persisted new text
    orderStore.reload();
    expect(orderStore.get()[0].text).toBe('更新后文本');
  });
});
