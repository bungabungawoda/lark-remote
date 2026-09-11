// 分页卡「直接跳转页码」：paginationBar 内置 CardKit 2.0 input（✓ 提交图标），
// 用户输入页码即可跳到对应页；覆盖 /ls /ws /resume /active /order 全部多页卡片。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from '../router/index.js';
import { paginationBar } from './card-helpers.js';
import { SessionStore } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

function makeConfig(): AppConfig {
  return {
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-sonnet-4-20250514', effort: 'medium', stopGraceMs: 5000 },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
    defaultAgent: 'claude',
  };
}

let tmpDir: string;
let router: CommandRouter;
let sessionStore: SessionStore;
let mockBridge: ReturnType<typeof createMockBridge>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paging-jump-'));
  sessionStore = new SessionStore();
  sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tmpDir });
  mockBridge = createMockBridge();
  router = new CommandRouter({
    sessionStore,
    bridge: mockBridge,
    config: makeConfig(),
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath: path.join(tmpDir, 'workspace.json'),
    ordersPath: path.join(tmpDir, 'orders.json'),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
});

/** 取最近一次 updateCardInPlace 的卡片 JSON。 */
function lastUpdatedCardJson(): string {
  const calls = (mockBridge.updateCardInPlace as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.stringify(calls[calls.length - 1][0]);
}

describe('paginationBar 内置页码跳转输入', () => {
  it('所有分页卡都带 input + behaviors（cmd 与 pageSize 透传）', () => {
    for (const cmd of ['ls.page', 'ws.page', 'resume.page', 'active.page', 'order.page']) {
      const bar = paginationBar({
        cmd,
        offset: 0,
        pageSize: 30,
        total: 90,
        extra: { path: '/tmp' },
        label: '**第 1/3 页**',
      });
      const json = JSON.stringify(bar);
      expect(json).toContain('"tag":"input"');
      // input 的提交回调复用同一个 cmd，并携带 pageSize 用于页码→offset 换算
      expect(json).toContain(`"cmd":"${cmd}"`);
      expect(json).toContain('"pageSize":30');
      // 200861 铁律：禁止 V1 action 容器
      expectNoV1ActionContainer(json);
    }
  });

  it('test_anchor_pagination_bar_narrow_screen_layout：文案独占整行，控件行 input 占满剩余宽度', () => {
    // 手机窄屏回归：旧布局把文案（weighted 4）与输入框（weighted 2）和 auto 按钮
    // 塞进同一行，窄屏下文案折行、输入框窄到没法点。新布局拆成两行。
    type Col = { width?: string; weight?: number; elements?: Array<{ tag?: string }> };
    const elements = paginationBar({
      cmd: 'ls.page',
      offset: 0,
      pageSize: 30,
      total: 90,
      label: '**第 1/3 页**（共 65 项）',
    }) as unknown as [
      { tag: string; text?: { content?: string } },
      { tag: string; columns: Col[] },
    ];

    // 1) 两行：页码文案 div + 控件 column_set
    expect(elements).toHaveLength(2);
    const [label, controls] = elements;
    expect(label.tag).toBe('div');
    expect(label.text?.content).toBe('**第 1/3 页**（共 65 项）');

    // 2) 文案不在控件 column_set 内（否则又会被按钮挤压折行）
    expect(controls.tag).toBe('column_set');
    expect(controls.columns.some((c) => (c.elements ?? []).some((e) => e.tag === 'div'))).toBe(
      false,
    );
    expect(JSON.stringify(controls)).not.toContain('共 65 项');

    // 3) 控件行：仅 input 是加权列（吃满按钮之外的剩余宽度），按钮全部 auto
    const weighted = controls.columns.filter((c) => c.width === 'weighted');
    expect(weighted).toHaveLength(1);
    expect((weighted[0].elements ?? []).some((e) => e.tag === 'input')).toBe(true);
    for (const col of controls.columns) {
      if ((col.elements ?? []).some((e) => e.tag === 'button')) expect(col.width).toBe('auto');
    }

    // 200861 铁律：两行布局仍是合法 CardKit 2.0（无 V1 action 容器）
    expectNoV1ActionContainer(JSON.stringify(elements));
  });
});

describe('/ls 分页跳转', () => {
  it('输入页码直接跳到该页', async () => {
    for (let i = 0; i < 65; i++) {
      fs.writeFileSync(path.join(tmpDir, `f-${String(i).padStart(3, '0')}.txt`), 'x');
    }

    await router.handleCardAction(
      { cmd: 'ls.page', path: tmpDir, pageSize: 30, inputValue: '3' },
      ctx,
    );

    const json = lastUpdatedCardJson();
    expect(json).toContain('第 3/3 页');
    expect(json).toContain('f-060.txt');
    expect(json).not.toContain('f-000.txt');
    // 200861 铁律：翻页后的卡片仍是合法 CardKit 2.0
    expect(json).toContain('"schema":"2.0"');
    expectNoV1ActionContainer(json);
  });

  it('非法页码回错误 toast，不刷新卡片', async () => {
    for (let i = 0; i < 65; i++) {
      fs.writeFileSync(path.join(tmpDir, `f-${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const before = (mockBridge.updateCardInPlace as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;

    const res = await router.handleCardAction(
      { cmd: 'ls.page', path: tmpDir, pageSize: 30, inputValue: 'abc' },
      ctx,
    );

    expect((res as { toast?: { type: string; content: string } }).toast?.type).toBe('error');
    expect((res as { toast?: { content: string } }).toast?.content).toContain('页码');
    const after = (mockBridge.updateCardInPlace as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.length;
    expect(after).toBe(before);
  });

  it('超出范围的页码被 clamp 到最后一页', async () => {
    for (let i = 0; i < 65; i++) {
      fs.writeFileSync(path.join(tmpDir, `f-${String(i).padStart(3, '0')}.txt`), 'x');
    }

    await router.handleCardAction(
      { cmd: 'ls.page', path: tmpDir, pageSize: 30, inputValue: '99' },
      ctx,
    );

    expect(lastUpdatedCardJson()).toContain('第 3/3 页');
  });
});

describe('/ws 分页跳转', () => {
  it('输入页码直接跳到该页', async () => {
    for (let i = 1; i <= 12; i++) {
      router.cmdWs(['save', `w${String(i).padStart(2, '0')}`, tmpDir], ctx);
    }

    const res = await router.handleCardAction(
      { cmd: 'ws.page', pageSize: 5, inputValue: '3' },
      ctx,
    );

    expect((res as { toast?: { type: string } }).toast?.type).toBe('success');
    expect(lastUpdatedCardJson()).toContain('3/3');
  });
});

describe('/order 分页跳转', () => {
  it('输入页码直接跳到该页', async () => {
    for (let i = 1; i <= 12; i++) {
      router.cmdOrder(['save', `指令 ${i}`], ctx);
    }

    const res = await router.handleCardAction(
      { cmd: 'order.page', pageSize: 8, inputValue: '2' },
      ctx,
    );

    expect((res as { toast?: { type: string } }).toast?.type).toBe('success');
    const json = lastUpdatedCardJson();
    expect(json).toContain('第 2/2 页');
    expect(json).toContain('指令 12');
    expect(json).not.toContain('指令 8');
  });
});
