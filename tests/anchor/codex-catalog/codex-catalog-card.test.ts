/**
 * codex config 卡片的 catalog 渲染契约：推理强度/模型/provider 下拉来源、
 * 空档位模型切换、中位档位重置、保存清空档位、自定义模型输入。
 *
 * 合并自 codex-active-catalog-card-effort / codex-catalog-empty-effort-fixes /
 * codex-catalog-middle-vs-default / codex-catalog-save-clears-effort /
 * codex-custom-model-input。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../../src/router/index.js';
import { createRouterFixture } from '../../lib/router-fixture.js';
import { setConfigValues } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import {
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  invalidateCodexBundledCache,
  isCodexCatalogMode,
  loadCodexConfig,
} from '../../../src/config/codex-config.js';
import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { makeCodexConfig } from '../../lib/agent-config-fixture.js';
import {
  extractInputFields,
  extractSelectCurrentValue,
  extractSelectOptions,
} from '../../lib/card-tree.js';
import { mockLogger } from '../../lib/logger-mock.js';
import { rmRf } from '../../lib/tmp-cleanup.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import { runCustomModelInputContract } from '../../lib/config-card-custom-model.js';

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('../../../src/platform/spawn.js', async () => ({
  ...(await import('../../lib/spawn-mock.js')).spawnModuleMock(mockSpawnSync),
}));
vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

// ── fixtures ──────────────────────────────────────────────────────────
const CARD_CATALOG = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    description: 'Latest frontier agentic coding model.',
  }),
  makeModel('deepseek-v4-pro', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    priority: 2,
    description: 'Most capable agentic coding model.',
  }),
]);

const SIX_LEVEL_CATALOG = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
  }),
  makeModel(
    'six-level-model',
    [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
    { default_reasoning_level: 'low', priority: 2 },
  ),
]);

const EMPTY_LEVELS_CATALOG = makeCatalog([
  makeModel('empty-levels-model', [], { default_reasoning_level: 'high' }),
  makeModel('gpt-5.6-sol', [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }], {
    default_reasoning_level: 'low',
  }),
]);

const SINGLE_MODEL_CATALOG = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
  }),
]);

/** 内置目录 fixture（legacy / fallback）：gpt-5.2。 */
const BUNDLED_FIXTURE = makeCatalog([
  makeModel('gpt-5.2', [{ effort: 'medium' }], {
    default_reasoning_level: 'medium',
    description: 'GPT-5.2',
  }),
]);

function catalogAwareMock() {
  return (_binary: string, args: string[]) => {
    if (args.includes('--bundled')) return BUNDLED_FIXTURE;
    const home = process.env.CODEX_HOME;
    if (home) {
      const cfgPath = path.join(home, 'config.toml');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const m = raw.match(/model_catalog_json\s*=\s*"([^"]+)"/);
        if (m) {
          if (fs.existsSync(m[1])) return fs.readFileSync(m[1], 'utf-8');
          throw new Error('boom: catalog file missing');
        }
        // 非法/空串声明：codex 视为硬错误，不回退内置目录。
        if (raw.includes('model_catalog_json')) {
          throw new Error('boom: invalid catalog declaration');
        }
      }
    }
    return BUNDLED_FIXTURE;
  };
}

let tmpDir: string;
let fallbackHome: string;
let oldCodexHome: string | undefined;

beforeEach(() => {
  mockSpawnSync.mockReset();
  mockLogger.warn.mockReset();
  invalidateCodexBundledCache();
  oldCodexHome = process.env.CODEX_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-card-'));
  // 默认 fallback 环境（无 config.toml）→ bundled gpt-5.2。
  fallbackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-card-home-'));
  process.env.CODEX_HOME = fallbackHome;
  mockSpawnSync.mockImplementation(catalogAwareMock());
});

afterEach(() => {
  if (oldCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = oldCodexHome;
  }
  rmRf(fallbackHome);
  rmRf(tmpDir);
  invalidateCodexBundledCache();
});

/** 在 tmpDir 写 config.toml + models.json，并切到该 CODEX_HOME。 */
function useCatalog(catalog: string, opts: { providers?: boolean; catalogLine?: string } = {}) {
  const modelsPath = path.join(tmpDir, 'models.json');
  fs.writeFileSync(modelsPath, catalog);
  const lines = [
    'model = "deepseek-v4-flash"',
    ...(opts.providers === false ? [] : ['model_provider = "deepseek"']),
    opts.catalogLine ?? `model_catalog_json = "${modelsPath.replaceAll('\\', '/')}"`,
    '',
    ...(opts.providers === false
      ? []
      : ['[model_providers.deepseek]', 'name = "deepseek"', 'env_key = "DS_API_KEY"', '']),
  ];
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), lines.join('\n'));
  process.env.CODEX_HOME = tmpDir;
  invalidateCodexBundledCache();
  return modelsPath;
}

function useBrokenConfig(mockLine: string): void {
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), mockLine);
  process.env.CODEX_HOME = tmpDir;
  invalidateCodexBundledCache();
}

function makeRouter(config: AppConfig, dir = tmpDir): CommandRouter {
  return createRouterFixture({
    tmpDir: dir,
    config,
    bridge: createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() }),
    sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude', 'codex'] }),
  }).router;
}

function extractModelSelectOptions(card: object): string[] {
  return extractSelectOptions(card, 'agents.codex.model');
}

function extractProviderOptions(card: object): string[] {
  return extractSelectOptions(card, 'agents.codex.modelProvider');
}

function buildCodexConfig(model: string = 'gpt-5.2'): AppConfig {
  return makeCodexConfig({ model });
}

describe('codex catalog config card', () => {
  it('test_anchor_catalog_mode_config_card_reasoning_effort_select_is_active_catalog_levels', () => {
    useCatalog(CARD_CATALOG);
    const router = makeRouter(
      makeCodexConfig({
        model: 'deepseek-v4-flash',
        modelProvider: 'deepseek',
        reasoningEffort: 'high',
      }),
    );

    const card = router.buildConfigCard().card;

    // 推理强度下拉 = 活动目录档位，不得是 bundled 的档位
    expect(extractSelectOptions(card, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(extractSelectOptions(card, 'agents.codex.modelProvider')).toEqual([
      'openai',
      'deepseek',
    ]);
    expect(extractSelectOptions(card, 'agents.codex.model')).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
  });

  it('test_anchor_p1_empty_declared_levels_stay_empty_and_default_used', async () => {
    useCatalog(EMPTY_LEVELS_CATALOG);

    expect(getReasoningEffortOptions('empty-levels-model')).toEqual([]);
    expect(getDefaultReasoningEffort('empty-levels-model')).toBe('high');

    const router = makeRouter(
      makeCodexConfig({
        model: 'gpt-5.6-sol',
        modelProvider: 'deepseek',
        reasoningEffort: 'ultra',
      }),
    );
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'empty-levels-model' },
      { userId: 'u1', chatId: 'c1', messageId: 'm1' },
    );
    const card = router.buildConfigCard().card;
    expect(extractSelectOptions(card, 'agents.codex.reasoningEffort')).toEqual([]);
    expect(extractSelectCurrentValue(card, 'agents.codex.reasoningEffort')).toBe('high');
  });

  it('test_anchor_p3_5_unparseable_config_falls_back_to_legacy_non_catalog', () => {
    useBrokenConfig('model = "deepseek-v4-flash"\n[model_providers\n');

    expect(isCodexCatalogMode()).toBe(false);
    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai']);
    expect(cfg.modelOptions()).toEqual(['gpt-5.2']);
    expect(cfg.modelOptions('openai')).toEqual(['gpt-5.2']);
  });

  it('test_anchor_p2_1_empty_catalog_json_value_stays_catalog_degraded', () => {
    useCatalog(SINGLE_MODEL_CATALOG, { catalogLine: 'model_catalog_json = ""' });

    expect(isCodexCatalogMode()).toBe(true);
    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg.modelOptions('deepseek')).not.toContain('gpt-5.2');
    expect(cfg.modelOptions('deepseek')).not.toContain('o3');
  });

  it('test_anchor_switch_uses_middle_index_not_declared_default', async () => {
    useCatalog(SIX_LEVEL_CATALOG);
    const router = makeRouter(
      makeCodexConfig({
        model: 'deepseek-v4-flash',
        modelProvider: 'deepseek',
        reasoningEffort: 'minimal',
      }),
    );
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'six-level-model' },
      { userId: 'u1', chatId: 'c1', messageId: 'm1' },
    );

    // 6 档中位 index (6-1)/2=2 → high（声明 default 是 low）。
    expect(router.pendingConfig?.agents?.codex?.reasoningEffort).toBe('high');
    const card = router.buildConfigCard().card;
    expect(extractSelectCurrentValue(card, 'agents.codex.reasoningEffort')).toBe('high');
  });

  it('test_anchor_effort_clear_is_delete_not_literal_undefined_through_save_path', async () => {
    useCatalog(SINGLE_MODEL_CATALOG);
    const configPath = path.join(tmpDir, 'config.yaml');
    const config = makeCodexConfig({
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      reasoningEffort: 'high',
    });
    const router = makeRouter(config);

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'unknown-model' },
      { userId: 'u1', chatId: 'c1', messageId: 'm1' },
    );

    expect(router.pendingConfig?.agents?.codex?.model).toBe('unknown-model');
    expect(
      Object.prototype.hasOwnProperty.call(router.pendingConfig?.agents?.codex, 'reasoningEffort'),
    ).toBe(false);

    const updates = router.diffConfig(config, router.pendingConfig!);
    expect(updates['agents.codex.reasoningEffort']).toBeUndefined();
    expect(updates['agents.codex.reasoningEffort']).not.toBe('undefined');
    expect(updates['agents.codex.model']).toBe('unknown-model');

    const saved = setConfigValues(configPath, config, updates);
    expect(saved.agents?.codex?.reasoningEffort).toBeUndefined();
    const yamlContent = fs.readFileSync(configPath, 'utf-8');
    expect(yamlContent).not.toContain('reasoningEffort');
    expect(yamlContent).not.toContain('undefined');
  });

  // ── 自定义模型输入契约 ────────────────────────────────────────────
  runCustomModelInputContract({
    makeRouter: (model: string) => makeRouter(buildCodexConfig(model)),
    key: 'agents.codex.model',
    presetModel: 'gpt-5.2',
    customModel: 'custom-model-xyz',
  });

  it('should update pendingConfig when user inputs custom model via config.input', () => {
    const config = buildCodexConfig('gpt-5.2');
    const router = makeRouter(config);

    router.ensurePendingConfig();

    if (router.pendingConfig) {
      router.pendingConfig.agents = {
        ...(router.pendingConfig.agents ?? {}),
        codex: { ...(config.agents?.codex ?? {}), model: 'custom-codex-model-xyz' },
      } as AppConfig['agents'];
    }

    expect(router.pendingConfig?.agents?.codex?.model).toBe('custom-codex-model-xyz');
  });

  it('should treat catalog model as preset and legacy bundled model as custom in catalog mode', () => {
    const catalogHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-custom-catalog-home-'));
    const modelsPath = path.join(catalogHome, 'models.json');
    fs.writeFileSync(
      path.join(catalogHome, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${modelsPath.replaceAll('\\', '/')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(modelsPath, SINGLE_MODEL_CATALOG);
    process.env.CODEX_HOME = catalogHome;

    // 场景 1：catalog 模型 + 对应 provider → 预设，输入框为空
    const config1 = buildCodexConfig('deepseek-v4-flash');
    config1.agents!.codex!.modelProvider = 'deepseek';
    const card1 = makeRouter(config1).buildConfigCard() as { card: object };
    const custom1 = extractInputFields(card1.card).find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );
    expect(custom1?.defaultValue).toBe('');
    expect(extractModelSelectOptions(card1.card)).toEqual(['deepseek-v4-flash']);

    // 场景 2：旧 bundled 模型 + openai provider → 不在活动目录，视为自定义回显
    const config2 = buildCodexConfig('gpt-5.2');
    const card2 = makeRouter(config2).buildConfigCard() as { card: object };
    const custom2 = extractInputFields(card2.card).find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );
    expect(custom2?.defaultValue).toBe('gpt-5.2');
    const providerOptions2 = extractProviderOptions(card2.card);
    expect(providerOptions2).toContain('openai');
    expect(providerOptions2).not.toContain('anthropic');

    rmRf(catalogHome);
  });
});
