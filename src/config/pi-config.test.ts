import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mockLogger } from '../../tests/lib/logger-mock.js';

// 生产代码经 platform/spawn（cross-spawn）拉起 pi，mock 该 seam：
// 同步路径返回表格字符串，异步路径返回 fake ChildProcess（stdout/stderr + close）。
const mockSpawnSync = vi.fn();
const mockSpawnProcess = vi.fn();

vi.mock('../platform/spawn.js', () => ({
  spawnProcessSync: (...args: unknown[]) => mockSpawnSync(...args),
  spawnProcess: (...args: unknown[]) => mockSpawnProcess(...args),
}));
vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

import {
  loadPiConfig,
  getPiModelOptions,
  loadPiListedModels,
  loadPiListedModelsAsync,
  warmPiListCache,
  parsePiListModels,
  _getModelsFilePath,
  _getAuthFilePath,
  _invalidatePiListCacheForTest,
} from './pi-config.js';

/** spawnProcessSync 成功返回形态 */
const syncOk = (stdout: string) => ({ status: 0, stdout, stderr: '' });

/** pi 的真实输出形状：六列定宽、两个空格分隔、末列有 padEnd 尾随空格。 */
const TABLE = [
  'provider    model            context  max-out  thinking  images',
  'deepseek    deepseek-flash   1M       384K     yes       yes   ',
  'deepseek    deepseek-v4-pro  1M       384K     yes       no    ',
  'minimax-cn  MiniMax-M3       1M       524.3K   yes       yes   ',
  'Volcano     glm-5.2          262.1K   16.4K    yes       no    ',
].join('\n');

/** 零模型时 pi 打印的提示文案（不是空输出） */
const NO_MODELS = 'No models available. Run /login to sign in to a provider.';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
}

/** 造一个 fake ChildProcess：下一个 tick 推出 stdout 并 close。 */
function fakeChild(stdout: string, code = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit('data', stdout);
    child.emit('close', code);
  });
  return child;
}

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-test-'));
  savedEnv = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = tmpDir;
  mockSpawnSync.mockReset();
  mockSpawnProcess.mockReset();
  mockLogger.warn.mockReset();
  _invalidatePiListCacheForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedEnv !== undefined) {
    process.env.PI_CONFIG_DIR = savedEnv;
  } else {
    delete process.env.PI_CONFIG_DIR;
  }
});

/** 写一份 models.json —— 只影响缓存键，不再决定选项内容。 */
function writeModelsJson(providers: Record<string, unknown>): void {
  const modelsPath = _getModelsFilePath();
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8');
}

describe('parsePiListModels', () => {
  it('表头跳过，只取 provider 与 model 两列', () => {
    expect(parsePiListModels(TABLE)).toEqual([
      { provider: 'deepseek', model: 'deepseek-flash' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      { provider: 'minimax-cn', model: 'MiniMax-M3' },
      { provider: 'Volcano', model: 'glm-5.2' },
    ]);
  });

  it('模型 id 里的 / 与 :thinking 后缀原样保留', () => {
    const out = parsePiListModels(
      [
        'provider  model                       context  max-out  thinking  images',
        'custom    team/model-a               1M       128K     yes       yes   ',
        'custom    vendor/GLM-5.2:high         1M       128K     yes       yes   ',
      ].join('\n'),
    );
    expect(out.map((m) => m.model)).toEqual(['team/model-a', 'vendor/GLM-5.2:high']);
  });

  it('零模型的提示文案解析为空清单', () => {
    expect(parsePiListModels(NO_MODELS)).toEqual([]);
  });

  it('空输出 / 无表头 / 列数不足的行都跳过，不把日志行当模型', () => {
    expect(parsePiListModels('')).toEqual([]);
    expect(parsePiListModels('Warning: something went wrong')).toEqual([]);
    expect(
      parsePiListModels(
        ['provider  model', 'deepseek', 'deepseek  deepseek-flash  1M  384K  yes  yes'].join('\n'),
      ),
    ).toEqual([{ provider: 'deepseek', model: 'deepseek-flash' }]);
  });

  it('CRLF 行尾与表内空行不影响解析', () => {
    const out = parsePiListModels(
      ['provider  model  context', '', 'Volcano   glm-5.2  262.1K'].join('\r\n'),
    );
    expect(out).toEqual([{ provider: 'Volcano', model: 'glm-5.2' }]);
  });
});

describe('loadPiConfig', () => {
  it('provider 与模型来自 pi 的清单', () => {
    mockSpawnSync.mockReturnValue(syncOk(TABLE));

    const piCfg = loadPiConfig();

    expect(piCfg.providerNames).toEqual(['deepseek', 'minimax-cn', 'Volcano']);
    expect(piCfg.modelOptions()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'MiniMax-M3',
      'glm-5.2',
    ]);
    expect(piCfg.modelOptions('Volcano')).toEqual(['glm-5.2']);
  });

  it('内置 provider 的模型不再因 models.json 只写一条而丢失', () => {
    // 回归点：minimax-cn 是 pi 内置 provider，models.json 里只追加 1 条；
    // 曾经的实现只读文件，卡片只给 1 个，而 pi 实际有内置的另外几个。
    writeModelsJson({ 'minimax-cn': { models: [{ id: 'MiniMax-M3.1-Flash-Preview' }] } });
    mockSpawnSync.mockReturnValue(
      syncOk(
        [
          'provider    model                       context  max-out  thinking  images',
          'minimax-cn  MiniMax-M2.7                204.8K   131.1K   yes       no    ',
          'minimax-cn  MiniMax-M3                  1M       524.3K   yes       yes   ',
          'minimax-cn  MiniMax-M3.1-Flash-Preview  512K     128K     yes       yes   ',
        ].join('\n'),
      ),
    );

    expect(loadPiConfig().modelOptions('minimax-cn')).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M3',
      'MiniMax-M3.1-Flash-Preview',
    ]);
  });

  it('同一模型出现在多个 provider 时，聚合列表不重复', () => {
    mockSpawnSync.mockReturnValue(
      syncOk(
        [
          'provider  model    context',
          'Volcano   glm-5.2  262.1K ',
          'lt        glm-5.2  200K   ',
        ].join('\n'),
      ),
    );
    expect(loadPiConfig().modelOptions()).toEqual(['glm-5.2']);
  });

  it('命令失败时回退到静态清单并留日志', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });

    const piCfg = loadPiConfig();

    expect(piCfg.providerNames).toContain('Volcano');
    expect(piCfg.modelOptions().length).toBeGreaterThan(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('CLI 缺失（spawn error）时同样回退，不抛异常', () => {
    mockSpawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stdout: '' });
    expect(() => loadPiConfig()).not.toThrow();
    expect(loadPiConfig().modelOptions().length).toBeGreaterThan(0);
  });

  it('列出为空清单时回退到静态清单', () => {
    mockSpawnSync.mockReturnValue(syncOk(NO_MODELS));
    expect(loadPiConfig().providerNames).toContain('Volcano');
  });

  it('指定没有模型的 provider 时回退到该 provider 的 fallback', () => {
    mockSpawnSync.mockReturnValue(syncOk(TABLE));
    expect(getPiModelOptions('nope-provider')).toEqual([]);
    expect(getPiModelOptions('Volcano')).toEqual(['glm-5.2']);
  });
});

describe('缓存', () => {
  it('两次读取只 spawn 一次', () => {
    mockSpawnSync.mockReturnValue(syncOk(TABLE));

    loadPiConfig();
    loadPiConfig();
    expect(getPiModelOptions()).not.toHaveLength(0);

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('models.json 变化后重新读取：旧快照立即返回 + 后台异步刷新', async () => {
    mockSpawnSync.mockReturnValue(syncOk(TABLE));
    mockSpawnProcess.mockImplementation(() => fakeChild(TABLE));
    writeModelsJson({ Volcano: { models: [{ id: 'glm-5.2' }] } });
    loadPiConfig();
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);

    writeModelsJson({
      Volcano: { models: [{ id: 'glm-5.2' }, { id: 'glm-5.3' }] },
      lt: { models: [{ id: 'glm-5.1' }] },
    });
    // 缓存键漂移：同步读不得重启 CLI（旧快照照常返回），刷新走异步路径。
    loadPiConfig();
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockSpawnProcess).toHaveBeenCalledTimes(1);

    // 后台刷新落地后，下一次同步读拿到新清单。
    await loadPiListedModelsAsync();
    expect(loadPiConfig().modelOptions()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'MiniMax-M3',
      'glm-5.2',
    ]);
  });

  it('失败也进缓存：30s 内不重复等超时', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });

    loadPiConfig();
    loadPiConfig();

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });
});

describe('异步路径', () => {
  it('loadPiListedModelsAsync 解析结果并回填同步缓存', async () => {
    mockSpawnProcess.mockReturnValue(fakeChild(TABLE));

    const models = await loadPiListedModelsAsync();
    expect(models).toHaveLength(4);

    // 异步结果已写缓存：同步读取不再 spawn
    expect(loadPiListedModels()).toHaveLength(4);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('warmPiListCache 预热后首次同步读取命中缓存', async () => {
    mockSpawnProcess.mockReturnValue(fakeChild(TABLE));

    warmPiListCache();
    await loadPiListedModelsAsync();

    expect(loadPiConfig().modelOptions()).toHaveLength(4);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('并发调用只 spawn 一次', async () => {
    mockSpawnProcess.mockReturnValue(fakeChild(TABLE));

    const [a, b] = await Promise.all([loadPiListedModelsAsync(), loadPiListedModelsAsync()]);

    expect(a).toEqual(b);
    expect(mockSpawnProcess).toHaveBeenCalledTimes(1);
  });

  it('异步失败落负缓存并回退', async () => {
    mockSpawnProcess.mockReturnValue(fakeChild('', 1));

    expect(await loadPiListedModelsAsync()).toEqual([]);
    expect(loadPiConfig().modelOptions().length).toBeGreaterThan(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('stdout 超过上限时中止，不无界缓冲', async () => {
    mockSpawnProcess.mockReturnValue(fakeChild('x'.repeat(4 * 1024 * 1024 + 1)));

    expect(await loadPiListedModelsAsync()).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('maxBuffer'));
  });

  it('命令超时按失败处理', async () => {
    vi.useFakeTimers();
    try {
      // 永不 close 的子进程：只有超时能结束它
      const silent = new EventEmitter() as FakeChild;
      silent.stdout = new EventEmitter();
      silent.stderr = new EventEmitter();
      silent.kill = () => {};
      mockSpawnProcess.mockReturnValue(silent);

      const pending = loadPiListedModelsAsync();
      await vi.advanceTimersByTimeAsync(8_000);

      expect(await pending).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PI_CONFIG_DIR env var', () => {
  it('should use PI_CONFIG_DIR instead of ~/.pi/agent', () => {
    expect(_getModelsFilePath()).toBe(path.join(tmpDir, 'models.json'));
    expect(_getAuthFilePath()).toBe(path.join(tmpDir, 'auth.json'));
  });

  it('空串/纯空白视为未设置：落回 ~/.pi/agent（纯字符串比较，不碰真实目录）', () => {
    // `??` 只挡 undefined：`PI_CONFIG_DIR=''` 会把 models.json 解析成相对
    // 进程 cwd 的路径，同一份配置在不同启动目录下指向两个文件。
    const fallback = path.join(os.homedir(), '.pi', 'agent', 'models.json');
    for (const value of ['', '   ']) {
      process.env.PI_CONFIG_DIR = value;
      expect(_getModelsFilePath()).toBe(fallback);
    }
    expect(path.isAbsolute(_getModelsFilePath())).toBe(true);
  });
});
