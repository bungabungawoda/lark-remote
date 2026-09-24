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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 测试隔离（设计文档 §9.5「禁真跑 agent」）：本用例走的 config 加载链
// （codex debug models / opencode models --verbose / kimi provider list --json）
// 会经 spawnProcessSync 真起 agent CLI —— Windows 上单次 2-7s，且行为取决于本机
// 装没装这些 CLI，会让「切换 agent」这类用例变成负载相关的偶发红。
// 这里只把同步 CLI 通道短路成「命令失败」，配置层对失败已有 FALLBACK_MODELS 兜底，
// 断言面不变；其余导出保持真实。
vi.mock('../../src/platform/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/platform/spawn.js')>();
  return {
    ...actual,
    spawnProcessSync: (() => ({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: 1,
      signal: null,
    })) as unknown as typeof actual.spawnProcessSync,
  };
});

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

    const result = router.buildConfigCard();
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

    // ANCHOR: opencode 的 model/provider/mode 字段不应该有 input 元素
    // （2026-09-17 起 opencode 纯 ACP 对齐 kimi：acp.turnIdleTimeoutMinutes
    //  有意使用 input 文本框（数值输入），不在此白名单内——若它换回 select
    //  或其它新 opencode 字段使用 input，本断言变红，需人工确认意图）
    expect(opencodeInputs.filter((n) => !n.includes('turnIdleTimeoutMinutes'))).toHaveLength(0);
    // Turn 空闲超时必须以 input 形式存在（与 kimi 卡片对齐的回归锚）
    expect(opencodeInputs.some((n) => n.includes('turnIdleTimeoutMinutes'))).toBe(true);
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

    const result = router.buildConfigCard();
    const json = JSON.stringify(result.card);

    // 卡片中是否有 opencode 相关的 select_static 元素
    const hasOpencodeSelect = json.includes('opencode') && json.includes('select_static');

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

    const result = router.buildConfigCard();
    const json = JSON.stringify(result.card);

    // 检查是否有 select_static
    const hasSelectStatic = json.includes('"tag":"select_static"');
    expect(hasSelectStatic).toBe(true);

    // 确认有选项
    const optionsCount = (json.match(/"value":/g) || []).length;
    expect(optionsCount).toBeGreaterThan(0);
  });
});
