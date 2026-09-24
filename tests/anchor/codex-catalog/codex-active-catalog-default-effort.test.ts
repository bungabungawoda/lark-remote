import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mockLogger } from '../../lib/logger-mock.js';

/**
 * Red Agent - Round 4 - Anchor (A2)
 *
 * Target: catalog 模式下 getDefaultReasoningEffort 必须从活动目录读 default_reasoning_level。
 * deepseek-v4-flash 活动目录声明 default_reasoning_level = high；内置目录不含该模型，
 * 旧实现回退硬编码 'medium'。
 *
 * Importance: 卡片"推理强度"默认值直接决定用户切模型后的起始档位。默认 medium 而
 * 模型只支持 low/high/max 时，用户看到/保存的档位不在模型契约内（codex 会静默钳制
 * 或子代理路径报错）。
 *
 * Spec basis: A2 —— getDefaultReasoningEffort 按 活动目录 → 内置目录 → 'medium' 解析。
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
  getDefaultReasoningEffort,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';

const ACTIVE_CATALOG_JSON = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    description: 'Latest frontier agentic coding model.',
  }),
]);

/** 内置目录 fixture：不含 deepseek-v4-flash；若代码误用 bundled 会落到 'medium' */
const BUNDLED_JSON = makeCatalog([
  makeModel('gpt-5.6-sol', [{ effort: 'low' }], {
    default_reasoning_level: 'low',
    description: 'Latest frontier agentic coding model.',
  }),
]);

describe('codex active catalog default reasoning effort - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-a2-'));
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

  it('test_anchor_catalog_mode_default_reasoning_effort_from_active_catalog', () => {
    // catalog 模式下默认档位必须来自活动目录的 default_reasoning_level（high）
    expect(getDefaultReasoningEffort('deepseek-v4-flash')).toBe('high');

    // 数据源必须是 `codex debug models`（无 --bundled）
    const calls = mockSpawnSync.mock.calls as Array<[string, string[]]>;
    const catalogCall = calls.find(([, args]) => args[0] === 'debug' && args[1] === 'models');
    expect(catalogCall).toBeTruthy();
    expect(catalogCall![1]).not.toContain('--bundled');
  });
});
