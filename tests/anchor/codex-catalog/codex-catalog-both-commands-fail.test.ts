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
 *   3. 无 config.toml 时回退 FALLBACK_PROVIDERS + FALLBACK_MODELS。
 *   （catalog 模式的双命令失败回退 [currentModel] 由
 *   codex-active-catalog-failure-fallback.test.ts 更强的断言覆盖。）
 *
 * Importance: 卡片构建不能因 codex 二进制异常而炸掉；这是可靠性边界，也是
 * "非 catalog 行为不变"（A4）与"catalog 不泄漏 FALLBACK"（A5）的双重回归保护。
 *
 * Spec basis: P-both-fail（Batch 1 probe，2026-08-01 用户批准升 anchor）
 */

const { mockSpawnSync, mockLogger } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

import { loadCodexConfig, invalidateCodexBundledCache } from '../../../src/config/codex-config.js';

/** 与 src/config/codex-config.ts FALLBACK_MODELS 一致的契约 fixture */
const FALLBACK_MODELS = ['o3', 'o4-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'];
/** 与 src/config/codex-config.ts ANTHROPIC_FALLBACK_MODELS 一致的契约 fixture */
const ANTHROPIC_FALLBACK_MODELS = ['claude-sonnet-4-20250514', 'claude-opus-4-20250115'];

describe('codex both catalog commands fail - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-both-fail-'));
    process.env.CODEX_HOME = tmpDir;
    // 两个命令都失败
    mockSpawnSync.mockImplementation(() => {
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

  it('test_anchor_both_fail_explicit_anthropic_provider_uses_anthropic_fallback_models', () => {
    // A5a：claude 模型已移入独立的 ANTHROPIC_FALLBACK_MODELS（与 openai 兜底表隔离）。
    // 用户显式配置 [model_providers.anthropic] 且 catalog 两命令均失败时：
    // anthropic 下拉 = claude 兜底表；openai 下拉不得混入 claude 模型。
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "gpt-4.1"',
        '',
        '[model_providers.anthropic]',
        'name = "Anthropic"',
        'base_url = "https://api.example.com/v1"',
        'env_key = "ANTHROPIC_API_KEY"',
        '',
      ].join('\n'),
    );
    invalidateCodexBundledCache();

    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig();
    }).not.toThrow();

    expect(cfg!.providerNames).toContain('anthropic');
    expect(cfg!.modelOptions('anthropic')).toEqual(ANTHROPIC_FALLBACK_MODELS);
    expect(cfg!.modelOptions('openai')).toEqual(FALLBACK_MODELS);
    expect(cfg!.modelOptions('openai').some((m) => m.startsWith('claude-'))).toBe(false);
  });
});
