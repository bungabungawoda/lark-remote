import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mapCatalogResponse,
  refreshCodebuddyCatalog,
  invalidateCodebuddyCatalogCache,
  loadCodebuddyCatalog,
} from './codebuddy-catalog.js';
import { writeMockSource, prependPath, restorePath } from '../../tests/lib/path-mock.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

/** 真机 2.142.0 session/new 响应形状（脱敏：合成 id/数值）。 */
const REAL_SHAPED = {
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Always Ask' }] },
  models: {
    currentModelId: 'hy4-preview',
    availableModels: [
      {
        modelId: 'hy4free',
        name: 'Hy4',
        description: 'x0.00 credits',
        _meta: {
          supportsImages: true,
          supportsReasoning: true,
          maxInputTokens: 960000,
          credits: 'x0.00 credits',
          effortOptions: [{ value: 'high', name: 'High' }],
        },
      },
      { modelId: 'hy3', name: 'Hy3', _meta: { maxInputTokens: 360000, credits: 'x0.00 credits' } },
      {
        modelId: 'glm-5.3',
        name: 'GLM-5.3',
        _meta: { maxInputTokens: 200000, credits: 'x0.69 credits', effortOptions: [] },
      },
      { name: '缺 id 的坏条目' },
    ],
  },
  configOptions: [
    { type: 'select', id: 'mode', category: 'mode', currentValue: 'default', options: [] },
    {
      type: 'select',
      id: 'thought_level',
      category: 'thought_level',
      currentValue: 'enabled',
      options: [
        { value: 'disabled', name: 'Off' },
        { value: 'enabled', name: 'On (default)' },
      ],
    },
  ],
};

describe('mapCatalogResponse', () => {
  it('maps session/new response to models + thought levels (real 2.142.0 shape)', () => {
    const catalog = mapCatalogResponse(REAL_SHAPED);
    expect(catalog).not.toBeNull();
    expect(catalog!.currentModelId).toBe('hy4-preview');
    expect(catalog!.models).toEqual([
      {
        id: 'hy4free',
        name: 'Hy4',
        maxInputTokens: 960000,
        efforts: ['high'],
        credits: 'x0.00 credits',
      },
      { id: 'hy3', name: 'Hy3', maxInputTokens: 360000, efforts: [], credits: 'x0.00 credits' },
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        maxInputTokens: 200000,
        efforts: [],
        credits: 'x0.69 credits',
      },
    ]);
    expect(catalog!.thoughtLevels).toEqual([
      { value: 'disabled', name: 'Off' },
      { value: 'enabled', name: 'On (default)' },
    ]);
  });

  it('returns null for garbage / missing models (caller falls back)', () => {
    expect(mapCatalogResponse(null)).toBeNull();
    expect(mapCatalogResponse({})).toBeNull();
    expect(mapCatalogResponse({ models: { availableModels: [] } })).toBeNull();
    expect(mapCatalogResponse({ configOptions: [] })).toBeNull();
  });

  it('credits 只读 _meta.credits：description 里的费率字样不产生 credits', () => {
    const catalog = mapCatalogResponse({
      models: {
        availableModels: [
          { modelId: 'm1', name: 'M1', description: 'x0.29 credits' },
          { modelId: 'm2', name: 'M2', description: 'x0.29 credits', _meta: { credits: '' } },
        ],
      },
      configOptions: [],
    });
    expect(catalog!.models.map((m) => m.credits)).toEqual([undefined, undefined]);
    expect(catalog!.models.every((m) => !('credits' in m))).toBe(true);
  });
});

/**
 * 探针四场景：全部走 tests/lib/path-mock 的假 bin，绝不 spawn 真 codebuddy。
 * 每个场景自带退出定时器，保证即使终止器的进程组信号未送达，mock 也不会常驻。
 */
describe('refreshCodebuddyCatalog 探针 fixture', () => {
  const BINARY = 'codebuddy-probe-mock';
  let tmpDir: string;
  let savedPath: string | undefined;

  function mockProbe(source: string): void {
    writeMockSource(tmpDir, BINARY, source);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cb-probe-'));
    savedPath = prependPath(tmpDir);
    invalidateCodebuddyCatalogCache();
    mockLogger.warn.mockReset();
  });

  afterEach(() => {
    restorePath(savedPath);
    rmRf(tmpDir);
  });

  it('正常握手：initialize → session/new 返回真机形状目录并写入缓存', async () => {
    const source = [
      "import { createInterface } from 'node:readline';",
      'const rl = createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version: '2.142.0' } } });",
      '  if (msg.id === 2) {',
      "    send({ jsonrpc: '2.0', id: 2, result: " + JSON.stringify(REAL_SHAPED) + ' });',
      '    setTimeout(() => process.exit(0), 200);',
      '  }',
      '});',
    ].join('\n');
    mockProbe(source);

    const catalog = await refreshCodebuddyCatalog(BINARY, 5_000);

    expect(catalog).not.toBeNull();
    expect(catalog!.models.map((m) => m.id)).toEqual(['hy4free', 'hy3', 'glm-5.3']);
    expect(catalog!.currentModelId).toBe('hy4-preview');
    expect(catalog!.thoughtLevels).toEqual([
      { value: 'disabled', name: 'Off' },
      { value: 'enabled', name: 'On (default)' },
    ]);
    expect(loadCodebuddyCatalog()).toEqual(catalog);
  }, 20_000);

  it('永不响应：timeoutMs 到点返回 null 并告警', async () => {
    mockProbe('setTimeout(() => process.exit(0), 1200);\n');

    const catalog = await refreshCodebuddyCatalog(BINARY, 400);

    expect(catalog).toBeNull();
    expect(loadCodebuddyCatalog()).toBeNull();
    expect(mockLogger.warn.mock.calls.flat().join(' ')).toContain('timeout');
  }, 20_000);

  it('只输出垃圾行并提前 close：返回 null（stream closed）', async () => {
    mockProbe(
      [
        "process.stdout.write('garbage line\\n');",
        'process.stdout.write(\'{\\"broken\\":\\n\');',
        'setTimeout(() => process.exit(0), 80);',
      ].join('\n'),
    );

    const catalog = await refreshCodebuddyCatalog(BINARY, 5_000);

    expect(catalog).toBeNull();
    expect(mockLogger.warn.mock.calls.flat().join(' ')).toContain('stream closed');
  }, 20_000);

  it('stderr 报错后退出：warn 里带上 stderr 尾部', async () => {
    mockProbe(
      [
        "process.stderr.write('probe backend exploded\\n');",
        'setTimeout(() => process.exit(0), 80);',
      ].join('\n'),
    );

    const catalog = await refreshCodebuddyCatalog(BINARY, 5_000);

    expect(catalog).toBeNull();
    const warnings = mockLogger.warn.mock.calls.flat().join(' ');
    expect(warnings).toContain('stream closed');
    expect(warnings).toContain('probe backend exploded');
  }, 20_000);
});
