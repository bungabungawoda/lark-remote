import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 2 - Anchor (Bug 模式, A3)
 *
 * Target: catalog 模式下 provider 列表 = 内置 openai + config.toml `[model_providers.*]`
 * （对齐 codex merge_configured_model_providers(built_in_model_providers, cfg.model_providers)，
 * core/src/config/mod.rs:3655；anthropic 非内置 provider）；每个 provider 的模型列表=
 * 活动目录全部 slug（codex 运行时目录全局，provider 与模型无绑定）。
 *
 * Spec basis: codex-y review4 P2（catalog 模式不应丢弃内置 openai provider）+
 * core/src/config/mod.rs:3655-3661（合并内置 provider、model_provider 默认 "openai"）。
 * 模型列表仍只来自活动目录——openai+内置 gpt-5.x 的失效路径不因 provider 合并复活。
 */

const { mockExecFileSync, mockLogger } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

import { loadCodexConfig, invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';

/** 活动目录 fixture：只有 deepseek 两个模型 */
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

/** 内置目录 fixture：如果代码误用 bundled，能立刻被断言抓住 */
const BUNDLED_JSON = makeCatalog([
  makeModel('gpt-5.6-sol', [{ effort: 'low' }, { effort: 'high' }], {
    default_reasoning_level: 'low',
    description: 'Latest frontier agentic coding model.',
  }),
]);

describe('codex active catalog provider list - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-a3-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
        '[model_providers.volcengine-coding-plan]',
        'name = "volcengine-coding-plan"',
        'env_key = "ARK_API_KEY"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), ACTIVE_CATALOG_JSON);
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return ACTIVE_CATALOG_JSON;
      }
      return BUNDLED_JSON;
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

  it('test_anchor_catalog_mode_providers_merge_builtin_openai', () => {
    const cfg = loadCodexConfig();

    // provider 列表 = 内置 openai + [model_providers.*]；anthropic 非 codex 内置 provider
    expect(cfg.providerNames).toEqual(['openai', 'deepseek', 'volcengine-coding-plan']);
    expect(cfg.providerNames).not.toContain('anthropic');

    // 每个 provider（含内置 openai）的模型列表=活动目录全部 slug
    expect(cfg.providerModels['openai']).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.providerModels['deepseek']).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.providerModels['volcengine-coding-plan']).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
    // openai provider 的模型仍是活动目录模型，不得混入内置 bundled
    expect(cfg.modelOptions('openai')).not.toContain('gpt-5.6-sol');

    // 模型下拉不得混入内置 gpt 模型
    expect(cfg.modelOptions('deepseek')).not.toContain('gpt-5.6-sol');

    // 当前 provider/model 来自 config.toml
    expect(cfg.currentProvider).toBe('deepseek');
    expect(cfg.currentModel).toBe('deepseek-v4-flash');

    // 来源必须是 `codex debug models`（无 --bundled）
    const calls = mockExecFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args[0] === 'debug' && args[1] === 'models')).toBe(true);
    expect(calls.some(([, args]) => args.includes('--bundled'))).toBe(false);
  });
});
