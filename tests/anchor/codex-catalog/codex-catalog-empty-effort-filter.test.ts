import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 16 - Anchor（codex-y review4 P3-9）
 *
 * P3-9: 解析器必须镜像 codex 对空串档位的严格性——`codex debug models` 的输出中
 *   `supported_reasoning_levels[].effort` 或 `default_reasoning_level` 为空串时，
 *   codex 硬错误（openai_models.rs:132 `"" => Err("reasoning_effort must not be empty")`）。
 *   lark 解析器对声明原样透传，但必须过滤空串，否则卡片会出现空档位选项、
 *   schema min(1) 会拒绝保存（潜在不一致）。
 *
 * Spec basis: codex-y review4 P3-9 + openai_models.rs ReasoningEffort::from_str。
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
  getReasoningEffortOptions,
  getDefaultReasoningEffort,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';

const CATALOG_WITH_EMPTY_EFFORT = makeCatalog([
  makeModel('empty-effort-model', [{ effort: 'low' }, { effort: '' }], {
    default_reasoning_level: '',
    description: 'model with empty effort declarations',
  }),
]);

describe('codex catalog empty effort filter - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-effort-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "empty-effort-model"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), CATALOG_WITH_EMPTY_EFFORT);
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return CATALOG_WITH_EMPTY_EFFORT;
      }
      return makeCatalog([makeModel('gpt-5.2', [{ effort: 'medium' }])]);
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

  it('test_anchor_empty_effort_and_default_are_filtered_out', () => {
    // 空串档位必须被过滤（codex 对空串是硬错误）
    expect(getReasoningEffortOptions('empty-effort-model', 'codex')).toEqual(['low']);
    // 空串 default 视为未声明（undefined），不进入卡片/配置
    expect(getDefaultReasoningEffort('empty-effort-model', 'codex')).toBeUndefined();
  });
});
