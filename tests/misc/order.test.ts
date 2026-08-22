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

// --- Boundary tests: length/quantity limits (OrderStore MAX_TEXT_LENGTH=200 / MAX_ORDERS=50) ---

describe('OrderStore boundary limits', () => {
  it('超长指令 - 201 chars exceeds MAX_TEXT_LENGTH', () => {
    const store = new OrderStore(ordersFile);

    // Exactly 200 chars should pass
    const text200 = 'A'.repeat(200);
    const entry = store.save(text200);
    expect(entry.text).toHaveLength(200);

    // 201 chars should throw
    const text201 = 'A'.repeat(201);
    expect(() => store.save(text201)).toThrow(/200/);
  });

  it('指令数量上限 - 51st order rejected (MAX_ORDERS=50)', () => {
    const store = new OrderStore(ordersFile);

    // Fill up to 50
    for (let i = 0; i < 50; i++) {
      store.save(`指令 ${i + 1}`);
    }
    expect(store.get()).toHaveLength(50);

    // 51st should throw
    expect(() => store.save('第 51 条')).toThrow(/50/);
  });
});

// --- updateText: edit-command-text support ---

describe('OrderStore.updateText', () => {
  it('正常修改文本 - 返回 entry 且磁盘持久化', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    const updated = store.updateText(entry.id, '新文本');
    expect(updated?.text).toBe('新文本');
    expect(updated?.id).toBe(entry.id);
    // reload 验证磁盘
    store.reload();
    expect(store.get()[0].text).toBe('新文本');
  });

  it('保留 usedAt - 编辑不重置使用统计', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    store.updateUsedAt(entry.id);
    const usedAtBefore = store.get()[0].usedAt;
    expect(usedAtBefore).toBeDefined();
    store.updateText(entry.id, '新文本');
    expect(store.get()[0].usedAt).toBe(usedAtBefore);
  });

  it('保留 alias - 编辑文本不动别名', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    store.setAlias(entry.id, 'myalias');
    store.updateText(entry.id, '新文本');
    expect(store.get()[0].alias).toBe('myalias');
  });

  it('保留 createdAt - 编辑文本不动创建时间', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    const createdAtBefore = store.get()[0].createdAt;
    store.updateText(entry.id, '新文本');
    expect(store.get()[0].createdAt).toBe(createdAtBefore);
  });

  it('超长文本 (201 chars) 抛错 - 与 save 一致', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    expect(() => store.updateText(entry.id, 'A'.repeat(201))).toThrow(/200/);
  });

  it('text 未变短路 persist - 不动磁盘', async () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    const mtimeBefore = fs.statSync(ordersFile).mtimeMs;
    // 等 mtime 推进（避免 ms 内重复写入难以区分）
    await new Promise<void>((r) => setTimeout(r, 20));
    const result = store.updateText(entry.id, '原文本');
    expect(result?.text).toBe('原文本');
    // mtime 不变即未 persist
    expect(fs.statSync(ordersFile).mtimeMs).toBe(mtimeBefore);
  });

  it('id 不存在返回 undefined', () => {
    const store = new OrderStore(ordersFile);
    expect(store.updateText('non-existent', 'text')).toBeUndefined();
  });

  it('trim - store 统一处理，卡片与 CLI 一致', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    // 前后空格被 trim 掉（updateText 内部统一 trim，卡片/CLI 两入口一致）
    const updated = store.updateText(entry.id, '  带空格  ');
    expect(updated?.text).toBe('带空格');
  });

  it('纯空白文本抛错 - 不能为空', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    expect(() => store.updateText(entry.id, '   ')).toThrow(/不能为空/);
  });

  it('trim 后超长抛错 - 先 trim 再数长度', () => {
    const store = new OrderStore(ordersFile);
    const entry = store.save('原文本');
    // 201 个字符但首尾有空格：trim 后恰为 199 合法 → 不抛错
    const padded = ' ' + 'A'.repeat(199) + ' ';
    const updated = store.updateText(entry.id, padded);
    expect(updated?.text).toBe('A'.repeat(199));
    // 202 个字符 trim 后 200 合法 → 不抛错
    const ok = store.updateText(entry.id, ' ' + 'A'.repeat(200) + ' ');
    expect(ok?.text).toBe('A'.repeat(200));
    // 203 个字符 trim 后 201 超长 → 抛错
    expect(() => store.updateText(entry.id, ' ' + 'A'.repeat(201) + ' ')).toThrow(/200/);
  });
});
