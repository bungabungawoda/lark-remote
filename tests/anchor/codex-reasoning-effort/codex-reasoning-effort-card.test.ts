/**
 * Codex config card reasoning-effort rendering anchors
 * (card field presence, effort-follows-model on model switch).
 *
 * Split from codex-reasoning-effort.test.ts (merged 2026-08-04, Phase 4;
 * re-split 2026-08-29 cleanup).
 */
import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { mockSpawnSync, mockLogger } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/platform/spawn.js', () => ({
  // 兼容历史 mock 形态：返回 string/Buffer 视为成功 stdout，抛错/其余原样穿透
  spawnProcessSync: (...args: any[]) => {
    const v = mockSpawnSync(...args);
    if (typeof v === 'string' || Buffer.isBuffer(v)) {
      return { status: 0, stdout: v, stderr: '' };
    }
    return v;
  },
  spawnProcess: () => {
    throw new Error('anchor test must not spawn async');
  },
}));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

/** Bundled fixture using codex-catalog-fixture helpers */
const BUNDLED_FIXTURE = makeCatalog([
  makeModel(
    'gpt-5.6-sol',
    [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    { default_reasoning_level: 'low' },
  ),
]);

// ---------------------------------------------------------------------------
// Config card codex reasoningEffort (Round 6)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 6 - Anchor
 *
 * Target: /config 卡片 codex 分区应显示"推理强度"下拉
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §5
 */

function extractConfigFieldKeys(card: object): string[] {
  const keys = new Set<string>();
  const json = JSON.stringify(card);
  const regex = /"cmd"\s*:\s*"config\.\w+"\s*,\s*"key"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(json)) !== null) {
    keys.add(match[1]);
  }
  const regex2 = /"key"\s*:\s*"([^"]+)"\s*,\s*"cmd"\s*:\s*"config\.\w+"/g;
  while ((match = regex2.exec(json)) !== null) {
    keys.add(match[1]);
  }
  return Array.from(keys);
}

function buildCodexConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    claude: {
      model: 'opus',
      effort: 'medium',
      stopGraceMs: 5000,
    },
    agents: {
      codex: {
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: 'high',
      },
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-card-test-'));
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
    fs.mkdirSync(tmpDir, { recursive: true });
    invalidateCodexBundledCache();
  });

  it('test_anchor_config_card_codex_has_reasoning_effort_field', () => {
    const config = buildCodexConfig();
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry({
      agentKinds: ['claude', 'codex'],
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

    const cardResult = router.buildConfigCard();
    const card = cardResult.card;
    expect(card).toBeDefined();

    const fieldKeys = extractConfigFieldKeys(card);
    const reasoningEffortKey = fieldKeys.find((k) => k === 'agents.codex.reasoningEffort');
    expect(reasoningEffortKey).toBe('agents.codex.reasoningEffort');
  });

  it('test_anchor_config_card_codex_reasoning_effort_has_options', () => {
    const config = buildCodexConfig();
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry({
      agentKinds: ['claude', 'codex'],
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
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry({
      agentKinds: ['claude', 'codex'],
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

    const cardResult = router.buildConfigCard();
    const card = cardResult.card;
    const json = JSON.stringify(card);

    expect(json).toContain('推理强度');
  });
});

// ---------------------------------------------------------------------------
// Config card effort follows model (Round 8)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 8 - Anchor（用户验收：卡片选模型后推理强度下拉按模型实际支持更新）
 *
 * Target: /config 卡片选定模型后，推理强度下拉必须立即变为该模型实际支持的档位
 *
 * Spec basis: 用户需求 + codex debug models 实测
 */

function extractSelectOptions(card: object, key: string): string[] {
  const values: string[] = [];
  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }
    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        const options = record.options as Array<{ value?: string; selected?: boolean }> | undefined;
        for (const opt of options ?? []) {
          if (typeof opt.value === 'string') values.push(opt.value);
        }
        return;
      }
    }
    for (const value of Object.values(record)) {
      traverse(value);
    }
  }
  traverse(card);
  return values;
}

function extractSelectCurrentValue(card: object, key: string): string | undefined {
  let current: string | undefined;
  function traverse(obj: unknown) {
    if (current !== undefined || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }
    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        current = record.initial_option as string | undefined;
        return;
      }
    }
    for (const value of Object.values(record)) {
      traverse(value);
    }
  }
  traverse(card);
  return current;
}

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-follows-'));
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
    return new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge({
        sendCard: vi.fn().mockResolvedValue(undefined),
        clearRunners: vi.fn(),
      }),
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude', 'codex'] }),
    });
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
