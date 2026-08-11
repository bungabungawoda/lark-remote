import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 14 - Anchor（codex-y review P1-1/P1-2/P2-3/P2-5 回归锁定）
 *
 * Target:
 *   P1-1: model_catalog_json **声明即 catalog 模式**（文件缺失也按 catalog 处理，
 *     命令失败 → 回退 [currentModel]，不得回退 bundled/FALLBACK）。
 *   P1-2: catalog 模式 + 命令失败 + config 无 model 键 → 模型列表为空（不得虚构 'o3'）。
 *   P2-3: catalog 模式无 [model_providers.*] 时 currentProvider 不得虚构 'openai'。
 *   P2-5: 目录声明的自定义档位（如 'fast'）必须透传进卡片选项与 schema。
 *
 * Importance: codex 运行时对"已配置但缺失"的目录是硬错误（load_model_catalog ?），
 * 不会回退内置目录；'o3'/'openai' 是 legacy 假值；自定义档位是 codex Custom(String)
 * 的合法值。四条都是 codex-y review 提出的边界缺陷。
 *
 * Spec basis: codex-y review findings P1-1/P1-2/P2-3/P2-5 + codex 源码。
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

import {
  isCodexCatalogMode,
  loadCodexConfig,
  getReasoningEffortOptions,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';
import { CodexConfigSchema } from '../../../src/config/index.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';

const CUSTOM_CATALOG_JSON = makeCatalog([
  makeModel(
    'deepseek-v4-flash',
    [{ effort: 'fast' }, { effort: 'low' }, { effort: 'high' }, { effort: 'max' }],
    { default_reasoning_level: 'high' },
  ),
]);

describe('codex catalog review fixes - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-fixes-'));
    process.env.CODEX_HOME = tmpDir;
    // 默认：活动目录命令失败，bundled 可用（用于证明不被回退）
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && args.includes('--bundled')) {
        return makeCatalog([makeModel('gpt-5.6-sol', [{ effort: 'low' }])]);
      }
      throw new Error('boom: active catalog unavailable');
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

  it('test_anchor_p1_1_declared_but_missing_catalog_stays_in_catalog_mode', () => {
    // 声明了 model_catalog_json 但文件不存在 → 仍是 catalog 模式（codex 语义：硬错误不回落）
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(tmpDir, 'missing.json')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    invalidateCodexBundledCache();

    expect(isCodexCatalogMode()).toBe(true);

    const cfg = loadCodexConfig();
    // 活动目录命令失败 → 回退 [currentModel]，不得泄漏 bundled gpt-5.6-sol / FALLBACK
    // provider 列表 = 内置 openai + deepseek（codex 合并内置 provider，review4 P2）
    expect(cfg.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg.modelOptions('deepseek')).not.toContain('gpt-5.6-sol');
    expect(cfg.modelOptions('deepseek')).not.toContain('o3');
  });

  it('test_anchor_p1_2_catalog_failure_without_model_key_does_not_invent_o3', () => {
    // catalog 模式 + 命令失败 + config 无 model 键 → 模型列表为空，不虚构 'o3'
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(tmpDir, 'missing.json')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    invalidateCodexBundledCache();

    const cfg = loadCodexConfig();
    expect(cfg.modelOptions('deepseek')).toEqual([]);
    expect(cfg.modelOptions()).toEqual([]);
    expect(cfg.modelOptions('deepseek')).not.toContain('o3');
  });

  it('test_anchor_p2_3_catalog_without_providers_defaults_to_builtin_openai', () => {
    // catalog 模式 + 无 [model_providers.*] + 无 model_provider → providerNames 只含
    // 内置 openai、currentProvider 默认 "openai"（codex mod.rs:3659 unwrap_or("openai")；
    // review4 P2 修订 round14 P2-3 的"不虚构 openai"——codex 始终合并内置 provider）
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        `model_catalog_json = "${path.join(tmpDir, 'missing.json')}"`,
        '',
      ].join('\n'),
    );
    invalidateCodexBundledCache();

    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.currentProvider).toBe('openai');
  });

  it('test_anchor_p2_5_custom_reasoning_effort_passthrough', () => {
    // 目录声明自定义档位 'fast' → 卡片选项与 schema 都必须接受（codex Custom(String)）
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), CUSTOM_CATALOG_JSON);
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return CUSTOM_CATALOG_JSON;
      }
      throw new Error('n/a');
    });
    invalidateCodexBundledCache();

    expect(getReasoningEffortOptions('deepseek-v4-flash')).toEqual(['fast', 'low', 'high', 'max']);

    const parsed = CodexConfigSchema.safeParse({
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      reasoningEffort: 'fast',
    });
    expect(parsed.success).toBe(true);
  });
});
