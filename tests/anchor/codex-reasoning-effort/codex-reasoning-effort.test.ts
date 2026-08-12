import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
/**
 * Merged anchor tests for codex reasoning effort (config/schema/argv/card)
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - codex-config-card-effort-follows-model.test.ts
 *   - codex-config-card-reasoning-effort.test.ts
 *   - codex-config-schema-reasoning-effort.test.ts
 *   - codex-exec-argv-reasoning-effort.test.ts
 *   - codex-exec-runner-reasoning-effort.test.ts
 *   - codex-model-switch-reasoning-adjustment.test.ts
 *   - codex-reasoning-effort-schema.test.ts
 *   - codex-reasoning-effort.test.ts
 *
 * Note: codex-reasoning-effort-runtime.test.ts is NOT merged here because it
 * uses vi.mock('node:child_process') with spawn (not execFileSync), which is
 * incompatible with the shared execFileSync mock below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { CodexConfigSchema } from '../../../src/config/index.js';
import { buildCodexExecArgs } from '../../../src/runner/codex/argv.js';
import type { AgentSessionReader } from '../../../src/runner/types.js';

interface CodexExecRunnerOptions {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  stopGraceMs?: number;
  pidDir?: string;
  workspace?: string;
  spawnHeartbeatMs?: number;
  sessionReader: AgentSessionReader;
}
import {
  getReasoningEffortOptions,
  getDefaultReasoningEffort,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';
import {
  getCodexBundledModels,
  invalidateCodexBundledTestCache,
} from '../../../src/config/codex-bundled-test-helpers.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Shared mock setup (execFileSync + logger)
// Used by describe blocks that call getCodexBundledModels / config card
// No-mock describe blocks (schema/argv/options) simply don't trigger these mocks.
// ---------------------------------------------------------------------------

const { mockExecFileSync, mockLogger } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Bundled JSON with reasoning levels — used by multiple describe blocks */
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

/** Bundled fixture using codex-catalog-fixture helpers */
const BUNDLED_FIXTURE = makeCatalog([
  makeModel(
    'gpt-5.6-sol',
    [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    { default_reasoning_level: 'low' },
  ),
]);

// ---------------------------------------------------------------------------
// Shared stub factories (for config card tests)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. CodexConfigSchema reasoningEffort (Round 3 — no mocks needed)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 3 - Anchor
 *
 * Target: CodexConfigSchema 应包含 reasoningEffort 字段（z.string().optional()）
 *
 * Importance: 这是将 reasoningEffort 存储到 config.yaml 的必要步骤。
 * 只有在 schema 中声明了该字段，config 卡片才能保存和读取该值。
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §4.2
 */
describe('CodexConfigSchema reasoningEffort - anchor', () => {
  it('test_anchor_codex_config_schema_has_reasoning_effort', () => {
    const configWithEffort = {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      stopGraceMs: 5000,
    };

    const result = CodexConfigSchema.safeParse(configWithEffort);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningEffort).toBe('high');
    }
  });

  it('test_anchor_codex_config_schema_reasoning_effort_optional', () => {
    const configWithoutEffort = {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      stopGraceMs: 5000,
    };

    const result = CodexConfigSchema.safeParse(configWithoutEffort);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningEffort).toBeUndefined();
    }
  });

  it('test_anchor_codex_config_schema_reasoning_effort_accepts_valid_values', () => {
    const validValues = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

    for (const value of validValues) {
      const config = {
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: value,
        stopGraceMs: 5000,
      };

      const result = CodexConfigSchema.safeParse(config);
      expect(result.success, `Failed for value: ${value}`).toBe(true);
      if (result.success) {
        expect(result.data.reasoningEffort).toBe(value);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P3-1: CodexConfigSchema reasoningEffort validation (custom values)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 3 - Anchor (Bug 模式)
 *
 * Target: CodexConfigSchema.reasoningEffort 接受标准档位与自定义档位。
 *   codex ReasoningEffort 除标准档位外还有 Custom(String)——目录声明什么档位就存什么，
 *   收紧为 enum 会拒绝目录声明的自定义档位（P2-5）。
 *
 * Importance: 卡片档位下拉按模型 supported_reasoning_levels 原样透传；
 *   自定义档位存不进 config.yaml 会导致"选了但保存失败"。
 *
 * Spec basis: P2-5（codex-y review）+ codex-rs/protocol/src/openai_models.rs
 *   ReasoningEffort::Custom。
 */
describe('P3-1: CodexConfigSchema reasoningEffort validation', () => {
  it('test_anchor_codex_reasoningEffort_accepts_valid_values', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const result = CodexConfigSchema.safeParse({
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: effort,
      });
      expect(result.success, `effort="${effort}" should be valid`).toBe(true);
    }
  });

  it('test_anchor_codex_reasoningEffort_optional', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
    });
    expect(result.success).toBe(true);
  });

  it('test_anchor_codex_reasoningEffort_accepts_custom_value', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'super-extreme',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. buildCodexExecArgs reasoningEffort (Round 4 — no mocks needed)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 4 - Anchor
 *
 * Target: buildCodexExecArgs 应支持 reasoningEffort 参数
 * 并生成正确的 -c 'model_reasoning_effort="xxx"' 参数
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §4.3
 */
describe('buildCodexExecArgs reasoningEffort - anchor', () => {
  it('test_anchor_build_codex_exec_args_includes_reasoning_effort', () => {
    const args = buildCodexExecArgs({
      cwd: '/test/path',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });

    const hasReasoningEffort = args.some((arg) => arg.includes('model_reasoning_effort="high"'));
    expect(hasReasoningEffort).toBe(true);
  });

  it('test_anchor_build_codex_exec_args_without_reasoning_effort', () => {
    const args = buildCodexExecArgs({
      cwd: '/test/path',
      model: 'gpt-5.6-sol',
    });

    const hasReasoningEffort = args.some((arg) => arg.includes('model_reasoning_effort'));
    expect(hasReasoningEffort).toBe(false);
  });

  it('test_anchor_build_codex_exec_args_reasoning_effort_low', () => {
    const args = buildCodexExecArgs({
      cwd: '/test/path',
      model: 'gpt-5.4',
      reasoningEffort: 'low',
    });

    const hasReasoningEffort = args.some((arg) => arg.includes('model_reasoning_effort="low"'));
    expect(hasReasoningEffort).toBe(true);
  });

  it('test_anchor_build_codex_exec_args_reasoning_effort_ultra', () => {
    const args = buildCodexExecArgs({
      cwd: '/test/path',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });

    const hasReasoningEffort = args.some((arg) => arg.includes('model_reasoning_effort="ultra"'));
    expect(hasReasoningEffort).toBe(true);
  });

  it('test_anchor_build_codex_exec_args_resume_with_reasoning_effort', () => {
    const args = buildCodexExecArgs({
      cwd: '/test/path',
      threadId: 'thread-123',
      reasoningEffort: 'xhigh',
    });

    const hasReasoningEffort = args.some((arg) => arg.includes('model_reasoning_effort="xhigh"'));
    expect(hasReasoningEffort).toBe(true);

    expect(args).toContain('resume');
    expect(args).toContain('thread-123');
  });
});

// ---------------------------------------------------------------------------
// 5. CodexExecRunner reasoningEffort (Round 5 — no mocks needed, type check only)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 5 - Anchor
 *
 * Target: CodexExecRunner 应将 reasoningEffort 传递到 buildCodexExecArgs
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §4.4
 */
describe('CodexExecRunner reasoningEffort - anchor', () => {
  it('test_anchor_codex_runner_options_accepts_reasoning_effort', () => {
    const options: CodexExecRunnerOptions = {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      stopGraceMs: 5000,
      pidDir: '/tmp',
      sessionReader: {
        listSessions: async () => [],
        getNewestSession: async () => undefined,
        readSessionContent: async () => ({ events: [], displayTitle: '' }),
        isSessionActive: async () => false,
      } as any,
    };

    expect(options.reasoningEffort).toBe('high');
  });

  it('test_anchor_codex_runner_options_reasoning_effort_optional', () => {
    const options: CodexExecRunnerOptions = {
      model: 'gpt-5.6-sol',
      stopGraceMs: 5000,
      pidDir: '/tmp',
      sessionReader: {
        listSessions: async () => [],
        getNewestSession: async () => undefined,
        readSessionContent: async () => ({ events: [], displayTitle: '' }),
        isSessionActive: async () => false,
      } as any,
    };

    expect(options.reasoningEffort).toBeUndefined();
  });
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
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    invalidateCodexBundledTestCache();
  });

  it('test_anchor_bundled_models_contain_reasoning_levels', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

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
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const models = getCodexBundledModels();

    const hiddenModel = models.find((m) => m.slug === 'codex-auto-review');
    expect(hiddenModel).toBeUndefined();

    expect(models.some((m) => m.slug === 'gpt-5.6-sol')).toBe(true);
    expect(models.some((m) => m.slug === 'gpt-5.6-terra')).toBe(true);
    expect(models.some((m) => m.slug === 'gpt-5.4')).toBe(true);
  });

  it('test_anchor_bundled_models_sorted_by_priority', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const models = getCodexBundledModels();

    expect(models[0]!.slug).toBe('gpt-5.6-sol');
    expect(models[1]!.slug).toBe('gpt-5.6-terra');
    expect(models[2]!.slug).toBe('gpt-5.4');
  });

  it('test_anchor_model_with_fewer_reasoning_levels', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

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
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    invalidateCodexBundledTestCache();
  });

  it('test_anchor_get_reasoning_effort_options_returns_model_specific_list', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const solOptions = getReasoningEffortOptions('gpt-5.6-sol');
    expect(solOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

    const gpt54Options = getReasoningEffortOptions('gpt-5.4');
    expect(gpt54Options).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('test_anchor_get_reasoning_effort_options_unknown_model_returns_empty', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    const unknownOptions = getReasoningEffortOptions('unknown-model');
    expect(unknownOptions).toEqual([]);
  });

  it('test_anchor_get_reasoning_effort_options_empty_bundled_returns_empty', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ models: [] }));

    const options = getReasoningEffortOptions('any-model');
    expect(options).toEqual([]);
  });
});

describe('getDefaultReasoningEffort - anchor', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    invalidateCodexBundledTestCache();
  });

  it('test_anchor_get_default_reasoning_effort_returns_model_default', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

    expect(getDefaultReasoningEffort('gpt-5.6-sol')).toBe('low');
    expect(getDefaultReasoningEffort('gpt-5.6-terra')).toBe('medium');
    expect(getDefaultReasoningEffort('gpt-5.4')).toBe('medium');
  });

  it('test_anchor_get_default_reasoning_effort_unknown_model_returns_medium', () => {
    mockExecFileSync.mockReturnValue(BUNDLED_JSON_WITH_REASONING);

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
 * Spec basis: CLAUDE.md "Codex 推理强度配置"；codex binary 路径已硬编码（不再
 * 支持自定义 binary 参数），通过 CODEX_HOME 指向无 config.toml 的临时目录走
 * bundled 目录模式。
 */
describe('P2-2: reasoning effort functions read bundled catalog', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
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
    mockExecFileSync.mockReturnValue(
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
    expect(mockExecFileSync).toHaveBeenCalledWith('codex', expect.any(Array), expect.any(Object));
  });

  it('test_anchor_getDefaultReasoningEffort_reads_bundled_catalog', () => {
    mockExecFileSync.mockReturnValue(
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
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
}

describe('Config card codex reasoningEffort - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-card-test-'));
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
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

    const cardResult = (router as any).buildConfigCard();
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

    const cardResult = (router as any).buildConfigCard();
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

    const cardResult = (router as any).buildConfigCard();
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

type RouterInternals = {
  buildConfigCard: () => { card: object };
};

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
    output: { showThinking: true, showToolUse: true, showToolResult: true },
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
    mockExecFileSync.mockReset();
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
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && args.includes('--bundled')) {
        return BUNDLED_JSON;
      }
      return BUNDLED_JSON;
    });

    const router = makeRouter(buildCodexConfigForModel('gpt-5.6-sol', 'openai', 'ultra'));
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

    const card1 = (router as unknown as RouterInternals).buildConfigCard().card;
    const effort1 = extractSelectOptions(card1, 'agents.codex.reasoningEffort');
    expect(effort1).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effort1).toContain('medium');
    expect(extractSelectCurrentValue(card1, 'agents.codex.reasoningEffort')).toBe('ultra');

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'gpt-5.4' },
      ctx,
    );
    const card2 = (router as unknown as RouterInternals).buildConfigCard().card;
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
        `model_catalog_json = "${path.join(catalogHome, 'models.json')}"`,
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
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return ACTIVE_CATALOG_JSON;
      }
      return BUNDLED_JSON;
    });

    const router = makeRouter(buildCodexConfigForModel('deepseek-v4-flash', 'deepseek', 'high'));
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

    const card1 = (router as unknown as RouterInternals).buildConfigCard().card;
    expect(extractSelectOptions(card1, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'high',
      'max',
    ]);

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'deepseek-v4-pro' },
      ctx,
    );
    const card2 = (router as unknown as RouterInternals).buildConfigCard().card;
    expect(extractSelectOptions(card2, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(extractSelectCurrentValue(card2, 'agents.codex.reasoningEffort')).toBe('high');
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
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    mockExecFileSync.mockReturnValue(MODEL_SWITCH_BUNDLED_JSON);
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
