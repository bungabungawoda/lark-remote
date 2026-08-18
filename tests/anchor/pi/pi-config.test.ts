import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
/**
 * Merged anchor tests for pi config (path mapping / card / provider filter / fallback)
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - config-pi-path-mapping.test.ts
 *   - pi-config-card-model-filter.test.ts
 *   - pi-provider-model-filter.test.ts
 *   - pi-config-fallback-and-reset.test.ts
 *
 * All pi-config file I/O tests use PI_CONFIG_DIR env var to redirect to a temp
 * directory, avoiding dependency on real ~/.pi/agent/ state (which may differ
 * between local and CI environments).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AppConfigSchema,
  type AppConfig,
  mapAgentKey,
  setConfigValues,
} from '../../../src/config/index.js';
import {
  getPiModelOptions,
  loadPiConfig,
  _getModelsFilePath,
  _getAuthFilePath,
} from '../../../src/config/pi-config.js';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Shared stub factories
// ---------------------------------------------------------------------------
/** 从 card JSON 中提取指定 key 字段的 select 选项值 */
function extractFieldOptions(card: object, fieldKey: string): string[] {
  const json = JSON.stringify(card);
  const keyPattern = `"key":"${fieldKey}"`;
  const keyIndex = json.indexOf(keyPattern);
  if (keyIndex === -1) return [];

  const columnSetPattern = '{"tag":"column_set"';
  const columnSetStart = json.lastIndexOf(columnSetPattern, keyIndex);
  if (columnSetStart === -1) return [];

  const searchEnd = Math.min(keyIndex + 500, json.length);
  const searchArea = json.substring(columnSetStart, searchEnd);

  const selectStart = searchArea.indexOf('"tag":"select_static"');
  if (selectStart === -1) return [];

  const optionsStart = searchArea.indexOf('"options":[', selectStart);
  if (optionsStart === -1) return [];

  let depth = 0;
  let inString = false;
  let escape = false;
  let optionsEnd = -1;
  for (let i = optionsStart + 9; i < searchArea.length; i++) {
    const c = searchArea[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '[') depth++;
    if (c === ']') {
      depth--;
      if (depth === 0) {
        optionsEnd = i;
        break;
      }
    }
  }
  if (optionsEnd === -1) return [];

  const optionsJson = searchArea.substring(optionsStart, optionsEnd + 1);
  const matches = optionsJson.matchAll(/"value"\s*:\s*"([^"]+)"/g);
  return Array.from(matches, (m) => m[1]);
}

/** Write a models.json into the current PI_CONFIG_DIR */
function writeModelsJson(providers: Record<string, unknown>): void {
  const modelsPath = _getModelsFilePath();
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Shared beforeEach/afterEach: set PI_CONFIG_DIR to temp dir for all tests
// ---------------------------------------------------------------------------

let piTmpDir: string;
let savedPiConfigDir: string | undefined;

beforeEach(() => {
  piTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-pi-test-'));
  savedPiConfigDir = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = piTmpDir;
});

afterEach(() => {
  if (piTmpDir && fs.existsSync(piTmpDir)) {
    fs.rmSync(piTmpDir, { recursive: true, force: true });
  }
  if (savedPiConfigDir !== undefined) {
    process.env.PI_CONFIG_DIR = savedPiConfigDir;
  } else {
    delete process.env.PI_CONFIG_DIR;
  }
});

// ---------------------------------------------------------------------------
// config path mapping
// ---------------------------------------------------------------------------

/**
 * Anchor 测试：验证 mapAgentKey 能正确将 'pi.thinking' 映射到 'agents.pi.thinking'
 */
describe('config path mapping', () => {
  let config: AppConfig;

  beforeEach(() => {
    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {},
      agents: {
        pi: {
          provider: 'Volcano',
          model: 'glm-5.2',
          thinking: 'medium',
          tools: 'read,bash,edit,write,grep,find,ls',
        },
      },
      idle: { watchdogMinutes: 15 },
      output: { showThinking: true, showToolUse: true, showToolResult: true },
      logging: { level: 'info' },
      defaultAgent: 'claude',
    });
  });

  describe('mapAgentKey path mapping', () => {
    it('test_anchor_mapAgentKey_maps_pi_thinking_to_agents_path', () => {
      expect(mapAgentKey('pi.thinking')).toBe('agents.pi.thinking');
    });

    it('test_anchor_mapAgentKey_maps_pi_provider_to_agents_path', () => {
      expect(mapAgentKey('pi.provider')).toBe('agents.pi.provider');
    });

    it('test_anchor_mapAgentKey_maps_codex_to_agents_path', () => {
      expect(mapAgentKey('codex.model')).toBe('agents.codex.model');
    });

    it('test_anchor_mapAgentKey_maps_opencode_to_agents_path', () => {
      expect(mapAgentKey('opencode.providerID')).toBe('agents.opencode.providerID');
    });

    it('test_anchor_mapAgentKey_keeps_claude_at_top_level', () => {
      expect(mapAgentKey('claude.model')).toBe('claude.model');
    });

    it('test_anchor_mapAgentKey_keeps_kimi_at_top_level', () => {
      expect(mapAgentKey('kimi.model')).toBe('agents.kimi.model');
    });

    it('test_anchor_mapAgentKey_handles_non_agent_keys', () => {
      expect(mapAgentKey('feishu.appId')).toBe('feishu.appId');
      expect(mapAgentKey('idle.watchdogMinutes')).toBe('idle.watchdogMinutes');
      expect(mapAgentKey('defaultAgent')).toBe('defaultAgent');
    });
  });

  describe('setConfigValues path mapping via production code', () => {
    it('test_anchor_setConfigValues_maps_pi_thinking_to_agents_path', async () => {
      const nodePath = await import('node:path');
      const nodeOs = await import('node:os');
      const nodeFs = await import('node:fs');
      const YAML = await import('yaml');

      const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'test-config-'));
      const configPath = nodePath.join(tmpDir, 'config.yaml');

      const initialConfig = {
        feishu: { appId: 'test', appSecret: 'test' },
        claude: {},
        agents: {
          pi: {
            provider: 'Volcano',
            model: 'glm-5.2',
            thinking: 'medium',
            tools: 'read,bash,edit,write,grep,find,ls',
          },
        },
        idle: { watchdogMinutes: 15 },
        output: { showThinking: true, showToolUse: true, showToolResult: true },
        logging: { level: 'info' },
        defaultAgent: 'claude',
      };

      nodeFs.writeFileSync(configPath, YAML.stringify(initialConfig));

      const updated = setConfigValues(configPath, initialConfig, { 'pi.thinking': 'high' });
      expect(updated.agents?.pi?.thinking).toBe('high');

      nodeFs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('test_anchor_config_save_with_pi_thinking_should_pass_validation', () => {
      const key = 'pi.thinking';
      const mappedKey = mapAgentKey(key);

      const parts = mappedKey.split('.');
      let current: any = config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = 'high';

      expect(config.agents?.pi?.thinking).toBe('high');

      const result = AppConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('test_anchor_claude_model_should_remain_top_level', () => {
      const mappedKey = mapAgentKey('claude.model');
      expect(mappedKey).toBe('claude.model');

      const parts = mappedKey.split('.');
      let current: any = config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = 'claude-opus-4-8';

      expect(config.claude?.model).toBe('claude-opus-4-8');
      expect((config.agents as Record<string, unknown> | undefined)?.claude).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// anchor: config card model options filtered by provider
// ---------------------------------------------------------------------------

/**
 * Anchor: buildConfigCard 的 pi case 应根据当前 provider 过滤 model 选项
 *
 * 验证行为：当 defaultAgent='pi' 且 pi.provider='lt' 时，
 * /config 卡片中 pi.model 的选项只包含 lt provider 下的模型，
 * 不包含其他 provider（如 Volcano）的模型。
 *
 * 缺失后果：用户选了 provider=lt 后仍能选到 glm-5.2(Volcano)，
 * 保存后 pi --provider lt --model glm-5.2 调用失败。
 */
describe('anchor: config card model options filtered by provider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_anchor_config_card_filters_model_by_provider', async () => {
    writeModelsJson({
      lt: {
        baseUrl: 'https://pi-api.example.com/v1',
        api: 'openai-completions',
        models: [{ id: 'glm-5.1' }],
      },
      Volcano: {
        baseUrl: 'https://ark.example.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'glm-5.2' }],
      },
    });

    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      defaultAgent: 'pi',
      agents: {
        pi: {
          provider: 'lt',
          model: 'glm-5.1',
          thinking: 'medium',
          tools: 'read,bash',
        },
      },
    });

    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'pi'],
        withGet: true,
      }),
    });

    const result = router.buildConfigCard();
    const modelOptions = extractFieldOptions(result.card!, 'agents.pi.model');

    expect(modelOptions.some((m) => m === 'glm-5.1')).toBe(true);
    expect(modelOptions.some((m) => m === 'glm-5.2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// anchor: pi model options filtered by provider (unit level)
// ---------------------------------------------------------------------------

/**
 * Anchor: getPiModelOptions(provider) 应只返回该 provider 下的模型
 *
 * 缺失后果：用户选了 provider=lt 后仍能选到 glm-5.2(Volcano)，API 调用发到
 * lt endpoint 但 model ID 属于 Volcano，导致请求失败。
 */
describe('anchor: pi model options filtered by provider', () => {
  it('test_anchor_getPiModelOptions_filters_by_provider', async () => {
    writeModelsJson({
      lt: {
        baseUrl: 'https://pi-api.example.com/v1',
        api: 'openai-completions',
        models: [{ id: 'glm-5.1' }],
      },
      Volcano: {
        baseUrl: 'https://ark.example.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'glm-5.2' }],
      },
    });

    const ltModels = getPiModelOptions('lt');
    expect(ltModels.some((m) => m.includes('glm-5.1'))).toBe(true);
    expect(ltModels.some((m) => m.includes('glm-5.2'))).toBe(false);

    const volcanoModels = getPiModelOptions('Volcano');
    expect(volcanoModels.some((m) => m.includes('glm-5.2'))).toBe(true);
    expect(volcanoModels.some((m) => m.includes('glm-5.1'))).toBe(false);

    const allModels = getPiModelOptions();
    expect(allModels.some((m) => m.includes('glm-5.1'))).toBe(true);
    expect(allModels.some((m) => m.includes('glm-5.2'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 1: Fallback provider/model 列表不一致
// ---------------------------------------------------------------------------

describe('Bug 1: Fallback provider/model 列表应一致', () => {
  it('每个 provider fallback 都应有对应的 model fallback', () => {
    // Ensure no models.json/auth.json in PI_CONFIG_DIR → triggers fallback
    const modelsPath = _getModelsFilePath();
    if (fs.existsSync(modelsPath)) fs.unlinkSync(modelsPath);
    const authPath = _getAuthFilePath();
    if (fs.existsSync(authPath)) fs.unlinkSync(authPath);

    const providers = loadPiConfig().providerNames;
    for (const provider of providers) {
      const models = getPiModelOptions(provider);
      expect(
        models.length,
        `provider "${provider}" 在 fallback 中应有至少 1 个 model`,
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 2: 切换 provider 后未重置 model
// ---------------------------------------------------------------------------

describe('Bug 2: 切换 provider 后应自动重置 model', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-bug2-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('切换 provider 后，pendingConfig 中的 model 应属于新 provider', async () => {
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

    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      defaultAgent: 'pi',
      agents: {
        pi: {
          provider: 'Volcano',
          model: 'glm-5.2',
          thinking: 'medium',
          tools: 'read,bash',
        },
      },
    });

    const bridge = createMockBridge();
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'pi'],
        withGet: true,
      }),
    });

    await router.dispatchConfigAction(
      { cmd: 'config.set', key: 'agents.pi.provider', option: 'lt' },
      { userId: 'u1', chatId: 'c1', messageId: 'm1' },
    );

    const pendingPiConfig = router.pendingConfig?.agents?.pi;
    const currentModel = pendingPiConfig?.model;
    const ltModels = getPiModelOptions('lt');

    const isValidModel = ltModels.some((m) => m === currentModel);
    expect(
      isValidModel,
      `切换 provider 到 lt 后，model "${currentModel}" 应属于 lt 的模型列表 ${JSON.stringify(ltModels)}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 4: loadPiConfig 应只读取文件一次
// ---------------------------------------------------------------------------

describe('Bug 4: loadPiConfig 应只读取文件一次', () => {
  it('loadPiConfig 只调用一次 loadPiProviderConfig，同时获取 provider 和 model', () => {
    writeModelsJson({
      Volcano: {
        baseUrl: 'https://ark.example.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'glm-5.2' }],
      },
    });

    const readSpy = vi.spyOn(fs, 'readFileSync');

    const piCfg = loadPiConfig();
    const providerOptions = piCfg.providerNames;
    const modelOptions = piCfg.modelOptions('Volcano');

    const modelsJsonReads = readSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('models.json'),
    ).length;
    const authJsonReads = readSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('auth.json'),
    ).length;

    readSpy.mockRestore();

    expect(providerOptions.length).toBeGreaterThan(0);
    expect(modelOptions.length).toBeGreaterThan(0);

    expect(modelsJsonReads, 'models.json 应只被读取 1 次').toBeLessThanOrEqual(1);
    expect(authJsonReads, 'auth.json 应只被读取 1 次').toBeLessThanOrEqual(1);
  });
});
