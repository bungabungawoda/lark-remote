import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mockLogger } from '../../lib/logger-mock.js';

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

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

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
vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

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
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-a1-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json').replaceAll('\\', '/')}"`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), ACTIVE_CATALOG_JSON);
    process.env.CODEX_HOME = tmpDir;
    mockSpawnSync.mockImplementation((_binary: string, args: string[]) => {
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
    const options = getReasoningEffortOptions('deepseek-v4-flash');
    expect(options).toEqual(['low', 'high', 'max']);

    // 模型来源必须是 `codex debug models`（无 --bundled）
    const calls = mockSpawnSync.mock.calls as Array<[string, string[]]>;
    const catalogCall = calls.find(([, args]) => args[0] === 'debug' && args[1] === 'models');
    expect(catalogCall).toBeTruthy();
    expect(catalogCall![1]).not.toContain('--bundled');
  });
});
