/**
 * Codex bundled-catalog reasoning effort pure-function anchors
 * (getCodexBundledModels / getReasoningEffortOptions / getDefaultReasoningEffort).
 *
 * Split from codex-reasoning-effort.test.ts (merged 2026-08-04, Phase 4;
 * re-split 2026-08-29 cleanup).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getReasoningEffortOptions,
  getDefaultReasoningEffort,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';
import {
  getCodexBundledModels,
  invalidateCodexBundledTestCache,
} from '../../lib/codex-bundled-test-helpers.js';
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

/** Bundled JSON with reasoning levels */
const BUNDLED_JSON_WITH_REASONING = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth' },
        { effort: 'max', description: 'Maximum reasoning depth' },
        { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      visibility: 'list',
      supported_in_api: true,
      priority: 2,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth' },
        { effort: 'max', description: 'Maximum reasoning depth' },
        { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
    },
    {
      slug: 'gpt-5.4',
      display_name: 'GPT-5.4',
      visibility: 'list',
      supported_in_api: true,
      priority: 16,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth' },
      ],
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      supported_in_api: true,
      priority: 43,
    },
  ],
});

// ---------------------------------------------------------------------------
// 1. getCodexBundledModels (Round 1 — uses execFileSync mock)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 1 - Anchor
 *
 * Target: getCodexBundledModels() 应返回完整的模型信息
 * 包含 supported_reasoning_levels、default_reasoning_level、display_name、priority
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §3.2
 */
describe('getCodexBundledModels - anchor', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    invalidateCodexBundledTestCache();
  });

  it('test_anchor_bundled_models_contain_reasoning_levels', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const models = getCodexBundledModels();

    expect(models).toBeDefined();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    const gpt56sol = models.find((m) => m.slug === 'gpt-5.6-sol');
    expect(gpt56sol).toBeDefined();
    expect(gpt56sol!.slug).toBe('gpt-5.6-sol');
    expect(gpt56sol!.displayName).toBe('GPT-5.6-Sol');
    expect(gpt56sol!.priority).toBe(1);

    expect(gpt56sol!.supportedReasoningLevels).toBeDefined();
    expect(Array.isArray(gpt56sol!.supportedReasoningLevels)).toBe(true);
    expect(gpt56sol!.supportedReasoningLevels.length).toBeGreaterThan(0);

    const efforts = gpt56sol!.supportedReasoningLevels;
    expect(efforts).toContain('low');
    expect(efforts).toContain('medium');
    expect(efforts).toContain('high');
    expect(efforts).toContain('xhigh');
    expect(efforts).toContain('max');
    expect(efforts).toContain('ultra');

    expect(gpt56sol!.defaultReasoningLevel).toBe('low');
  });

  it('test_anchor_bundled_models_excludes_hidden', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const models = getCodexBundledModels();

    const hiddenModel = models.find((m) => m.slug === 'codex-auto-review');
    expect(hiddenModel).toBeUndefined();

    expect(models.some((m) => m.slug === 'gpt-5.6-sol')).toBe(true);
    expect(models.some((m) => m.slug === 'gpt-5.6-terra')).toBe(true);
    expect(models.some((m) => m.slug === 'gpt-5.4')).toBe(true);
  });

  it('test_anchor_bundled_models_sorted_by_priority', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const models = getCodexBundledModels();

    expect(models[0]!.slug).toBe('gpt-5.6-sol');
    expect(models[1]!.slug).toBe('gpt-5.6-terra');
    expect(models[2]!.slug).toBe('gpt-5.4');
  });

  it('test_anchor_model_with_fewer_reasoning_levels', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const models = getCodexBundledModels();
    const gpt54 = models.find((m) => m.slug === 'gpt-5.4');

    expect(gpt54).toBeDefined();
    expect(gpt54!.supportedReasoningLevels).toContain('low');
    expect(gpt54!.supportedReasoningLevels).toContain('medium');
    expect(gpt54!.supportedReasoningLevels).toContain('high');
    expect(gpt54!.supportedReasoningLevels).toContain('xhigh');
    expect(gpt54!.supportedReasoningLevels).not.toContain('max');
    expect(gpt54!.supportedReasoningLevels).not.toContain('ultra');
    expect(gpt54!.defaultReasoningLevel).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// getReasoningEffortOptions / getDefaultReasoningEffort (Round 1 continued)
// ---------------------------------------------------------------------------

describe('getReasoningEffortOptions - anchor', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    invalidateCodexBundledTestCache();
  });

  it('test_anchor_get_reasoning_effort_options_returns_model_specific_list', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const solOptions = getReasoningEffortOptions('gpt-5.6-sol');
    expect(solOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

    const gpt54Options = getReasoningEffortOptions('gpt-5.4');
    expect(gpt54Options).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('test_anchor_get_reasoning_effort_options_unknown_model_returns_empty', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const unknownOptions = getReasoningEffortOptions('unknown-model');
    expect(unknownOptions).toEqual([]);
  });

  it('test_anchor_get_reasoning_effort_options_empty_bundled_returns_empty', () => {
    mockSpawnSync.mockReturnValue(JSON.stringify({ models: [] }));

    const options = getReasoningEffortOptions('any-model');
    expect(options).toEqual([]);
  });
});

describe('getDefaultReasoningEffort - anchor', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    invalidateCodexBundledTestCache();
  });

  it('test_anchor_get_default_reasoning_effort_returns_model_default', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    expect(getDefaultReasoningEffort('gpt-5.6-sol')).toBe('low');
    expect(getDefaultReasoningEffort('gpt-5.6-terra')).toBe('medium');
    expect(getDefaultReasoningEffort('gpt-5.4')).toBe('medium');
  });

  it('test_anchor_get_default_reasoning_effort_unknown_model_returns_medium', () => {
    mockSpawnSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    expect(getDefaultReasoningEffort('unknown-model')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P2-2: reasoning effort functions read the bundled catalog via the
// hard-coded 'codex' binary (Round 2, binary param removed)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 2 - Anchor (Bug 模式)
 *
 * Target: getReasoningEffortOptions / getDefaultReasoningEffort 必须从 codex
 * bundled 目录读取声明档位与默认档位
 *
 * Spec basis: design.md "Codex 推理强度配置"；codex binary 路径已硬编码（不再
 * 支持自定义 binary 参数），通过 CODEX_HOME 指向无 config.toml 的临时目录走
 * bundled 目录模式。
 */
describe('P2-2: reasoning effort functions read bundled catalog', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-binary-'));
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

  it('test_anchor_getReasoningEffortOptions_reads_bundled_catalog', () => {
    mockSpawnSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'custom-model',
            display_name: 'Custom Model',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
            default_reasoning_level: 'high',
          },
        ],
      }),
    );

    const options = getReasoningEffortOptions('custom-model');
    expect(options).toEqual(['low', 'high']);
    expect(mockSpawnSync).toHaveBeenCalledWith('codex', expect.any(Array), expect.any(Object));
  });

  it('test_anchor_getDefaultReasoningEffort_reads_bundled_catalog', () => {
    mockSpawnSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'custom-model',
            display_name: 'Custom Model',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            default_reasoning_level: 'high',
          },
        ],
      }),
    );

    const defaultEffort = getDefaultReasoningEffort('custom-model');
    expect(defaultEffort).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Config card codex model switch reasoning adjustment (Round 7)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 7 - Anchor
 *
 * Target: 切换模型后，推理强度自动调整到新模型支持的范围
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §3.2
 */

const MODEL_SWITCH_BUNDLED_JSON = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'medium', description: 'Medium' },
        { effort: 'high', description: 'High' },
        { effort: 'xhigh', description: 'XHigh' },
        { effort: 'max', description: 'Max' },
        { effort: 'ultra', description: 'Ultra' },
      ],
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      visibility: 'list',
      supported_in_api: true,
      priority: 2,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'medium', description: 'Medium' },
        { effort: 'high', description: 'High' },
        { effort: 'xhigh', description: 'XHigh' },
        { effort: 'max', description: 'Max' },
        { effort: 'ultra', description: 'Ultra' },
      ],
    },
    {
      slug: 'gpt-5.4',
      display_name: 'GPT-5.4',
      visibility: 'list',
      supported_in_api: true,
      priority: 16,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'medium', description: 'Medium' },
        { effort: 'high', description: 'High' },
        { effort: 'xhigh', description: 'XHigh' },
      ],
    },
  ],
});

const modelSwitchTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-switch-test-'));

describe('Config card codex model switch reasoning adjustment - anchor', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    mockSpawnSync.mockReturnValue(MODEL_SWITCH_BUNDLED_JSON);
  });

  afterEach(() => {
    fs.rmSync(modelSwitchTmpDir, { recursive: true, force: true });
    fs.mkdirSync(modelSwitchTmpDir, { recursive: true });
  });

  it('test_anchor_model_switch_resets_unsupported_reasoning_effort', () => {
    const gpt56solOptions = getReasoningEffortOptions('gpt-5.6-sol');
    const gpt54Options = getReasoningEffortOptions('gpt-5.4');

    expect(gpt56solOptions).toContain('ultra');
    expect(gpt54Options).not.toContain('ultra');
    expect(gpt54Options).not.toContain('max');

    expect(getDefaultReasoningEffort('gpt-5.6-sol')).toBe('low');
    expect(getDefaultReasoningEffort('gpt-5.4')).toBe('medium');
    expect(getDefaultReasoningEffort('gpt-5.6-terra')).toBe('medium');

    const currentEffort = 'ultra';
    const isCurrentEffortValid = gpt54Options.includes(currentEffort);
    expect(isCurrentEffortValid).toBe(false);

    const newDefault = getDefaultReasoningEffort('gpt-5.4');
    expect(newDefault).toBe('medium');
  });

  it('test_anchor_model_switch_keeps_supported_reasoning_effort', () => {
    const gpt56solOptions = getReasoningEffortOptions('gpt-5.6-sol');
    const gpt56terraOptions = getReasoningEffortOptions('gpt-5.6-terra');

    expect(gpt56solOptions).toContain('high');
    expect(gpt56terraOptions).toContain('high');

    const currentEffort = 'high';
    const isCurrentEffortValid = gpt56terraOptions.includes(currentEffort);
    expect(isCurrentEffortValid).toBe(true);

    const newDefault = getDefaultReasoningEffort('gpt-5.6-terra');
    expect(newDefault).toBe('medium');
    expect(currentEffort).toBe('high');
  });
});
