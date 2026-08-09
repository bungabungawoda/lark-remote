import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 10 - Anchor (P2-2, review finding → anchor)
 *
 * Target: config.toml 的 `model_catalog_json` 用**相对路径**（如 "models.json"）时，
 * 必须按 codex 语义解析——codex `AbsolutePathBuf::resolve_path_against_base`
 * （codex-rs/utils/absolute-path/src/lib.rs）把相对路径解析到 config.toml 所在目录
 * （~/.codex），而不是进程 cwd。
 *
 * Importance: 相对路径是合法配置写法；解析错位会导致 isCodexCatalogMode 误判为非
 * catalog 模式，卡片退回 bundled 列表（openai+gpt-5.x）——正是本次要消灭的 bug 家族。
 *
 * Spec basis: P2-2（review 发现）+ codex 源码 AbsolutePathBuf 语义。
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
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';

describe('codex catalog relative model_catalog_json path - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relative-'));
    process.env.CODEX_HOME = tmpDir;
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

  it('test_anchor_relative_model_catalog_json_resolved_against_config_dir', () => {
    // 相对路径 "models.json" 应与 config.toml 同目录（codex 语义）
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      ['model = "deepseek-v4-flash"', 'model_catalog_json = "models.json"', ''].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), JSON.stringify({ models: [] }));

    // codex 把相对路径解析到 ~/.codex/models.json（config 目录）→ 必须判定为 catalog 模式
    expect(isCodexCatalogMode()).toBe(true);
  });
});
