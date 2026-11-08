import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseQoderModelList,
  resolveQoderConfigDir,
  loadQoderConfig,
  invalidateQoderConfigCache,
} from './qoder-config.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';
import { prependPath, restorePath, writeMockBin } from '../../tests/lib/path-mock.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

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

describe('loadQoderConfig', () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  /**
   * 造一个打印模型清单的假 CLI：每次 spawn 给计数文件 +1（缓存命中/穿透证据）。
   * 绝不 spawn 真 CLI —— 假 bin 经 path-mock 的 prependPath 挂到 PATH 首位。
   */
  function writeListModelsBin(
    name: string,
    models: string,
    counterFile: string,
    opts?: { exitCode?: number; stderr?: string },
  ): void {
    const entry = path.join(tmpDir, `${name}.mock.js`);
    const source = [
      "import fs from 'node:fs';",
      `const counter = ${JSON.stringify(counterFile)};`,
      'let n = 0;',
      "try { n = Number(fs.readFileSync(counter, 'utf-8')); } catch {}",
      'fs.writeFileSync(counter, String(n + 1));',
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-qoder-config-'));
    savedPath = prependPath(tmpDir);
    invalidateQoderConfigCache();
  });

  afterEach(() => {
    invalidateQoderConfigCache();
    restorePath(savedPath);
    rmRf(tmpDir);
  });

  it('reads current model from settings.json and tolerates a failing binary', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: { name: 'qfmodel', preferences: {} } }),
      'utf-8',
    );
    // 不存在的 binary：spawn 失败 → modelOptions 为空、currentModel 保留
    const result = loadQoderConfig('definitely-not-a-real-binary-xyz', tmpDir);
    expect(result.currentModel).toBe('qfmodel');
    expect(result.modelOptions).toEqual([]);
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

  it('parses --list-models output into modelOptions via a mock qodercn (E6)', () => {
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
    const result = loadQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual(['qfmodel', 'lite', 'performance']);
    expect(fs.readFileSync(counterFile, 'utf-8')).toBe('1');
  });

  it('caches within TTL: a second identical call does not spawn again (E6)', () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel","lite"]', counterFile);
    const first = loadQoderConfig('qodercn', tmpDir);
    const second = loadQoderConfig('qodercn', tmpDir);
    expect(second.modelOptions).toEqual(first.modelOptions);
    expect(fs.readFileSync(counterFile, 'utf-8')).toBe('1');
  });

  it('cache is keyed by binary: switching binary re-spawns (E6)', () => {
    const counterFile = path.join(tmpDir, 'spawn-count');
    writeListModelsBin('qodercn', '["qfmodel-cn"]', counterFile);
    writeListModelsBin('qoder', '["qfmodel-intl"]', counterFile);

    const cn = loadQoderConfig('qodercn', tmpDir);
    expect(cn.modelOptions).toEqual(['qfmodel-cn']);
    expect(fs.readFileSync(counterFile, 'utf-8')).toBe('1');

    const intl = loadQoderConfig('qoder', tmpDir);
    expect(intl.modelOptions).toEqual(['qfmodel-intl']);
    expect(fs.readFileSync(counterFile, 'utf-8')).toBe('2');
  });

  it('warns and falls back to an empty list on a non-zero --list-models exit (E6)', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}', 'utf-8');
    mockLogger.warn.mockClear();
    writeListModelsBin('qodercn', '', path.join(tmpDir, 'spawn-count'), {
      exitCode: 2,
      stderr: 'probe boom',
    });

    const result = loadQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[qoder-config] failed to load models'),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exited 2: probe boom'));
  });

  it('warns when --list-models produces no model names (E6)', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}', 'utf-8');
    mockLogger.warn.mockClear();
    writeListModelsBin('qodercn', '   \n', path.join(tmpDir, 'spawn-count'));

    const result = loadQoderConfig('qodercn', tmpDir);
    expect(result.modelOptions).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[qoder-config] --list-models produced no model names, card falls back to input',
    );
  });
});
