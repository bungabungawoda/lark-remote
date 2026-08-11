import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 11 - Anchor (P2-1, review finding → anchor)
 *
 * Target: 活动目录中某模型声明 `supported_reasoning_levels` 含 `minimal` 时，
 * getReasoningEffortOptions 必须保留该档位。codex 源码 ReasoningEffort 枚举
 * （codex-rs/protocol/src/openai_models.rs）支持 minimal（wire 值 "minimal"），
 * 我们当前 CODEX_REASONING_EFFORTS 缺它，Layer-2 过滤会把它丢弃。
 *
 * Importance: 未来任何目录（含自定义 models.json）声明 minimal 时，卡片会静默
 * 隐藏一个 codex 真实支持的档位——过滤集合必须与 codex 枚举对齐。
 *
 * Spec basis: P2-1（review 发现）+ codex ReasoningEffort 枚举。
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

/** 活动目录 fixture：deepseek 模型声明 minimal + low/high/max */
const ACTIVE_CATALOG_JSON = makeCatalog([
  makeModel(
    'deepseek-v4-flash',
    [{ effort: 'minimal' }, { effort: 'low' }, { effort: 'high' }, { effort: 'max' }],
    { default_reasoning_level: 'high', description: 'Latest frontier agentic coding model.' },
  ),
]);

describe('codex catalog minimal reasoning effort - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-minimal-'));
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

  it('test_anchor_catalog_minimal_reasoning_effort_is_not_filtered_out', () => {
    const options = getReasoningEffortOptions('deepseek-v4-flash');
    // codex 枚举支持 minimal，目录声明后必须保留（顺序保持目录声明顺序）
    expect(options).toContain('minimal');
    expect(options).toEqual(['minimal', 'low', 'high', 'max']);
  });
});
