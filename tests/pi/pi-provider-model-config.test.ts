import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
/**
 * 测试：pi provider 和 model 应该从 ~/.pi/agent/models.json 和 auth.json 动态读取
 *
 * 验证以下行为：
 * 1. pi provider 下拉选项应该从配置文件动态生成
 * 2. pi model 下拉选项应该从配置文件动态生成
 * 3. 不应该使用硬编码的 provider 列表
 * 4. pi.model 应该是 select 类型，不是 input 类型
 *
 * 使用 PI_CONFIG_DIR 环境变量重定向文件 I/O 到临时目录，
 * 避免依赖真实 ~/.pi/agent/ 状态（本地和 CI 环境可能不同）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFieldOptions, isSelectField } from '../lib/pi-card-fields.js';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import {
  getPiModelOptions,
  loadPiProviderConfig,
  _getModelsFilePath,
  _getAuthFilePath,
} from '../../src/config/pi-config.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function buildPiConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'pi',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: {
      pi: {
        provider: 'Volcano',
        model: 'glm-5.2',
        thinking: 'medium',
        tools: 'read,bash,edit,write,grep,find,ls',
      },
    },
    idle: { watchdogMinutes: 15 },
    logging: {
      level: 'info',
      dir: 'logs',
    },
  });
}

/** Write a models.json into the current PI_CONFIG_DIR */
function writeModelsJson(providers: Record<string, unknown>): void {
  const modelsPath = _getModelsFilePath();
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8');
}

/** Write an auth.json into the current PI_CONFIG_DIR */
function writeAuthJson(auth: Record<string, unknown>): void {
  const authPath = _getAuthFilePath();
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('pi provider/model config from pi files', () => {
  let tmpDir: string;
  let savedPiConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-test-'));
    savedPiConfigDir = process.env.PI_CONFIG_DIR;
    process.env.PI_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (savedPiConfigDir !== undefined) {
      process.env.PI_CONFIG_DIR = savedPiConfigDir;
    } else {
      delete process.env.PI_CONFIG_DIR;
    }
  });

  /**
   * TEST 1: 直接测试 loadPiProviderConfig 函数
   * 验证能从配置文件读取 provider
   */
  it('should read providers from config files via helper function', async () => {
    writeModelsJson({
      'custom-provider': {
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        models: [{ id: 'custom-model-1' }, { id: 'custom-model-2' }],
      },
      lt: {
        baseUrl: 'https://pi-api.example.com/v1',
        api: 'openai-completions',
        models: [{ id: 'glm-5.1' }],
      },
    });

    writeAuthJson({
      anthropic: { type: 'api_key', key: 'sk-test-anthropic' },
      'my-auth-provider': { type: 'api_key', key: 'sk-test-key' },
    });

    // 调用辅助函数
    const config = loadPiProviderConfig();
    const providers = config.map((p) => p.name);

    // 验证包含配置文件中的 provider
    expect(providers).toContain('custom-provider');
    expect(providers).toContain('lt');
    expect(providers).toContain('anthropic');
    expect(providers).toContain('my-auth-provider');
  });

  /**
   * TEST 3: 验证 getPiModelOptions 返回非空列表
   */
  it('should return non-empty model list', async () => {
    writeModelsJson({
      Volcano: {
        baseUrl: 'https://ark.example.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'glm-5.2' }],
      },
    });

    const models = getPiModelOptions();
    // 精确断言（W3.7）：配置文件声明的模型必须出现在选项里，而非仅「非空」
    expect(models).toContain('glm-5.2');
  });

  /**
   * TEST 4: pi.model 应该是 select 类型（不是 input）
   * 通过检查 card 中该字段的 tag 来判断
   */
  it('should use select for pi.model field', async () => {
    writeModelsJson({
      Volcano: {
        baseUrl: 'https://ark.example.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'glm-5.2' }],
      },
    });

    const config = buildPiConfig();
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry({
      agentKinds: ['claude', 'pi'],
      withGet: true,
    });

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = router.buildConfigCard();
    const card = result.card!;

    // 验证 pi.model 是 select 类型
    expect(isSelectField(card, 'agents.pi.model')).toBe(true);

    // 同时验证 pi.provider 也是 select
    expect(isSelectField(card, 'agents.pi.provider')).toBe(true);
  });

  /**
   * TEST 5: provider 和 model 选项数量应该 > 0
   */
  it('should have options for provider and model fields', async () => {
    writeModelsJson({
      Volcano: {
        baseUrl: 'https://ark.example.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'glm-5.2' }],
      },
      lt: {
        baseUrl: 'https://pi-api.example.com/v1',
        api: 'openai-completions',
        models: [{ id: 'glm-5.1' }],
      },
    });

    const config = buildPiConfig();
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry({
      agentKinds: ['claude', 'pi'],
      withGet: true,
    });

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = router.buildConfigCard();
    const card = result.card!;

    const providerOptions = extractFieldOptions(card, 'agents.pi.provider');
    const modelOptions = extractFieldOptions(card, 'agents.pi.model');

    // 精确断言（W3.7）：provider 选项含两个配置项；model 选项按当前选中
    // provider 过滤，只含 Volcano 的模型（见 anchor 过滤语义用例）
    expect(providerOptions).toEqual(expect.arrayContaining(['Volcano', 'lt']));
    expect(modelOptions).toContain('glm-5.2');
    expect(modelOptions).not.toContain('glm-5.1');
  });
});
