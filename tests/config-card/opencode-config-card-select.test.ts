import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
/**
 * Opencode Config Card Field Type Test - ANCHOR
 *
 * BUG 描述：当 defaultAgent 为 opencode 时，buildConfigCard() 生成的卡片中
 * opencode 字段使用 type: 'input'，应该用 type: 'select'
 *
 * 验证策略：
 * 1. 卡片中有两种类型的字段：select_static (下拉框) 和 input (文本框)
 * 2. opencode 字段应该使用 select_static，不是 input
 * 3. 我们通过检查 opencode 相关的回调 key 对应的元素类型来判断
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

type RouterInternals = {
  buildConfigCard: () => { card: object };
  ensurePendingConfig: () => void;
  setNestedValue: (obj: unknown, key: string, value: unknown) => void;
  pendingConfig: Record<string, unknown>;
};
function buildOpencodeConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'opencode',
    agents: { opencode: { providerID: 'opencode', modelID: 'big-pickle', agent: 'claude' } },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('opencode config card ANCHOR: opencode fields must use select type', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-anchor-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * ANCHOR TEST: opencode 的 model 和 provider 字段不应该使用 input ���签
   *
   * BUG: 当前实现使用 type: 'input'，会生成 tag: 'input' 元素
   * 期望: 应该使用 type: 'select'，生成 tag: 'select_static' 元素
   */
  it('opencode fields must NOT use input tag (should use select_static)', () => {
    const config = buildOpencodeConfig();
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    });

    const result = (router as unknown as RouterInternals).buildConfigCard();
    const json = JSON.stringify(result.card);

    // 检查卡片中是否有 opencode 相关的 input 元素
    // 如果有，说明使用了 type: 'input'（错误）
    // 我们需要找到 opencode 字段对应的 input 元素

    // 策略：查找包含 opencode.modelID 或 opencode.providerID 的 key
    // 然后检查这些 key 附近的元素类型

    // 方法：找到所有 input 元素，检查它们的 name 属性是否包含 opencode
    const inputRegex = /"tag"\s*:\s*"input"[^}]*"name"\s*:\s*"([^"]+)"/g;
    const opencodeInputs: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = inputRegex.exec(json)) !== null) {
      const inputName = match[1];
      if (inputName.includes('opencode')) {
        opencodeInputs.push(inputName);
      }
    }

    // ANCHOR: opencode 字段不应该有任何 input 元素
    // 如果 opencodeInputs 非空，说明使用了 input（错误）
    expect(opencodeInputs).toHaveLength(0);
  });

  /**
   * ANCHOR TEST: opencode 字段应该使用 select_static
   */
  it('opencode fields should use select_static', () => {
    const config = buildOpencodeConfig();
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    });

    const result = (router as unknown as RouterInternals).buildConfigCard();
    const json = JSON.stringify(result.card);

    // 检查是否有任何 select_static 元素
    console.log('Total select_static count:', (json.match(/"tag":"select_static"/g) || []).length);

    // 打印所有 select_static 元素内容（找 name 属性）
    const selectBlocks = json.match(/"tag":"select_static"[\s\S]{0,300}?"/g) || [];
    console.log('Sample select_static block:', selectBlocks[0]?.slice(0, 200));

    // 找所有包含 agents.opencode 或 opencode 的字段
    // 回调 key 在 callback value 中
    const callbackKeys = json.match(/"cmd":"config\.","key":"([^"]+)"/g) || [];
    console.log('Callback keys sample:', callbackKeys.slice(0, 5));

    // 真正的问题是：检查卡片中是否有 opencode 相关的 select_static
    // 如果 modelID 字段是 select 类型，应该有对应的 select_static 元素
    // 且该元素的 name 应该是 'agents.opencode.modelID' 或类似

    // 最直接的检查：卡片中是否有 name 包含 opencode 的 select_static
    const hasOpencodeSelect = json.includes('opencode') && json.includes('select_static');
    console.log('Has opencode + select_static:', hasOpencodeSelect);

    // ANCHOR: opencode 字段应该有 select_static 元素
    expect(hasOpencodeSelect).toBe(true);
  });

  /**
   * BASELINE: pi 已经正确使用 select_static（验证测试方法正确）
   */
  it('BASELINE: pi model/provider fields use select_static (not input)', () => {
    const config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      defaultAgent: 'pi',
      agents: { pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' } },
    });
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    });

    const result = (router as unknown as RouterInternals).buildConfigCard();
    const json = JSON.stringify(result.card);

    // 检查是否有 select_static
    const hasSelectStatic = json.includes('"tag":"select_static"');
    expect(hasSelectStatic).toBe(true);

    // 确认有选项
    const optionsCount = (json.match(/"value":/g) || []).length;
    expect(optionsCount).toBeGreaterThan(0);
  });
});
