import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseQoderModelList,
  parseQoderEffortList,
  resolveQoderConfigDir,
  loadQoderConfig,
  refreshQoderConfig,
  _invalidateQoderConfigCacheForTest,
} from './qoder-config.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';
import { prependPath, restorePath, writeMockBin } from '../../tests/lib/path-mock.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

describe('parseQoderEffortList', () => {
  it('parses the real 1.1.84 validation-error shape (trailing period stripped)', () => {
    const stderr =
      'An unexpected critical error occurred:Error: Invalid reasoning effort: __probe__. ' +
      'Valid values are: auto, none, low, medium, high, xhigh, max, ultracode.';
    expect(parseQoderEffortList(stderr)).toEqual([
      'auto',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
  });

  it('returns empty without the valid-values line', () => {
    expect(parseQoderEffortList('')).toEqual([]);
    expect(parseQoderEffortList('error: not logged in')).toEqual([]);
  });

  it('drops tokens that are not effort-looking words and dedupes', () => {
    const stderr = 'Valid values are: auto, 不是档位!, low, low, off.';
    expect(parseQoderEffortList(stderr)).toEqual(['auto', 'low', 'off']);
  });
});

describe('parseQoderModelList', () => {
  it('parses a plain JSON string array', () => {
    expect(parseQoderModelList('["qfmodel","lite"]')).toEqual(['qfmodel', 'lite']);
  });

  it('parses JSON objects by id/name/model keys and dedupes', () => {
    const json = JSON.stringify([
      { id: 'qfmodel', displayName: 'QF' },
      { name: 'lite' },
      { model: 'performance' },
      { unrelated: true },
      'qfmodel',
    ]);
    expect(parseQoderModelList(json)).toEqual(['qfmodel', 'lite', 'performance']);
  });

  it('parses a {models:[…]} envelope', () => {
    expect(parseQoderModelList('{"models":[{"id":"qfmodel"}]}')).toEqual(['qfmodel']);
  });

  it('falls back to plain lines (list markers stripped) when not JSON', () => {
    const text = '* qfmodel\n- lite\nperformance\n说明: 仅列出可用模型\n';
    expect(parseQoderModelList(text)).toEqual(['qfmodel', 'lite', 'performance']);
  });

  it('drops the MODEL header line (real 1.1.72 output shape)', () => {
    const text = 'MODEL\nAuto\nFast\nQwen3.8-Max\nGLM-5.3\n';
    expect(parseQoderModelList(text)).toEqual(['Auto', 'Fast', 'Qwen3.8-Max', 'GLM-5.3']);
  });

  it('returns empty for empty/garbage input', () => {
    expect(parseQoderModelList('')).toEqual([]);
    expect(parseQoderModelList('   \n')).toEqual([]);
    expect(parseQoderModelList('这不是模型列表！没有可解析的行。')).toEqual([]);
  });
});

describe('resolveQoderConfigDir', () => {
  it('explicit configDir wins', () => {
    expect(resolveQoderConfigDir('/tmp/qoder-home')).toBe('/tmp/qoder-home');
    expect(resolveQoderConfigDir('  ')).not.toBe('  ');
  });
});

describe('refreshQoderConfig / loadQoderConfig', () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  /**
   * 造一个假 CLI：每次 spawn 往计数文件追加一个字节（缓存命中/穿透证据，
   * 含 effort 探测的 spawn）。追加而不是读改写：模型探测与档位探测并发
   * spawn，读改写会丢计数。绝不 spawn 真 CLI —— 假 bin 经 path-mock 的
   * prependPath 挂到 PATH 首位。
   *
   * effort 探测行为（按 argv 分流，1.1.84 真机口径：合法值静默、非法值报
   * Invalid + 全表）：
   * - effortList 给出 → 哨兵探测返回该校验报错；不给 → 哨兵静默（解析为空）。
   * - effortRejected 里的档位 → 补充探测时报 Invalid；其余静默（接受）。
   */
  function writeListModelsBin(
    name: string,
    models: string,
    counterFile: string,
    opts?: {
      exitCode?: number;
      stderr?: string;
      effortList?: string;
      effortRejected?: string[];
    },
  ): void {
    const entry = path.join(tmpDir, `${name}.mock.js`);
    const source = [
      "import fs from 'node:fs';",
      `const counter = ${JSON.stringify(counterFile)};`,
      "fs.appendFileSync(counter, 'x');",
      `const effortList = ${JSON.stringify(opts?.effortList ?? '')};`,
      `const effortRejected = ${JSON.stringify(opts?.effortRejected ?? [])};`,
      'const argv = process.argv;',
      "if (argv.includes('--reasoning-effort')) {",
      "  const level = argv[argv.indexOf('--reasoning-effort') + 1] ?? '';",
      "  if (level.includes('__lark_remote_effort_probe__')) {",
      '    if (effortList) {',
      '      process.stderr.write(`Invalid reasoning effort: ${level}. Valid values are: ${effortList}`);',
      '      process.exitCode = 1;',
      '    }',
      '    process.exit();',
      '  }',
      '  if (effortRejected.includes(level)) {',
      '    process.stderr.write(`Invalid reasoning effort: ${level}.`);',
      '    process.exit(1);',
      '  }',
      '  process.exit(42);',
      '}',
      `process.stdout.write(${JSON.stringify(models)});`,
      ...(opts?.exitCode === undefined
        ? []
        : [
            `process.stderr.write(${JSON.stringify(opts?.stderr ?? '')});`,
            `process.exitCode = ${opts.exitCode};`,
          ]),
    ].join('\n');
    fs.writeFileSync(entry, source, 'utf-8');
    writeMockBin(tmpDir, name, entry);
  }

  /** spawn 次数（计数文件每 spawn 追加一个字节）。 */
  function spawnCount(counterFile: string): number {
    try {
      return fs.readFileSync(counterFile, 'utf-8').length;
    } catch {
      return 0;
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-qoder-config-'));
    savedPath = prependPath(tmpDir);
    _invalidateQoderConfigCacheForTest();
  });

  afterEach(() => {
    _invalidateQoderConfigCacheForTest();
    restorePath(savedPath);
    rmRf(tmpDir);
  });

  it('reads current model from settings.json and tolerates a failing binary', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: { name: 'qfmodel', preferences: {} } }),
      'utf-8',
    );
    // 不存在的 binary：spawn 失败 → modelOptions/effortOptions 为空、currentModel 保留
    await refreshQoderConfig('definitely-not-a-real-binary-xyz', tmpDir);
    const result = loadQoderConfig('definitely-not-a-real-binary-xyz', tmpDir);
    expect(result.currentModel).toBe('qfmodel');
    expect(result.modelOptions).toEqual([]);
    expect(result.effortOptions).toEqual([]);
  });

  it('missing settings.json yields undefined current model', () => {
    const result = loadQoderConfig('definitely-not-a-real-binary-xyz', tmpDir);
    expect(result.currentModel).toBeUndefined();
  });

  it('warns when settings.json is unreadable (F1)', () => {
    mockLogger.warn.mockClear();
    writeListModelsBin('qodercn', '["qfmodel"]', path.join(tmpDir, 'spawn-count'));
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ broken json', 'utf-8');
    loadQoderConfig('qodercn', tmpDir);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[qoder-config] settings.json unreadable'),
    );
  });

  it('parses --list-models output into modelOptions via a mock qodercn (E6)', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin(
      'qodercn',
      JSON.stringify([
        { id: 'qfmodel' },
        { name: 'lite' },
        { model: 'performance' },
        { unrelated: true },
        'qfmodel',
      ]),
      counterFile,
    );
    await refreshQoderConfig('qodercn', tmpDir);
    const result = loadQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual(['qfmodel', 'lite', 'performance']);
    // 哨兵静默（无 effortList）→ effort 探测只 1 次、解析为空；合计 2 次 spawn
    expect(result.effortOptions).toEqual([]);
    expect(spawnCount(counterFile)).toBe(2);
  });

  it('caches within TTL: a second identical refresh does not spawn again (E6)', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel","lite"]', counterFile);
    const first = await refreshQoderConfig('qodercn', tmpDir);
    const second = await refreshQoderConfig('qodercn', tmpDir);
    expect(second.modelOptions).toEqual(first.modelOptions);
    expect(second.effortOptions).toEqual(first.effortOptions);
    expect(spawnCount(counterFile)).toBe(2);
  });

  it('cache is keyed by binary: switching binary re-spawns (E6)', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel-cn"]', counterFile);
    writeListModelsBin('qoder', '["qfmodel-intl"]', counterFile);

    const cn = await refreshQoderConfig('qodercn', tmpDir);
    expect(cn.modelOptions).toEqual(['qfmodel-cn']);
    expect(spawnCount(counterFile)).toBe(2);

    const intl = await refreshQoderConfig('qoder', tmpDir);
    expect(intl.modelOptions).toEqual(['qfmodel-intl']);
    expect(spawnCount(counterFile)).toBe(4);
  });

  it('warns and falls back to an empty list on a non-zero --list-models exit (E6)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}', 'utf-8');
    mockLogger.warn.mockClear();
    writeListModelsBin('qodercn', '', path.join(tmpDir, 'spawn-count'), {
      exitCode: 2,
      stderr: 'probe boom',
    });

    const result = await refreshQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[qoder-config] failed to load models'),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exited 2: probe boom'));
  });

  it('warns when --list-models produces no model names (E6)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}', 'utf-8');
    mockLogger.warn.mockClear();
    writeListModelsBin('qodercn', '   \n', path.join(tmpDir, 'spawn-count'));

    const result = await refreshQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[qoder-config] --list-models produced no model names, card falls back to input',
    );
  });

  it('probes effort levels from the validation error and appends accepted supplements', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel"]', counterFile, {
      // 1.1.84 真机报错全表：8 档，漏列 off
      effortList: 'auto, none, low, medium, high, xhigh, max, ultracode',
    });
    const result = await refreshQoderConfig('qodercn', tmpDir);
    // 全表 8 档 + 补充探测接受的 off
    expect(result.effortOptions).toEqual([
      'auto',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
      'off',
    ]);
    // 3 次 spawn：--list-models + 哨兵探测 + off 补充探测
    expect(spawnCount(counterFile)).toBe(3);
  });

  it('skips the supplement probe when the error list already contains the level', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel"]', counterFile, {
      effortList: 'auto, low, off',
    });
    const result = await refreshQoderConfig('qodercn', tmpDir);
    expect(result.effortOptions).toEqual(['auto', 'low', 'off']);
    // 2 次 spawn：--list-models + 哨兵探测（off 已在全表，不再补探）
    expect(spawnCount(counterFile)).toBe(2);
  });

  it('drops a supplement level the CLI rejects', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel"]', counterFile, {
      effortList: 'auto, low, high',
      effortRejected: ['off'],
    });
    const result = await refreshQoderConfig('qodercn', tmpDir);
    expect(result.effortOptions).toEqual(['auto', 'low', 'high']);
    expect(spawnCount(counterFile)).toBe(3);
  });

  it('falls back to an empty effort list when the probe reports no levels', async () => {
    mockLogger.warn.mockClear();
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel"]', counterFile); // 哨兵静默 → 无全表
    const result = await refreshQoderConfig('qodercn', tmpDir);
    expect(result.effortOptions).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[qoder-config] effort probe produced no levels'),
    );
    // 解析为空 → 早退，不再做补充探测
    expect(spawnCount(counterFile)).toBe(2);
  });

  it('keeps the last successful snapshot when a later refresh fails', async () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel","lite"]', counterFile, {
      effortList: 'auto, low, high',
    });
    await refreshQoderConfig('qodercn', tmpDir);

    // 同一个 binary 换成必然失败的实现（模拟 CLI 升级/临时故障），
    // 先让 TTL 过期（缓存键按 binary，时间戳由 Date.now 决定）。
    writeListModelsBin('qodercn', '', counterFile, { exitCode: 1, stderr: 'boom' });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    try {
      await refreshQoderConfig('qodercn', tmpDir);
    } finally {
      nowSpy.mockRestore();
    }

    const result = loadQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual(['qfmodel', 'lite']);
    expect(result.effortOptions).toEqual(['auto', 'low', 'high', 'off']);
  });
});
