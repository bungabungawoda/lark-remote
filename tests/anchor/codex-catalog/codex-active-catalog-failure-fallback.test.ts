import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 5 - Anchor (A5 修订版)
 *
 * Target: catalog 模式下 `codex debug models`（活动目录）失败/为空时：
 *   1. loadCodexConfig 不抛异常、不崩溃；
 *   2. 每个 provider 的模型列表回退 [currentModel]（config.toml 当前 model）；
 *   3. 禁止泄漏 FALLBACK_MODELS（o3/gpt-4.x/claude 静态列表）与内置目录模型
 *      （gpt-5.x）——它们不在活动目录，选中即失败。
 *
 * Importance: 活动目录命令失败是真实场景（models.json 缺字段/codex 升级/路径失效）。
 * 若回退到 bundled/FALLBACK，卡片会把不存在于活动目录的模型重新塞进下拉，
 * 用户选中后 run 必然失败——这正是本修复要消灭的 openai+内置模型 bug 的变体。
 *
 * Spec basis: A5（2026-07-31 orchestrator 修订）——catalog 模式唯一保真的模型是
 * config.toml 的 model；非 catalog 模式兜底行为不变。
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

/** 内置目录 fixture：若代码误用 bundled 作为 catalog 模式回退，会被断言抓住 */
const BUNDLED_JSON = makeCatalog([
  makeModel('gpt-5.6-sol', [{ effort: 'low' }], {
    default_reasoning_level: 'low',
    description: 'Latest frontier agentic coding model.',
  }),
]);

describe('codex active catalog failure fallback - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-a5-'));
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
    process.env.CODEX_HOME = tmpDir;
    // 活动目录命令（无 --bundled）直接抛错；bundled 命令正常返回（用于证明不被用作回退）
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && args.includes('--bundled')) {
        return BUNDLED_JSON;
      }
      throw new Error('boom: codex debug models unavailable');
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

  it('test_anchor_catalog_mode_active_catalog_failure_falls_back_to_current_model_only', () => {
    // 不抛异常
    let cfg: ReturnType<typeof loadCodexConfig>;
    expect(() => {
      cfg = loadCodexConfig({ binary: 'codex' });
    }).not.toThrow();

    // provider 列表 = 内置 openai + deepseek（codex 合并内置 provider）；无 anthropic
    expect(cfg!.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg!.providerNames).not.toContain('anthropic');

    // 模型列表精确回退 [currentModel]，不得混入 FALLBACK_MODELS/bundled
    expect(cfg!.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg!.modelOptions()).toEqual(['deepseek-v4-flash']);
    expect(cfg!.modelOptions('deepseek')).not.toContain('gpt-5.6-sol');
    expect(cfg!.modelOptions('deepseek')).not.toContain('o3');
    expect(cfg!.modelOptions('deepseek')).not.toContain('gpt-4.1');
  });
});
