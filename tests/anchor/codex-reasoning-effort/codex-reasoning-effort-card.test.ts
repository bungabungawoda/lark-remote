/**
 * Codex config card reasoning-effort rendering anchors
 * (card field presence, effort-follows-model on model switch).
 */
import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import path from 'node:path';
import fs from 'node:fs';
import { mockLogger } from '../../lib/logger-mock.js';
import { makeTempDir } from '../../lib/temp-dir.js';
import {
  extractSelectOptions,
  extractSelectCurrentValue,
  extractConfigFieldKeys,
} from '../../lib/card-tree.js';
import { makeCodexConfig } from '../../lib/agent-config-fixture.js';
import { createRouterFixture } from '../../lib/router-fixture.js';

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('../../../src/platform/spawn.js', async () => ({
  ...(await import('../../lib/spawn-mock.js')).spawnModuleMock(mockSpawnSync),
}));
vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

/** Bundled fixture using codex-catalog-fixture helpers */
const BUNDLED_FIXTURE = makeCatalog([
  makeModel(
    'gpt-5.6-sol',
    [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    { default_reasoning_level: 'low' },
  ),
]);

// ---------------------------------------------------------------------------
// Config card codex reasoningEffort
// ---------------------------------------------------------------------------

/**
 * Red Agent -- Anchor
 *
 * Target: /config 卡片 codex 分区应显示"推理强度"下拉
 *
 */

function buildCodexConfig(): AppConfig {
  return makeCodexConfig({
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    reasoningEffort: 'high',
    claude: { model: 'opus', effort: 'medium', stopGraceMs: 5000 },
  });
}

describe('Config card codex reasoningEffort - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = makeTempDir('codex-card-test-');
    process.env.CODEX_HOME = tmpDir;
    mockSpawnSync.mockImplementation((_binary: string, args: string[]) => {
      if (args.includes('--bundled')) {
        return BUNDLED_FIXTURE;
      }
      return BUNDLED_FIXTURE;
    });
  });

  afterEach(() => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateCodexBundledCache();
  });

  it('test_anchor_config_card_codex_has_reasoning_effort_field', () => {
    const config = buildCodexConfig();
    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex'],
      }),
    }).router;

    const cardResult = router.buildConfigCard();
    const card = cardResult.card;
    expect(card).toBeDefined();

    const fieldKeys = extractConfigFieldKeys(card);
    const reasoningEffortKey = fieldKeys.find((k) => k === 'agents.codex.reasoningEffort');
    expect(reasoningEffortKey).toBe('agents.codex.reasoningEffort');
  });

  it('test_anchor_config_card_codex_reasoning_effort_has_options', () => {
    const config = buildCodexConfig();
    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex'],
      }),
    }).router;

    const cardResult = router.buildConfigCard();
    const card = cardResult.card;
    const json = JSON.stringify(card);

    expect(json).toContain('low');
    expect(json).toContain('medium');
    expect(json).toContain('high');
    expect(json).toContain('xhigh');
  });

  it('test_anchor_config_card_codex_reasoning_effort_label', () => {
    const config = buildCodexConfig();
    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex'],
      }),
    }).router;

    const cardResult = router.buildConfigCard();
    const card = cardResult.card;
    const json = JSON.stringify(card);

    expect(json).toContain('推理强度');
  });
});

// ---------------------------------------------------------------------------
// Config card effort follows model
// ---------------------------------------------------------------------------

/**
 * Red Agent -- Anchor（用户验收：卡片选模型后推理强度下拉按模型实际支持更新）
 *
 * Target: /config 卡片选定模型后，推理强度下拉必须立即变为该模型实际支持的档位
 *
 * Spec basis: 用户需求 + codex debug models 实测
 */

function buildCodexConfigForModel(
  model: string,
  modelProvider: string,
  reasoningEffort: string,
): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    agents: {
      codex: {
        model,
        modelProvider,
        reasoningEffort,
        stopGraceMs: 5000,
      },
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}

const BUNDLED_JSON = makeCatalog([
  makeModel(
    'gpt-5.6-sol',
    [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
    { default_reasoning_level: 'low', description: 'Latest frontier agentic coding model.' },
  ),
  makeModel(
    'gpt-5.4',
    [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    {
      default_reasoning_level: 'medium',
      priority: 16,
      description: 'GPT-5.4',
    },
  ),
]);

const ACTIVE_CATALOG_JSON = makeCatalog([
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

describe('codex config card effort follows model - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = makeTempDir('codex-effort-follows-');
    process.env.CODEX_HOME = tmpDir;
  });

  afterEach(() => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateCodexBundledCache();
  });

  function makeRouter(config: AppConfig): CommandRouter {
    return createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge({
        sendCard: vi.fn().mockResolvedValue(undefined),
        clearRunners: vi.fn(),
      }),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex'],
      }),
    }).router;
  }

  it('test_anchor_openai_model_shows_medium_and_switching_model_updates_effort_dropdown', async () => {
    mockSpawnSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && args.includes('--bundled')) {
        return BUNDLED_JSON;
      }
      return BUNDLED_JSON;
    });

    const router = makeRouter(buildCodexConfigForModel('gpt-5.6-sol', 'openai', 'ultra'));
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

    const card1 = router.buildConfigCard().card!;
    const effort1 = extractSelectOptions(card1, 'agents.codex.reasoningEffort');
    expect(effort1).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effort1).toContain('medium');
    expect(extractSelectCurrentValue(card1, 'agents.codex.reasoningEffort')).toBe('ultra');

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'gpt-5.4' },
      ctx,
    );
    const card2 = router.buildConfigCard().card!;
    expect(extractSelectOptions(card2, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(extractSelectCurrentValue(card2, 'agents.codex.reasoningEffort')).toBe('medium');
  });

  it('test_anchor_catalog_deepseek_models_keep_low_high_max_on_switch', async () => {
    const catalogHome = path.join(tmpDir, 'catalog-home');
    fs.mkdirSync(catalogHome, { recursive: true });
    fs.writeFileSync(
      path.join(catalogHome, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(catalogHome, 'models.json').replaceAll('\\', '/')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(catalogHome, 'models.json'), ACTIVE_CATALOG_JSON);
    process.env.CODEX_HOME = catalogHome;
    invalidateCodexBundledCache();
    mockSpawnSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return ACTIVE_CATALOG_JSON;
      }
      return BUNDLED_JSON;
    });

    const router = makeRouter(buildCodexConfigForModel('deepseek-v4-flash', 'deepseek', 'high'));
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

    const card1 = router.buildConfigCard().card!;
    expect(extractSelectOptions(card1, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'high',
      'max',
    ]);

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'deepseek-v4-pro' },
      ctx,
    );
    const card2 = router.buildConfigCard().card!;
    expect(extractSelectOptions(card2, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(extractSelectCurrentValue(card2, 'agents.codex.reasoningEffort')).toBe('high');
  });
});
