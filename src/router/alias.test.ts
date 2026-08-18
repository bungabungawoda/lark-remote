import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from './index.js';
import { SessionStore } from '../session/index.js';
import { AppConfigSchema, type AppConfig } from '../config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';

let tmpDir: string;
let aliasesFile: string;
let router: CommandRouter;

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-alias-router-'));
  aliasesFile = path.join(tmpDir, 'aliases.json');
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
  router = new CommandRouter({
    sessionStore: new SessionStore(),
    bridge: createMockBridge(),
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    ordersPath: path.join(tmpDir, 'orders.json'),
    aliasesPath: aliasesFile,
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('/order alias 子命令', () => {
  it('注册别名', () => {
    const result = router.cmdOrder(['alias', 'fix', '请修复报错并解释原因'], ctx);
    expect(result.text).toContain('✅ 已保存别名 $fix');
    const view = router.cmdOrder(['alias', 'fix'], ctx);
    expect(view.text).toBe('$fix → 请修复报错并解释原因');
  });

  it('同名注册为更新', () => {
    router.cmdOrder(['alias', 'fix', 'v1'], ctx);
    const result = router.cmdOrder(['alias', 'fix', 'v2'], ctx);
    expect(result.text).toContain('✅ 已更新别名 $fix');
    expect(router.cmdOrder(['alias', 'fix'], ctx).text).toBe('$fix → v2');
  });

  it('删除别名', () => {
    router.cmdOrder(['alias', 'fix', 'v1'], ctx);
    const removed = router.cmdOrder(['alias', 'remove', 'fix'], ctx);
    expect(removed.text).toContain('✅ 已删除别名 $fix');
    // 回显原内容：误删后可直接按回显重新注册
    expect(removed.text).toContain('原内容：v1');
    expect(router.cmdOrder(['alias', 'fix'], ctx).text).toBe('别名 $fix 不存在');
    expect(router.cmdOrder(['alias', 'remove', 'fix'], ctx).text).toBe('别名 $fix 不存在');
  });

  it('remove 为保留子命令：多词文本注册会被明确拒绝，不静默删除', () => {
    router.cmdOrder(['alias', 'fix', 'v1'], ctx);
    const result = router.cmdOrder(['alias', 'remove', 'fix', 'some text'], ctx);
    expect(result.text).toContain('保留子命令');
    // 未被误删
    expect(router.cmdOrder(['alias', 'fix'], ctx).text).toBe('$fix → v1');
  });

  it('名称/文本校验失败提示', () => {
    expect(router.cmdOrder(['alias', '500', 'x'], ctx).text).toContain('保存失败');
    expect(router.cmdOrder(['alias', 'fix', 'x'.repeat(201)], ctx).text).toContain('保存失败');
  });

  it('缺少参数提示用法', () => {
    expect(router.cmdOrder(['alias', 'remove'], ctx).text).toBe('用法: /order alias remove <name>');
  });

  it('/order alias 列表并入 /order 卡片（CardKit 2.0 + 别名区）', () => {
    router.cmdOrder(['alias', 'fix', '请修复报错'], ctx);
    router.cmdOrder(['alias', 'h', '请读取文件并分析'], ctx);

    const result = router.cmdOrder(['alias'], ctx);
    const card = result.card as {
      schema: string;
      body: { elements: Array<{ tag: string; text?: { content?: string } }> };
    };
    expect(card.schema).toBe('2.0');
    const contents = card.body.elements.map((e) => e.text?.content ?? '');
    expect(contents).toContain('**⚡ 别名**（输入 $name 触发）');
    expect(contents).toContain('$fix → 请修复报错');
    expect(contents).toContain('$h → 请读取文件并分析');
    // 200861 铁律：禁止 V1 action 容器
    expect(JSON.stringify(card)).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('orders 与 aliases 同卡展示', () => {
    router.cmdOrder(['save', '跑全量测试'], ctx);
    router.cmdOrder(['alias', 'fix', '请修复报错'], ctx);
    const result = router.cmdOrder([], ctx);
    const card = result.card as {
      body: { elements: Array<{ text?: { content?: string } }> };
    };
    const contents = card.body.elements.map((e) => e.text?.content ?? '');
    expect(contents).toContain('跑全量测试');
    expect(contents).toContain('$fix → 请修复报错');
  });
});

describe('expandAliasMessage 接线', () => {
  it('$name 展开为别名文本', () => {
    router.cmdOrder(['alias', 'fix', '请修复报错并解释原因'], ctx);
    expect(router.expandAliasMessage('$fix')).toBe('请修复报错并解释原因');
  });

  it('$name + 参数拼接', () => {
    router.cmdOrder(['alias', 'h', '请读取文件并分析'], ctx);
    expect(router.expandAliasMessage('$h /tmp/a.txt')).toBe('请读取文件并分析 /tmp/a.txt');
  });

  it('未知别名、普通消息原样返回', () => {
    expect(router.expandAliasMessage('$missing')).toBe('$missing');
    expect(router.expandAliasMessage('hello world')).toBe('hello world');
  });

  it('别名文本以 / 开头时展开结果走命令路径', () => {
    router.cmdOrder(['alias', 'cdhome', '/cd /home/user/project'], ctx);
    expect(router.expandAliasMessage('$cdhome')).toBe('/cd /home/user/project');
  });

  it('数字开头消息（$500）不展开', () => {
    expect(router.expandAliasMessage('$500 元')).toBe('$500 元');
  });
});
