import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from './index.js';
import { SessionStore } from '../session/index.js';
import { AppConfigSchema, type AppConfig } from '../config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';

let tmpDir: string;
let router: CommandRouter;
let mockBridge: ReturnType<typeof createMockBridge>;

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-alias-router-'));
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
  mockBridge = createMockBridge();
  router = new CommandRouter({
    sessionStore: new SessionStore(),
    bridge: mockBridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    ordersPath: path.join(tmpDir, 'orders.json'),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('order 别名卡片（order.alias*）', () => {
  it('/order 卡片：无别名指令显示 ＋别名 按钮', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    const result = router.cmdOrder([], ctx);
    const card = result.card as {
      body: { elements: Array<{ text?: { content?: string } }> };
    };
    const contents = card.body.elements.map((e) => e.text?.content ?? '');
    expect(contents).toContain('跑全量测试');
  });

  it('绑定别名后卡片显示 $name 标签', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    const result = router.cmdOrder([], ctx);
    const card = result.card as {
      body: { elements: Array<{ text?: { content?: string } }> };
    };
    const contents = card.body.elements.map((e) => e.text?.content ?? '');
    expect(contents.some((c) => c.includes('`$all`'))).toBe(true);
    // 200861 铁律：禁止 V1 action 容器
    expect(JSON.stringify(card)).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('order.aliasEdit 弹出别名编辑卡（schema 2.0 + input + behaviors）', async () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    const order = router['orderStore'].get()[0];
    const returned = await router.handleCardAction(
      { cmd: 'order.aliasEdit', orderId: order.id },
      ctx,
    );
    // handleOrderAliasEdit 不返回 card，用 updateCardInPlace 原地弹卡
    expect(returned).toBeUndefined();
    const updated = mockBridge.updateCardInPlace as ReturnType<typeof vi.fn>;
    expect(updated).toHaveBeenCalled();
    const sentCard = updated.mock.calls[0][0] as {
      schema: string;
      header: { title: { content: string } };
      body: { elements: Array<{ tag: string; name?: string; behaviors?: unknown[] }> };
    };
    expect(sentCard.schema).toBe('2.0');
    expect(sentCard.header.title.content).toContain('别名');
    // input 嵌在 column_set > column > elements 内，需递归查找（column_set 用 columns 存列）
    type AnyEl = {
      tag?: string;
      name?: string;
      behaviors?: unknown[];
      elements?: AnyEl[];
      columns?: AnyEl[];
    };
    const deepFind = (els: AnyEl[] | undefined, pred: (e: AnyEl) => boolean): boolean =>
      (els ?? []).some((e) => pred(e) || deepFind(e.elements, pred) || deepFind(e.columns, pred));
    expect(
      deepFind(sentCard.body.elements, (e) => e.tag === 'input' && e.name === 'aliasName'),
    ).toBe(true);
    // input 带 behaviors 回调（提交图标触发 order.aliasInput）
    expect(deepFind(sentCard.body.elements, (e) => Array.isArray(e.behaviors))).toBe(true);
    // 200861 铁律
    expect(JSON.stringify(sentCard)).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('order.aliasInput 绑定别名并重渲染列表卡', async () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    const order = router['orderStore'].get()[0];
    const result = await router.handleCardAction(
      { cmd: 'order.aliasInput', orderId: order.id, inputValue: 'all' },
      ctx,
    );
    expect((result as { toast?: { type: string } }).toast?.type).toBe('success');
    expect(router['orderStore'].get()[0].alias).toBe('all');
    // $name 展开命中
    expect(router.expandAliasMessage('$all')).toBe('跑全量测试');
    // 根因回归：callback 响应必须携带 card，否则飞书停留在 pre-click 编辑卡
    expect((result as { card?: unknown }).card).toBeDefined();
  });

  it('order.aliasInput 留空提交 = 解绑', async () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    const order = router['orderStore'].get()[0];
    const result = await router.handleCardAction(
      { cmd: 'order.aliasInput', orderId: order.id, inputValue: '' },
      ctx,
    );
    expect((result as { toast?: { type: string } }).toast?.type).toBe('success');
    expect(router['orderStore'].get()[0].alias).toBeUndefined();
    expect(router.expandAliasMessage('$all')).toBe('$all');
    // 根因回归：callback 响应必须携带 card，否则飞书停留在 pre-click 卡片
    expect((result as { card?: unknown }).card).toBeDefined();
  });

  it('order.aliasInput 撞名（已被其他指令占用）→ 错误 toast，不重渲染', async () => {
    router.cmdOrder(['save', '第一条'], ctx);
    router.cmdOrder(['save', '第二条'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'dup'], ctx);
    const order2 = router['orderStore'].get()[1];
    const result = await router.handleCardAction(
      { cmd: 'order.aliasInput', orderId: order2.id, inputValue: 'dup' },
      ctx,
    );
    expect((result as { toast?: { type: string; content: string } }).toast?.type).toBe('error');
    expect((result as { toast?: { content: string } }).toast?.content).toContain('已被');
    // 第二条未被绑定
    expect(router['orderStore'].get()[1].alias).toBeUndefined();
  });

  it('order.aliasInput 非法名（数字开头）→ 错误 toast', async () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    const order = router['orderStore'].get()[0];
    const result = await router.handleCardAction(
      { cmd: 'order.aliasInput', orderId: order.id, inputValue: '500' },
      ctx,
    );
    expect((result as { toast?: { type: string; content: string } }).toast?.type).toBe('error');
    expect(router['orderStore'].get()[0].alias).toBeUndefined();
  });

  it('order.aliasRemove 删除别名并重渲染列表卡', async () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    const order = router['orderStore'].get()[0];
    const result = await router.handleCardAction(
      { cmd: 'order.aliasRemove', orderId: order.id },
      ctx,
    );
    expect((result as { toast?: { type: string } }).toast?.type).toBe('success');
    expect(router['orderStore'].get()[0].alias).toBeUndefined();
    // $undefined 回归：toast 文案必须用删除前快照的别名，而非变异后的 order.alias
    expect((result as { toast?: { content: string } }).toast?.content).toBe('✅ 已移除别名 $all');
    // 根因回归：callback 响应必须携带 card
    expect((result as { card?: unknown }).card).toBeDefined();
  });

  it('删除指令时别名随之消失（alias 是 order 字段）', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    const order = router['orderStore'].get()[0];
    router['orderStore'].remove(order.id);
    expect(router['orderStore'].get().length).toBe(0);
    expect(router.expandAliasMessage('$all')).toBe('$all');
  });
});

describe('/order alias CLI 子命令', () => {
  it('按序号绑定别名', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    const result = router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    expect(result.text).toContain('✅ 已给指令绑定别名 $all');
  });

  it('按 orderId 绑定别名', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    const id = router['orderStore'].get()[0].id;
    const result = router.cmdOrder(['alias', 'add', id, 'all'], ctx);
    expect(result.text).toContain('✅ 已给指令绑定别名 $all');
  });

  it('撞名绑定失败提示', () => {
    router.cmdOrder(['save', '第一条'], ctx);
    router.cmdOrder(['save', '第二条'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'dup'], ctx);
    const result = router.cmdOrder(['alias', 'add', '2', 'dup'], ctx);
    expect(result.text).toContain('保存失败');
  });

  it('移除别名', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    const removed = router.cmdOrder(['alias', 'rm', '1'], ctx);
    expect(removed.text).toContain('✅ 已移除别名 $all');
    expect(router.cmdOrder(['alias', 'rm', '1'], ctx).text).toBe('该指令没有别名');
  });

  it('目标不存在提示', () => {
    expect(router.cmdOrder(['alias', 'add', '999', 'x'], ctx).text).toContain('指令不存在');
  });

  it('缺少参数提示用法', () => {
    expect(router.cmdOrder(['alias', 'add'], ctx).text).toContain('用法');
    expect(router.cmdOrder(['alias', 'rm'], ctx).text).toContain('用法');
  });

  it('/order alias list 并入列表卡片', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'all'], ctx);
    const result = router.cmdOrder(['alias', 'list'], ctx);
    const card = result.card as { body: { elements: Array<{ text?: { content?: string } }> } };
    const contents = card.body.elements.map((e) => e.text?.content ?? '');
    expect(contents.some((c) => c.includes('`$all`'))).toBe(true);
  });
});

describe('expandAliasMessage 接线', () => {
  it('$name 展开为绑定指令的文本', () => {
    router.cmdOrder(['save', '请修复报错并解释原因'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'fix'], ctx);
    expect(router.expandAliasMessage('$fix')).toBe('请修复报错并解释原因');
  });

  it('$name + 参数拼接', () => {
    router.cmdOrder(['save', '请读取文件并分析'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'h'], ctx);
    expect(router.expandAliasMessage('$h /tmp/a.txt')).toBe('请读取文件并分析 /tmp/a.txt');
  });

  it('未知别名、普通消息原样返回', () => {
    expect(router.expandAliasMessage('$missing')).toBe('$missing');
    expect(router.expandAliasMessage('hello world')).toBe('hello world');
  });

  it('别名文本以 / 开头时展开结果走命令路径', () => {
    router.cmdOrder(['save', '/cd /home/user/project'], ctx);
    router.cmdOrder(['alias', 'add', '1', 'cdhome'], ctx);
    expect(router.expandAliasMessage('$cdhome')).toBe('/cd /home/user/project');
  });

  it('数字开头消息（$500）不展开', () => {
    expect(router.expandAliasMessage('$500 元')).toBe('$500 元');
  });
});
