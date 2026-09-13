import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

// 生产代码异步路径经 platform/spawn 的 spawnProcess（cross-spawn）拉起 codex，
// mock 该 seam：spawnProcess 返回 fake ChildProcess（stdout/stderr 流 + close 事件）；
// 同步路径的 spawnProcessSync 在本文件只用于断言「绝不被调用」。
const mockSpawnProcess = vi.fn();
const mockSpawnSync = vi.fn();
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../platform/spawn.js', () => ({
  spawnProcess: (...args: any[]) => mockSpawnProcess(...args),
  spawnProcessSync: (...args: any[]) => mockSpawnSync(...args),
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

/** 无 config.toml → bundled 模式（spawn 用 --bundled）。 */
const BUNDLED_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 1 },
    { slug: 'gpt-5.6-terra', visibility: 'list', supported_in_api: true, priority: 2 },
  ],
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  openChildren.push(child);
  return child;
}

/** 让 fake child 异步发出成功结果（微任务时序，处理已挂上） */
function emitSuccess(child: FakeChild, out: string): void {
  queueMicrotask(() => {
    child.stdout.emit('data', out);
    child.emit('close', 0);
  });
}

/** 本用例创建、尚未 settle 的 fake child（afterEach 统一收尾，避免悬挂 8s 定时器） */
const openChildren: FakeChild[] = [];

beforeEach(() => {
  mockSpawnProcess.mockReset();
  mockSpawnSync.mockReset();
  mockLogger.warn.mockReset();
  invalidateCodexBundledCache();
  _clearCodexCatalogInFlightForTest();
});

afterEach(() => {
  // settle 所有未关闭的 fake child：杀掉 runCodexCommandAsync 的超时定时器，
  // 并让 pending promise 落地，不给事件循环留尾巴
  for (const child of openChildren.splice(0)) {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.emit('error', new Error('test teardown settle'));
  }
});

describe('codex catalog async loader', () => {
  it('loadCodexCatalogModelsAsync populates the shared cache so sync getCodexCatalogModels reuses it without spawning', async () => {
    mockSpawnProcess.mockImplementation(() => {
      const child = makeChild();
      emitSuccess(child, BUNDLED_JSON);
      return child;
    });

    const models = await loadCodexCatalogModelsAsync(codexHome);

    expect(models.length).toBeGreaterThan(0);
    // 同步路径现在读到温缓存 —— 绝不能再 spawnProcessSync
    expect(getCodexCatalogModels(codexHome)).toEqual(models);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockSpawnProcess).toHaveBeenCalledTimes(1);
    expect(mockSpawnProcess).toHaveBeenCalledWith(
      'codex',
      ['debug', 'models', '--bundled'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('dedupes concurrent async loads via an in-flight promise (single spawn)', async () => {
    // child 永不 close，让两个并发调用都停留在 in-flight
    mockSpawnProcess.mockImplementation(() => makeChild());

    const p1 = loadCodexCatalogModelsAsync(codexHome);
    const p2 = loadCodexCatalogModelsAsync(codexHome);

    expect(mockSpawnProcess).toHaveBeenCalledTimes(1);
    // 清理：pending promise 由 afterEach 统一 settle
    void p1;
    void p2;
  });

  it('sync getCodexCatalogModels returns fallback [] without blocking while an async load is in flight', async () => {
    mockSpawnProcess.mockImplementation(() => makeChild());

    void loadCodexCatalogModelsAsync(codexHome); // 启动后台加载
    await Promise.resolve();

    expect(getCodexCatalogModels(codexHome)).toEqual([]);
    // 关键：in-flight 期间同步路径不得阻塞/重复 spawn
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('on spawn error sets negative cache; sync getCodexCatalogModels returns [] without re-spawning within TTL', async () => {
    mockSpawnProcess.mockImplementation(() => {
      const child = makeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    });

    await loadCodexCatalogModelsAsync(codexHome);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(getCodexCatalogModels(codexHome)).toEqual([]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('on non-zero exit sets negative cache (stderr surfaced in the error)', async () => {
    mockSpawnProcess.mockImplementation(() => {
      const child = makeChild();
      queueMicrotask(() => {
        child.stderr.emit('data', '系统找不到指定的路径');
        child.emit('close', 1);
      });
      return child;
    });

    await loadCodexCatalogModelsAsync(codexHome);

    expect(mockLogger.warn).toHaveBeenCalled();
    const warnMsg = String(mockLogger.warn.mock.calls[0]?.[0] ?? '');
    expect(warnMsg).toContain('codex exited 1');
    expect(warnMsg).toContain('系统找不到指定的路径');
    expect(getCodexCatalogModels(codexHome)).toEqual([]);
  });

  it('warmCodexCatalogCache populates cache fire-and-forget', async () => {
    mockSpawnProcess.mockImplementation(() => {
      const child = makeChild();
      emitSuccess(child, BUNDLED_JSON);
      return child;
    });

    warmCodexCatalogCache(codexHome);
    // 等后台加载完成
    await new Promise((r) => setTimeout(r, 20));

    expect(getCodexCatalogModels(codexHome).length).toBeGreaterThan(0);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
