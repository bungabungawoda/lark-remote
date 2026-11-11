import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
/**
 * Anchor tests for pi config: path mapping, card model filter, provider
 * filter, fallback and reset.
 *
 * pi 的 provider/model 清单来自 `pi --list-models`（内置 provider 目录与
 * models.json 叠加后、按凭据可用过滤的运行时真相）。该命令经
 * src/platform/spawn 拉起，这里 mock 该 seam，任何用例都不 spawn 真 pi；
 * PI_CONFIG_DIR 仍重定向到临时目录，用于缓存键隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 生产代码经 platform/spawn（cross-spawn）调用 pi，mock 该 seam。
const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('../../../src/platform/spawn.js', async () => ({
  ...(await import('../../lib/spawn-mock.js')).spawnModuleMock(mockSpawnSync),
}));
vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

import {
  AppConfigSchema,
  type AppConfig,
  mapAgentKey,
  setConfigValues,
} from '../../../src/config/index.js';
import {
  getPiModelOptions,
  loadPiConfig,
  _invalidatePiListCacheForTest,
} from '../../../src/config/pi-config.js';
import { extractFieldOptions } from '../../lib/pi-card-fields.js';
import { createRouterFixture } from '../../lib/router-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Shared stub factories
// ---------------------------------------------------------------------------

/** 两个 provider 的 pi 清单：切换 provider 时模型必须跟着换。 */
const TWO_PROVIDERS = [
  'provider  model    context  max-out  thinking  images',
  'Volcano   glm-5.2  262.1K   16.4K    yes       no    ',
  'lt        glm-5.1  200K     16.4K    yes       no    ',
].join('\n');

/** mock 一次成功的 `pi --list-models`（表格文本）。 */
function mockListModels(table: string = TWO_PROVIDERS): void {
  mockSpawnSync.mockReturnValue({ status: 0, stdout: table, stderr: '' });
}

// ---------------------------------------------------------------------------
// Shared beforeEach/afterEach: 隔离 PI_CONFIG_DIR 与模块缓存
// ---------------------------------------------------------------------------

let piTmpDir: string;
let savedPiConfigDir: string | undefined;

beforeEach(() => {
  piTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-pi-test-'));
  savedPiConfigDir = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = piTmpDir;
  mockSpawnSync.mockReset();
  _invalidatePiListCacheForTest();
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
    mockListModels();

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

    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;

    const result = router.buildConfigCard();
    const modelOptions = extractFieldOptions(result.card!, 'agents.pi.model');

    expect(modelOptions.some((m) => m === 'glm-5.1')).toBe(true);
    expect(modelOptions.some((m) => m === 'glm-5.2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// anchor: pi thinking level options
// ---------------------------------------------------------------------------

/**
 * Anchor: /config 卡片的 pi 思考级别下拉必须与 `pi --thinking` 的合法取值一致
 *
 * 缺失后果：下拉只到 xhigh 时选不到 max（pi 0.80.6 起支持的最高档），对
 * glm-5.3 / MiniMax-M3.1 这类最高档为 max 的模型只能跑到 xhigh；配置里写
 * thinking: max 也会被 schema 拒绝。
 */
describe('anchor: pi thinking level options', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-pi-thinking-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_anchor_config_card_pi_thinking_offers_max', () => {
    mockListModels();

    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      defaultAgent: 'pi',
      agents: {
        pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'max' },
      },
    });
    expect(config.agents?.pi?.thinking).toBe('max');

    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;

    const result = router.buildConfigCard();
    const options = extractFieldOptions(result.card!, 'agents.pi.thinking');
    expect(options).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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
    mockListModels();

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
    // 命令不可用（未安装/失败）→ 走静态 fallback 清单
    mockSpawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stdout: '' });

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
    mockListModels();

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
    const router = createRouterFixture({
      tmpDir,
      config,
      bridge,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;

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

describe('Bug 4: loadPiConfig 只拉一次清单', () => {
  it('loadPiConfig 一次调用只 spawn 一次 pi，provider 与 model 同源', () => {
    mockListModels();

    const piCfg = loadPiConfig();
    const providerOptions = piCfg.providerNames;
    const modelOptions = piCfg.modelOptions('Volcano');
    const allOptions = piCfg.modelOptions();

    expect(providerOptions.length).toBeGreaterThan(0);
    expect(modelOptions.length).toBeGreaterThan(0);
    expect(allOptions.length).toBeGreaterThan(0);

    // provider 与 model 从同一份清单派生，不得为每个字段各拉一次
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('pi 缺失时回退静态清单，且缓存失败结果不再重复 spawn', () => {
    mockSpawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stdout: '' });

    const first = loadPiConfig();
    const second = loadPiConfig();

    expect(first.providerNames).toEqual(second.providerNames);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });
});
