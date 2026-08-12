import { createMockBridge } from '../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrderStore } from '../../src/order/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import type { _Bridge } from '../../src/bridge/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

let tmpDir: string;
let ordersFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-test-'));
  ordersFile = path.join(tmpDir, 'orders.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OrderStore basic CRUD', () => {
  it('save / get / has / remove (global, no cwd)', () => {
    const store = new OrderStore(ordersFile);

    // save returns an OrderEntry with id, text, createdAt
    const entry = store.save('检查测试覆盖率');
    expect(entry).toMatchObject({ text: '检查测试覆盖率' });
    expect(entry.id).toBeDefined();
    expect(entry.createdAt).toBeDefined();

    // get returns all entries (global, no cwd filter)
    const entries = store.get();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entry.id);
    expect(entries[0].text).toBe('检查测试覆盖率');

    // has checks by id only (no cwd)
    expect(store.has(entry.id)).toBe(true);
    expect(store.has('nonexistent')).toBe(false);

    // remove by id only (no cwd)
    store.remove(entry.id);
    expect(store.get()).toHaveLength(0);
    expect(store.has(entry.id)).toBe(false);
  });
});

/**
 * Anchor #2: cmdOrder 列表命令
 * 验证 /order 命令返回卡片格式，包含指令列表。
 * 边界情况：
 * 1. 无 cwd 时返回"请先 /cd"
 * 2. 空列表返回提示文本
 * 3. 有列表时返回 card 格式
 */

// --- Stubs ---

function createBlockingRunner(): Runner & { unblock: () => void } {
  let unblock: () => void = () => {};
  const blockPromise = new Promise<void>((r) => {
    unblock = r;
  });
  const runner: Runner & { unblock: () => void } = {
    isRunning: false,
    stop: async () => {
      unblock();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      yield {
        type: 'system' as const,
        subtype: 'init' as const,
        session_id: 's-block',
        cwd: '/tmp',
        model: 'opus',
      };
      await blockPromise;
    },
    unblock,
  };
  return runner;
}

describe('cmdOrder 列表命令 (Anchor #2)', () => {
  let config: AppConfig;

  beforeEach(() => {
    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      workspace: { default: '' },
      output: {
        showThinking: true,
        showToolUse: false,
        showToolResult: false,
      },
    });
  });

  it('无 cwd 时仍返回 CardKit 2.0 卡片（order 全局存储，不再依赖 cwd）', async () => {
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });
    // No cwd set for this user - order 现在全局存储，不需要 cwd

    const result = await router.handle('/order', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    // Should return 2.0 card (no longer require /cd)
    expect(result).toBeDefined();
    const r = Array.isArray(result) ? result[0] : result;
    expect(r.card).toBeDefined();
    const card = r.card as { schema?: string };
    expect(card.schema).toBe('2.0');
  });

  it('/order 卡片不混用 V1/V2 — 无 1.x action 容器 (regression: 200861)', async () => {
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: ordersFile,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });
    // Save at least one order so list-tab has content
    new OrderStore(ordersFile).save('regression probe');

    const result = await router.handle('/order', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });
    const r = Array.isArray(result) ? result[0] : result;
    const cardStr = JSON.stringify(r.card);
    expect(cardStr).toContain('"schema":"2.0"');
    // 2.0 cards MUST NOT mix in 1.x `tag:"action"` containers (200861 root cause).
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    // order callbacks use 2.0 behaviors
    expect(cardStr).toContain('"cmd":"order.');
  });

  it('空列表返回 CardKit 2.0 卡片（显示"暂无指令"）', async () => {
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: ordersFile,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    // No orders saved - but still returns 2.0 card
    const result = await router.handle('/order', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    expect(result).toBeDefined();
    const r = Array.isArray(result) ? result[0] : result;
    // Should return 2.0 card with empty state message
    expect(r.card).toBeDefined();
    const card = r.card as { schema?: string };
    expect(card.schema).toBe('2.0');
  });

  it('有列表时返回 card 格式', async () => {
    const sessionStore = new SessionStore();
    const runner = createBlockingRunner();
    const bridge = createMockBridge();

    // Set cwd and save some orders BEFORE creating router (real usage pattern)
    sessionStore.setCwd('user1', tmpDir);
    const orderStore = new OrderStore(ordersFile);
    orderStore.save('运行单元测试');
    orderStore.save('检查代码覆盖率');

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: ordersFile,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const result = await router.handle('/order', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    expect(result).toBeDefined();
    const r = Array.isArray(result) ? result[0] : result;
    // Should return card format
    expect(r.card).toBeDefined();
    // Card should contain the order texts
    const cardStr = JSON.stringify(r.card);
    expect(cardStr).toContain('运行单元测试');
    expect(cardStr).toContain('检查代码覆盖率');

    runner.unblock();
  });
});

// --- Probe tests: boundary & risk exploration ---

describe('OrderStore probe: boundary & risk', () => {
  it('probe-1: 空指令保存 - empty text', () => {
    const store = new OrderStore(ordersFile);

    // Empty string (length 0) is under MAX_TEXT_LENGTH=200,
    // so save() should NOT throw — but is this the intended behavior?
    // Probe: document what actually happens.
    const entry = store.save('');
    expect(entry.text).toBe('');
    expect(store.get()).toHaveLength(1);

    // Whitespace-only text also passes length check
    const entry2 = store.save('   ');
    expect(entry2.text).toBe('   ');
    expect(store.get()).toHaveLength(2);
  });

  it('probe-2: 超长指令 - 201 chars exceeds limit', () => {
    const store = new OrderStore(ordersFile);

    // Exactly 200 chars should pass
    const text200 = 'A'.repeat(200);
    const entry = store.save(text200);
    expect(entry.text).toHaveLength(200);

    // 201 chars should throw
    const text201 = 'A'.repeat(201);
    expect(() => store.save(text201)).toThrow(/200/);
  });

  it('probe-3: 指令数量上限 - 51st order rejected', () => {
    const store = new OrderStore(ordersFile);

    // Fill up to 50
    for (let i = 0; i < 50; i++) {
      store.save(`指令 ${i + 1}`);
    }
    expect(store.get()).toHaveLength(50);

    // 51st should throw
    expect(() => store.save('第 51 条')).toThrow(/50/);
  });

  it('probe-4: 全局存储 - all orders visible (no cwd isolation)', () => {
    const store = new OrderStore(ordersFile);

    store.save('A 的指令');
    store.save('B 的指令');

    expect(store.get()).toHaveLength(2);
    const texts = store.get().map((e) => e.text);
    expect(texts).toContain('A 的指令');
    expect(texts).toContain('B 的指令');
  });

  it('probe-5: 删除不存在的指令 - idempotent remove', () => {
    const store = new OrderStore(ordersFile);

    // Remove from empty store — should not throw
    expect(() => store.remove('nonexistent-id')).not.toThrow();

    // Save then remove twice — second remove is idempotent
    const entry = store.save('待删除');
    store.remove(entry.id);
    expect(store.get()).toHaveLength(0);

    // Second remove of same id — should not throw
    expect(() => store.remove(entry.id)).not.toThrow();
  });
});
