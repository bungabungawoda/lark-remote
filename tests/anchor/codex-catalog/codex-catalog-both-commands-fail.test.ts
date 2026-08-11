import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 9 - Anchor（P-both-fail 升 anchor，Batch 1 用户决策）
 *
 * Target: `codex debug models` 与 `codex debug models --bundled` **都失败**（二进制缺失/
 * 损坏/超时）时，loadCodexConfig 必须：
 *   1. 不抛异常、不崩溃；
 *   2. 非 catalog 模式回退 FALLBACK_MODELS/FALLBACK_PROVIDERS（legacy 兜底，A4 回归保护）；
 *   3. catalog 模式回退 [currentModel]（禁止 FALLBACK_MODELS 泄漏——与 A5 一致）；
 *   4. 无 config.toml 时回退 FALLBACK_PROVIDERS + FALLBACK_MODELS。
 *
 * Importance: 卡片构建不能因 codex 二进制异常而炸掉；这是可靠性边界，也是
 * "非 catalog 行为不变"（A4）与"catalog 不泄漏 FALLBACK"（A5）的双重回归保护。
 *
 * Spec basis: P-both-fail（Batch 1 probe，2026-08-01 用户批准升 anchor）
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

/** 与 src/config/codex-config.ts FALLBACK_MODELS 一致的契约 fixture */
const FALLBACK_MODELS = [
  'o3',
  'o4-mini',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250115',
];

describe('codex both catalog commands fail - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-both-fail-'));
    process.env.CODEX_HOME = tmpDir;
    // 两个命令都失败
    mockExecFileSync.mockImplementation(() => {
      throw new Error('boom: codex binary unavailable');
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

  it('test_anchor_both_fail_non_catalog_falls_back_to_fallback_models_and_providers', () => {
    // 非 catalog：config.toml 存在（含 providers）但两个命令都失败
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    invalidateCodexBundledCache();

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    // legacy 兜底：openai 模型列表 = FALLBACK_MODELS；自定义 provider = [currentModel]
    expect(cfg!.providerNames).toContain('openai');
    expect(cfg!.modelOptions('openai')).toEqual(FALLBACK_MODELS);
    expect(cfg!.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
  });

  it('test_anchor_both_fail_catalog_mode_falls_back_to_current_model_only', () => {
    // catalog 模式：config.toml 有 model_catalog_json + models.json 存在，但命令都失败
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
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), JSON.stringify({ models: [] }));
    invalidateCodexBundledCache();

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    // 不泄漏 FALLBACK_MODELS / bundled；provider 仍含内置 openai（codex 合并，review4 P2）
    expect(cfg!.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg!.providerNames).not.toContain('anthropic');
    expect(cfg!.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg!.modelOptions()).toEqual(['deepseek-v4-flash']);
    expect(cfg!.modelOptions('deepseek')).not.toContain('o3');
    expect(cfg!.modelOptions('deepseek')).not.toContain('gpt-4.1');
  });

  it('test_anchor_both_fail_no_config_file_falls_back_to_default_providers', () => {
    // 无 config.toml：纯 fallback 环境
    invalidateCodexBundledCache();

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    // anthropic 非 codex 内置 provider（P3-2 对齐），fallback 只含 openai
    expect(cfg!.providerNames).toEqual(['openai']);
    expect(cfg!.modelOptions('openai')).toEqual(FALLBACK_MODELS);
  });
});
