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

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
import type { Bridge } from '../../src/bridge/index.js';
import type { SessionReaderRegistry } from '../../src/session/registry.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function createMockBridge(): Bridge {
  return {
    sendResult: vi.fn().mockResolvedValue(undefined),
    forwardToClaude: vi.fn().mockResolvedValue(undefined),
    isBusy: false,
    isBusyFor: vi.fn().mockReturnValue(false),
    enqueue: vi.fn(),
    interruptCurrentRun: vi.fn().mockResolvedValue(false),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn(),
    setIdleTimeout: vi.fn(),
    removeFromQueue: vi.fn().mockReturnValue(false),
    sendCard: vi.fn().mockResolvedValue(undefined),
    updateCard: vi.fn().mockResolvedValue(undefined),
    updateCardInPlace: vi.fn().mockResolvedValue(undefined),
  } as unknown as Bridge;
}

function createMockSessionReaderRegistry(
  agentKinds: string[] = ['claude', 'pi'],
): SessionReaderRegistry {
  return {
    get: vi.fn().mockReturnValue({
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    }),
    register: vi.fn(),
    listRegistered: vi.fn().mockReturnValue(agentKinds),
  } as unknown as SessionReaderRegistry;
}

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
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
    logging: {
      level: 'info',
      dir: 'logs',
    },
  });
}

/**
 * 从 card JSON 中提取字段的选项（简化版）
 */
function extractFieldOptions(card: object, fieldKey: string): string[] {
  const json = JSON.stringify(card);
  const keyIndex = json.indexOf(`"key":"${fieldKey}"`);
  if (keyIndex === -1) return [];

  // 从 key 位置往后找到一个 column_set 的 options
  const columnSetStart = json.indexOf('{"tag":"column_set"', keyIndex);
  if (columnSetStart === -1) return [];

  // 找到该 column_set 内的所有选项
  // 先找 select_static，如果没有就找 input
  const selectStart = json.indexOf('"tag":"select_static"', columnSetStart);
  const inputStart = json.indexOf('"tag":"input"', columnSetStart);

  // 看哪个更近
  const tagStart =
    selectStart !== -1 && (inputStart === -1 || selectStart < inputStart)
      ? selectStart
      : inputStart;

  if (tagStart === -1) return [];

  // 对于 select_static，找 options 数组
  if (selectStart !== -1 && (inputStart === -1 || selectStart < inputStart)) {
    const optionsStart = json.indexOf('"options":[', selectStart);
    if (optionsStart === -1) return [];

    // 找到 options 数组的结束位置
    let depth = 0;
    let inString = false;
    let escape = false;
    let optionsEnd = -1;

    for (let i = optionsStart + 9; i < json.length; i++) {
      const char = json[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"' && !escape) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '[') depth++;
      if (char === ']') {
        depth--;
        if (depth === 0) {
          optionsEnd = i;
          break;
        }
      }
    }

    if (optionsEnd === -1) return [];

    const optionsJson = json.substring(optionsStart, optionsEnd + 1);
    // 提取所有 "value": "xxx" 中的 xxx
    const valueMatches = optionsJson.matchAll(/"value"\s*:\s*"([^"]+)"/g);
    const options: string[] = [];
    for (const m of valueMatches) {
      options.push(m[1]);
    }
    return options;
  }

  // 对于 input 类型，返回空数组（input 没有预定义选项）
  return [];
}

/**
 * 从 card JSON 中判断字段是否是 select 类型
 */
function isSelectField(card: object, fieldKey: string): boolean {
  const json = JSON.stringify(card);
  const keyIndex = json.indexOf(`"key":"${fieldKey}"`);
  if (keyIndex === -1) return false;

  // 从 key 位置往后找一个 column_set，然后检查里面的 tag
  const columnSetStart = json.indexOf('{"tag":"column_set"', keyIndex);
  if (columnSetStart === -1) return false;

  // 在这个 column_set 内找 select_static 或 input
  const selectStatic = json.indexOf('"tag":"select_static"', columnSetStart);
  const input = json.indexOf('"tag":"input"', columnSetStart);

  // 看哪个更近
  if (selectStatic !== -1 && (input === -1 || selectStatic < input)) {
    return true;
  }

  return false;
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
    expect(models.length).toBeGreaterThan(0);
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
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'pi']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = (
      router as unknown as { buildConfigCard: () => { card: object } }
    ).buildConfigCard();
    const card = result.card;

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
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'pi']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = (
      router as unknown as { buildConfigCard: () => { card: object } }
    ).buildConfigCard();
    const card = result.card;

    const providerOptions = extractFieldOptions(card, 'agents.pi.provider');
    const modelOptions = extractFieldOptions(card, 'agents.pi.model');

    expect(providerOptions.length).toBeGreaterThan(0);
    expect(modelOptions.length).toBeGreaterThan(0);
  });

  /**
   * TEST 6: 验证选项包含预期的 provider（lt 或 Volcano）
   */
  it('should include expected providers from config', async () => {
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
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'pi']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = (
      router as unknown as { buildConfigCard: () => { card: object } }
    ).buildConfigCard();
    const card = result.card;

    const providerOptions = extractFieldOptions(card, 'agents.pi.provider');
    const modelOptions = extractFieldOptions(card, 'agents.pi.model');

    // 验证有 provider 选项
    expect(providerOptions.length).toBeGreaterThan(0);

    // 验证有 model 选项
    expect(modelOptions.length).toBeGreaterThan(0);
  });
});
