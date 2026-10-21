/**
 * codex catalog 配置层契约：catalog 模式判定、模型/provider 列表来源、
 * 双命令失败回退、缓存新鲜度、相对路径、默认/自定义推理档位。
 *
 * 合并自 codex-catalog-fixes / empty-effort-filter / minimal-effort /
 * reasoning-effort / provider / both-commands-fail / cache-freshness /
 * relative-path / active-catalog-default-effort / active-catalog-empty-providers /
 * active-catalog-failure-fallback / fallback-align-codex。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mockLogger } from '../../lib/logger-mock.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import { CodexConfigSchema } from '../../../src/config/index.js';
import {
  getCodexCatalogModels,
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  invalidateCodexBundledCache,
  isCodexCatalogMode,
  loadCodexConfig,
} from '../../../src/config/codex-config.js';

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('../../../src/platform/spawn.js', async () => ({
  ...(await import('../../lib/spawn-mock.js')).spawnModuleMock(mockSpawnSync),
}));
vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

// ── fixtures（按用途命名，避免不同文件同名不同值） ────────────────────
const CUSTOM_CATALOG = makeCatalog([
  makeModel(
    'deepseek-v4-flash',
    [{ effort: 'fast' }, { effort: 'low' }, { effort: 'high' }, { effort: 'max' }],
    { default_reasoning_level: 'high' },
  ),
]);

const EMPTY_EFFORT_CATALOG = makeCatalog([
  makeModel('empty-effort-model', [{ effort: 'low' }, { effort: '' }], {
    default_reasoning_level: '',
  }),
]);

const MINIMAL_CATALOG = makeCatalog([
  makeModel(
    'deepseek-v4-flash',
    [{ effort: 'minimal' }, { effort: 'low' }, { effort: 'high' }, { effort: 'max' }],
    { default_reasoning_level: 'high' },
  ),
]);

const DEEPSEEK_3LEVEL_CATALOG = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
  }),
  makeModel('deepseek-v4-pro', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    priority: 2,
  }),
]);

const DEFAULT_EFFORT_CATALOG = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
  }),
]);

const EMPTY_PROVIDERS_CATALOG = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }], { default_reasoning_level: 'high' }),
  makeModel('deepseek-v4-pro', [{ effort: 'low' }], {
    default_reasoning_level: 'high',
    priority: 2,
  }),
]);

/** 内置目录 fixture：gpt-5.6-sol 优先，gpt-5.4 次之。 */
const BUNDLED_JSON = makeCatalog([
  makeModel('gpt-5.6-sol', [{ effort: 'low' }], { default_reasoning_level: 'low' }),
  makeModel('gpt-5.4', [{ effort: 'medium' }], {
    default_reasoning_level: 'medium',
    priority: 16,
  }),
]);

/** 与 src/config/codex-config.ts FALLBACK_MODELS 一致的契约 fixture */
const FALLBACK_MODELS = ['o3', 'o4-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'];
/** 与 src/config/codex-config.ts ANTHROPIC_FALLBACK_MODELS 一致的契约 fixture */
const ANTHROPIC_FALLBACK_MODELS = ['claude-sonnet-4-20250514', 'claude-opus-4-20250115'];

/**
 * 镜像真实 codex：`debug models --bundled` 返回内置目录；活动目录命令按
 * config.toml 的 model_catalog_json 读文件（声明但文件缺失 → 硬错误）。
 */
function catalogAwareMock(bundled: string) {
  return (_binary: string, args: string[]) => {
    if (args.includes('--bundled')) return bundled;
    const home = process.env.CODEX_HOME;
    if (home) {
      const cfgPath = path.join(home, 'config.toml');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const m = raw.match(/model_catalog_json\s*=\s*"([^"]+)"/);
        if (m) {
          const catalogPath = path.isAbsolute(m[1]) ? m[1] : path.join(home, m[1]);
          if (fs.existsSync(catalogPath)) return fs.readFileSync(catalogPath, 'utf-8');
          throw new Error('boom: catalog file missing');
        }
        // 非法/空串声明：codex 视为硬错误，不回退内置目录。
        if (raw.includes('model_catalog_json')) {
          throw new Error('boom: invalid catalog declaration');
        }
      }
    }
    return bundled;
  };
}

let tmpDir: string;
let oldCodexHome: string | undefined;

beforeEach(() => {
  mockSpawnSync.mockReset();
  mockLogger.warn.mockReset();
  invalidateCodexBundledCache();
  oldCodexHome = process.env.CODEX_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-config-'));
  process.env.CODEX_HOME = tmpDir;
  mockSpawnSync.mockImplementation(catalogAwareMock(BUNDLED_JSON));
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

function writeConfig(lines: string[]): void {
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), lines.join('\n'));
  invalidateCodexBundledCache();
}

function writeModels(catalog: string): string {
  const modelsPath = path.join(tmpDir, 'models.json');
  fs.writeFileSync(modelsPath, catalog);
  return modelsPath.replaceAll('\\', '/');
}

describe('codex catalog config', () => {
  // ── catalog 修复 ──────────────────────────────────────────────────
  it('test_anchor_p1_1_declared_but_missing_catalog_stays_in_catalog_mode', () => {
    writeConfig([
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      `model_catalog_json = "${path.join(tmpDir, 'missing.json').replaceAll('\\', '/')}"`,
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'env_key = "DS_API_KEY"',
      '',
    ]);

    expect(isCodexCatalogMode()).toBe(true);

    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg.modelOptions('deepseek')).not.toContain('gpt-5.6-sol');
    expect(cfg.modelOptions('deepseek')).not.toContain('o3');
  });

  it('test_anchor_p1_2_catalog_failure_without_model_key_does_not_invent_o3', () => {
    writeConfig([
      'model_provider = "deepseek"',
      `model_catalog_json = "${path.join(tmpDir, 'missing.json').replaceAll('\\', '/')}"`,
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'env_key = "DS_API_KEY"',
      '',
    ]);

    const cfg = loadCodexConfig();
    expect(cfg.modelOptions('deepseek')).toEqual([]);
    expect(cfg.modelOptions()).toEqual([]);
    expect(cfg.modelOptions('deepseek')).not.toContain('o3');
  });

  it('test_anchor_p2_3_catalog_without_providers_defaults_to_builtin_openai', () => {
    writeConfig([
      'model = "deepseek-v4-flash"',
      `model_catalog_json = "${path.join(tmpDir, 'missing.json').replaceAll('\\', '/')}"`,
      '',
    ]);

    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.currentProvider).toBe('openai');
  });

  it('test_anchor_p2_5_custom_reasoning_effort_passthrough', () => {
    const modelsPath = path.join(tmpDir, 'models.json');
    writeConfig([
      'model = "deepseek-v4-flash"',
      `model_catalog_json = "${modelsPath.replaceAll('\\', '/')}"`,
      '',
    ]);
    fs.writeFileSync(modelsPath, CUSTOM_CATALOG);

    expect(getReasoningEffortOptions('deepseek-v4-flash')).toEqual(['fast', 'low', 'high', 'max']);

    const parsed = CodexConfigSchema.safeParse({
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      reasoningEffort: 'fast',
    });
    expect(parsed.success).toBe(true);
  });

  // ── 空串档位 / minimal / 活动目录来源 ─────────────────────────────
  it('test_anchor_empty_effort_and_default_are_filtered_out', () => {
    const modelsPath = writeModels(EMPTY_EFFORT_CATALOG);
    writeConfig([
      'model = "empty-effort-model"',
      'model_provider = "deepseek"',
      `model_catalog_json = "${modelsPath}"`,
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'env_key = "DS_API_KEY"',
      '',
    ]);

    expect(getReasoningEffortOptions('empty-effort-model')).toEqual(['low']);
    expect(getDefaultReasoningEffort('empty-effort-model')).toBeUndefined();
  });

  it('test_anchor_catalog_minimal_reasoning_effort_is_not_filtered_out', () => {
    const modelsPath = writeModels(MINIMAL_CATALOG);
    writeConfig(['model = "deepseek-v4-flash"', `model_catalog_json = "${modelsPath}"`, '']);

    const options = getReasoningEffortOptions('deepseek-v4-flash');
    expect(options).toEqual(['minimal', 'low', 'high', 'max']);
  });

  it('test_anchor_catalog_mode_reasoning_effort_from_active_catalog', () => {
    const modelsPath = writeModels(DEEPSEEK_3LEVEL_CATALOG);
    writeConfig(['model = "deepseek-v4-flash"', `model_catalog_json = "${modelsPath}"`, '']);

    expect(getReasoningEffortOptions('deepseek-v4-flash')).toEqual(['low', 'high', 'max']);

    const calls = mockSpawnSync.mock.calls as Array<[string, string[]]>;
    const catalogCall = calls.find(([, args]) => args[0] === 'debug' && args[1] === 'models');
    expect(catalogCall).toBeTruthy();
    expect(catalogCall![1]).not.toContain('--bundled');
  });

  it('test_anchor_catalog_mode_providers_merge_builtin_openai', () => {
    const modelsPath = writeModels(DEEPSEEK_3LEVEL_CATALOG);
    writeConfig([
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      `model_catalog_json = "${modelsPath}"`,
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'env_key = "DS_API_KEY"',
      '',
      '[model_providers.volcengine-coding-plan]',
      'name = "volcengine-coding-plan"',
      'env_key = "ARK_API_KEY"',
      '',
    ]);

    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai', 'deepseek', 'volcengine-coding-plan']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.providerModels['openai']).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.providerModels['deepseek']).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.modelOptions('openai')).not.toContain('gpt-5.6-sol');
    expect(cfg.currentProvider).toBe('deepseek');
    expect(cfg.currentModel).toBe('deepseek-v4-flash');

    const calls = mockSpawnSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args[0] === 'debug' && args[1] === 'models')).toBe(true);
    expect(calls.some(([, args]) => args.includes('--bundled'))).toBe(false);
  });

  // ── 双命令失败 / 活动目录失败 ────────────────────────────────────
  it('test_anchor_both_fail_non_catalog_falls_back_to_fallback_models_and_providers', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('boom: codex binary unavailable');
    });
    writeConfig([
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'env_key = "DS_API_KEY"',
      '',
    ]);

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    expect(cfg!.providerNames).toContain('openai');
    expect(cfg!.modelOptions('openai')).toEqual(FALLBACK_MODELS);
    expect(cfg!.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
  });

  it('test_anchor_both_fail_no_config_file_falls_back_to_default_providers', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('boom: codex binary unavailable');
    });

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    expect(cfg!.providerNames).toEqual(['openai']);
    expect(cfg!.modelOptions('openai')).toEqual(FALLBACK_MODELS);
  });

  it('test_anchor_both_fail_explicit_anthropic_provider_uses_anthropic_fallback_models', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('boom: codex binary unavailable');
    });
    writeConfig([
      'model = "gpt-4.1"',
      '',
      '[model_providers.anthropic]',
      'name = "Anthropic"',
      'base_url = "https://api.example.com/v1"',
      'env_key = "ANTHROPIC_API_KEY"',
      '',
    ]);

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    expect(cfg!.providerNames).toContain('anthropic');
    expect(cfg!.modelOptions('anthropic')).toEqual(ANTHROPIC_FALLBACK_MODELS);
    expect(cfg!.modelOptions('openai')).toEqual(FALLBACK_MODELS);
    expect(cfg!.modelOptions('openai').some((m) => m.startsWith('claude-'))).toBe(false);
  });

  it('test_anchor_catalog_mode_active_catalog_failure_falls_back_to_current_model_only', () => {
    mockSpawnSync.mockImplementation((_binary: string, args: string[]) => {
      if (args.includes('--bundled')) return BUNDLED_JSON;
      throw new Error('boom: codex debug models unavailable');
    });
    const modelsPath = writeModels(JSON.stringify({ models: [] }));
    writeConfig([
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      `model_catalog_json = "${modelsPath}"`,
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'env_key = "DS_API_KEY"',
      '',
    ]);

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    expect(cfg!.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg!.providerNames).not.toContain('anthropic');
    expect(cfg!.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg!.modelOptions()).toEqual(['deepseek-v4-flash']);
    expect(cfg!.modelOptions('deepseek')).not.toContain('gpt-5.6-sol');
    expect(cfg!.modelOptions('deepseek')).not.toContain('o3');
    expect(cfg!.modelOptions('deepseek')).not.toContain('gpt-4.1');
  });

  // ── 缓存新鲜度 / 相对路径 ─────────────────────────────────────────
  it('test_anchor_catalog_cache_invalidated_when_models_json_changes', () => {
    const modelsPath = path.join(tmpDir, 'models.json');
    fs.writeFileSync(
      modelsPath,
      makeCatalog([makeModel('deepseek-v4-flash', [{ effort: 'low' }])]),
    );
    writeConfig([
      'model = "deepseek-v4-flash"',
      `model_catalog_json = "${modelsPath.replaceAll('\\', '/')}"`,
      '',
    ]);
    const t1 = new Date('2026-08-01T00:00:00Z');
    const t2 = new Date('2026-08-01T00:01:00Z');
    fs.utimesSync(modelsPath, t1, t1);

    const first = getCodexCatalogModels();
    expect(first.map((m) => m.slug)).toEqual(['deepseek-v4-flash']);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);

    fs.writeFileSync(modelsPath, makeCatalog([makeModel('deepseek-v4-pro', [{ effort: 'low' }])]));
    fs.utimesSync(modelsPath, t2, t2);
    const second = getCodexCatalogModels();
    expect(second.map((m) => m.slug)).toEqual(['deepseek-v4-pro']);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('test_anchor_relative_model_catalog_json_resolved_against_config_dir', () => {
    writeConfig(['model = "deepseek-v4-flash"', 'model_catalog_json = "models.json"', '']);
    fs.writeFileSync(path.join(tmpDir, 'models.json'), JSON.stringify({ models: [] }));

    expect(isCodexCatalogMode()).toBe(true);
  });

  // ── 默认档位 / 空 provider / fallback ─────────────────────────────
  it('test_anchor_catalog_mode_default_reasoning_effort_from_active_catalog', () => {
    const modelsPath = writeModels(DEFAULT_EFFORT_CATALOG);
    writeConfig(['model = "deepseek-v4-flash"', `model_catalog_json = "${modelsPath}"`, '']);

    expect(getDefaultReasoningEffort('deepseek-v4-flash')).toBe('high');

    const calls = mockSpawnSync.mock.calls as Array<[string, string[]]>;
    const catalogCall = calls.find(([, args]) => args[0] === 'debug' && args[1] === 'models');
    expect(catalogCall).toBeTruthy();
    expect(catalogCall![1]).not.toContain('--bundled');
  });

  it('test_anchor_catalog_mode_without_providers_keeps_builtin_openai_only', () => {
    const modelsPath = writeModels(EMPTY_PROVIDERS_CATALOG);
    writeConfig([
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      `model_catalog_json = "${modelsPath}"`,
      '',
    ]);

    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.currentProvider).toBe('deepseek');
    expect(cfg.modelOptions('openai')).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.modelOptions()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.modelOptions()).not.toContain('o3');
    expect(cfg.modelOptions()).not.toContain('gpt-4.1');
    expect(cfg.modelOptions()).not.toContain('gpt-5.6-sol');
  });

  it('test_anchor_fallback_providers_exclude_anthropic_without_config', () => {
    const cfg = loadCodexConfig({ codexHome: path.join(tmpDir, 'no-home') });
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.providerNames).toEqual(['openai']);
  });

  it('test_anchor_default_model_is_first_available_not_o3', () => {
    writeConfig(['model_provider = "openai"\n']);

    const cfg = loadCodexConfig();
    expect(cfg.currentModel).toBe('gpt-5.6-sol');
    expect(cfg.modelOptions('openai')[0]).toBe('gpt-5.6-sol');
  });
});
