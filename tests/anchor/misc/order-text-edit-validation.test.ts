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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-text-validation-test-'));
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

  return { router, sessionStore, connector };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Anchor: order.textEdit card structure (CardKit 2.0 / 200861)', () => {
  it('test_anchor_order_text_edit_card_no_v1_action_container_200861', async () => {
    const orderStore = new OrderStore(ordersFile);
    const order = orderStore.save('hello');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    await router.handleCardAction(
      { cmd: 'order.textEdit', orderId: order.id, offset: 0 } as {
        cmd: string;
        orderId: string;
        offset: number;
      },
      ctx,
    );

    const lastCard = connector._cards[connector._cards.length - 1];
    const cardStr = JSON.stringify(lastCard);

    // CardKit 2.0 schema
    expect(cardStr).toContain('"schema":"2.0"');
    // 200861 regression — no V1 action container mixed in
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    // input component + behaviors callback
    expect(cardStr).toContain('"tag":"input"');
    expect(cardStr).toContain('"cmd":"order.textInput"');
    // no form container (avoids 200621/300123)
    expect(cardStr).not.toContain('"tag":"form"');
    // wide_screen_mode for input editing UX
    expect(cardStr).toContain('"wide_screen_mode":true');
  });
});

describe('Anchor: order.textInput validation paths', () => {
  it('test_anchor_order_text_input_rejects_empty_text', async () => {
    const orderStore = new OrderStore(ordersFile);
    const order = orderStore.save('hello');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    const cardsBefore = connector._cards.length;

    // submit whitespace-only — must trim to empty → error toast, no card refresh
    const response = await router.handleCardAction(
      {
        cmd: 'order.textInput',
        orderId: order.id,
        offset: 0,
        inputValue: '   ',
      } as { cmd: string; orderId: string; offset: number; inputValue: string },
      ctx,
    );

    const resp = response as { toast?: { type: string; content: string }; card?: object };
    expect(resp.toast?.type).toBe('error');
    expect(resp.toast?.content).toContain('不能为空');
    // no card refresh on failure (no raw card in response)
    expect(resp.card).toBeUndefined();
    // connector must NOT have pushed a refreshed card
    expect(connector._cards.length).toBe(cardsBefore);

    // store must be unchanged
    orderStore.reload();
    expect(orderStore.get()[0].text).toBe('hello');
  });

  it('test_anchor_order_text_input_rejects_overlong_text', async () => {
    const orderStore = new OrderStore(ordersFile);
    const order = orderStore.save('hello');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    const cardsBefore = connector._cards.length;

    const response = await router.handleCardAction(
      {
        cmd: 'order.textInput',
        orderId: order.id,
        offset: 0,
        inputValue: 'A'.repeat(201),
      } as { cmd: string; orderId: string; offset: number; inputValue: string },
      ctx,
    );

    const resp = response as { toast?: { type: string; content: string }; card?: object };
    expect(resp.toast?.type).toBe('error');
    expect(resp.toast?.content).toContain('200');
    expect(resp.card).toBeUndefined();
    expect(connector._cards.length).toBe(cardsBefore);

    orderStore.reload();
    expect(orderStore.get()[0].text).toBe('hello');
  });

  it('preserves usedAt + alias when editing text', async () => {
    const orderStore = new OrderStore(ordersFile);
    const order = orderStore.save('原文本');
    orderStore.setAlias(order.id, 'myalias');
    orderStore.updateUsedAt(order.id);
    const before = orderStore.get()[0];
    const usedAtBefore = before.usedAt;
    expect(usedAtBefore).toBeDefined();
    expect(before.alias).toBe('myalias');

    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    await router.handleCardAction(
      {
        cmd: 'order.textInput',
        orderId: order.id,
        offset: 0,
        inputValue: '新文本',
      } as { cmd: string; orderId: string; offset: number; inputValue: string },
      ctx,
    );

    orderStore.reload();
    const after = orderStore.get()[0];
    expect(after.text).toBe('新文本');
    expect(after.alias).toBe('myalias');
    expect(after.usedAt).toBe(usedAtBefore);
    expect(after.createdAt).toBe(before.createdAt);
  });
});

describe('Anchor: CLI /order edit subcommand', () => {
  it('test_anchor_order_edit_cli_updates_store', async () => {
    const orderStore = new OrderStore(ordersFile);
    const entry = orderStore.save('原文本');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    const result = await router.handle('/order edit 1 新文本', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    const r = Array.isArray(result) ? result[0] : result;
    expect(r.text).toContain('已更新指令');
    expect(r.text).toContain('新文本');

    orderStore.reload();
    expect(orderStore.get()[0].text).toBe('新文本');
    // store id matches
    expect(orderStore.get()[0].id).toBe(entry.id);
  });

  it('CLI /order edit unknown target returns error', async () => {
    const orderStore = new OrderStore(ordersFile);
    orderStore.save('原文本');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);

    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    const result = await router.handle('/order edit 99 不存在', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });
    const r = Array.isArray(result) ? result[0] : result;
    expect(r.text).toContain('指令不存在');
  });

  it('CLI /order edit missing args returns usage', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    const result = await router.handle('/order edit', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });
    const r = Array.isArray(result) ? result[0] : result;
    expect(r.text).toContain('用法');
  });
});
