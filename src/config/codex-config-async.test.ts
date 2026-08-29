import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// 完整的 node:child_process mock —— 同时提供 execFileSync（同步路径）与 execFile
// （异步路径），因为生产模块两者都 import。测试不在模块顶层触发真实 codex。
const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn();
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('node:child_process', () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
  execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

import {
  loadCodexCatalogModelsAsync,
  warmCodexCatalogCache,
  getCodexCatalogModels,
  invalidateCodexBundledCache,
  _clearCodexCatalogInFlightForTest,
} from './codex-config.js';

const codexHome = path.join(os.tmpdir(), 'lark-codex-async-' + Date.now());

/** 无 config.toml → bundled 模式（execFile 用 --bundled）。 */
const BUNDLED_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 1 },
    { slug: 'gpt-5.6-terra', visibility: 'list', supported_in_api: true, priority: 2 },
  ],
});

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExecFile.mockReset();
  mockLogger.warn.mockReset();
  invalidateCodexBundledCache();
  _clearCodexCatalogInFlightForTest();
});

describe('codex catalog async loader', () => {
  it('loadCodexCatalogModelsAsync populates the shared cache so sync getCodexCatalogModels reuses it without spawning', async () => {
    mockExecFile.mockImplementation((_f, _a, _o, cb) => cb(null, BUNDLED_JSON, ''));

    const models = await loadCodexCatalogModelsAsync(codexHome);

    expect(models.length).toBeGreaterThan(0);
    // 同步路径现在读到温缓存 —— 绝不能再 execFileSync
    expect(getCodexCatalogModels(codexHome)).toEqual(models);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent async loads via an in-flight promise (single execFile)', async () => {
    // 永不 resolve（不调用 cb），让两个并发调用都停留在 in-flight
    mockExecFile.mockImplementation(() => {
      /* noop */
    });

    const p1 = loadCodexCatalogModelsAsync(codexHome);
    const p2 = loadCodexCatalogModelsAsync(codexHome);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    // 清理：pending promise 不影响测试
    void p1;
    void p2;
  });

  it('sync getCodexCatalogModels returns fallback [] without blocking while an async load is in flight', async () => {
    mockExecFile.mockImplementation(() => {
      /* noop, 保持 in-flight */
    });

    void loadCodexCatalogModelsAsync(codexHome); // 启动后台加载
    await Promise.resolve();

    expect(getCodexCatalogModels(codexHome)).toEqual([]);
    // 关键：in-flight 期间同步路径不得阻塞/重复 spawn
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('on execFile error sets negative cache; sync getCodexCatalogModels returns [] without re-spawning within TTL', async () => {
    mockExecFile.mockImplementation((_f, _a, _o, cb) => cb(new Error('spawn ENOENT')));

    await loadCodexCatalogModelsAsync(codexHome);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(getCodexCatalogModels(codexHome)).toEqual([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('warmCodexCatalogCache populates cache fire-and-forget', async () => {
    mockExecFile.mockImplementation((_f, _a, _o, cb) => cb(null, BUNDLED_JSON, ''));

    warmCodexCatalogCache(codexHome);
    // 等后台加载完成
    await new Promise((r) => setTimeout(r, 20));

    expect(getCodexCatalogModels(codexHome).length).toBeGreaterThan(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
