import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 1 - Anchor (Bug 模式, A1)
 *
 * Target: catalog 模式（config.toml 配置 model_catalog_json）下，推理强度选项
 * 必须来自活动目录 `codex debug models`（无 --bundled），而不是内置目录。
 *
 * Spec basis: 用户需求 + codex 源码 model-provider/src/provider.rs:334
 *   model_catalog_json 存在时 StaticModelsManager 只认活动目录，内置目录被整体替换。
 *   活动目录 deepseek-v4-flash 的 supported_reasoning_levels = [low, high, max]。
 *
 * 当前行为（RED）：getReasoningEffortOptions 只读 `codex debug models --bundled`，
 * deepseek-v4-flash 不在内置目录 → 返回兜底 ['low','medium','high','xhigh']，
 * 且调用参数含 --bundled。
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

import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import {
  getReasoningEffortOptions,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';

/** 活动目录 fixture：与真实 models.json 形状一致 */
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

describe('codex active catalog reasoning effort - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-a1-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), ACTIVE_CATALOG_JSON);
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return ACTIVE_CATALOG_JSON;
      }
      return JSON.stringify({ models: [] });
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

  it('test_anchor_catalog_mode_reasoning_effort_from_active_catalog', () => {
    // catalog 模式下 deepseek-v4-flash 的选项必须来自活动目录：low/high/max
    const options = getReasoningEffortOptions('deepseek-v4-flash', 'codex');
    expect(options).toEqual(['low', 'high', 'max']);

    // 模型来源必须是 `codex debug models`（无 --bundled）
    const calls = mockExecFileSync.mock.calls as Array<[string, string[]]>;
    const catalogCall = calls.find(([, args]) => args[0] === 'debug' && args[1] === 'models');
    expect(catalogCall).toBeTruthy();
    expect(catalogCall![1]).not.toContain('--bundled');
  });
});
