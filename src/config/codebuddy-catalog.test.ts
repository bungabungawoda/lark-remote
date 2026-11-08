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

/** 进程是否仍存在（kill(pid, 0) 只探测不发送信号）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等待子进程真正退出；返回是否在超时前退出。 */
async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

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
    // 不自带退出定时器的探针进程若没被收尾杀掉，这里兜底回收，
    // 保证单个用例失败也不会残留进程污染后续用例。
    const pidFile = path.join(tmpDir, 'probe.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
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

  /**
   * 故障形态：ACP server 完成握手后不会自行退出；子进程未建独立进程组时
   * kill(-pid) 抛 ESRCH，若把 ESRCH 当成功，探针会静默残留并随每次卡片
   * 重绘累积。后果：常驻进程堆积。约束：fake agent 不写退出定时器，断言
   * 收尾后进程必须退出。
   */
  it('探针收尾必须杀掉不自行退出的 ACP server（不留孤儿进程）', async () => {
    const pidFile = path.join(tmpDir, 'probe.pid');
    const source = [
      "import fs from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'const rl = createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version: '2.142.0' } } });",
      '  if (msg.id === 2) {',
      "    send({ jsonrpc: '2.0', id: 2, result: " + JSON.stringify(REAL_SHAPED) + ' });',
      '  }',
      '});',
      // 不 process.exit、不关闭 readline：模拟真 ACP server 常驻
    ].join('\n');
    mockProbe(source);

    const catalog = await refreshCodebuddyCatalog(BINARY, 5_000);
    expect(catalog).not.toBeNull();

    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await waitForProcessExit(pid)).toBe(true);
  }, 20_000);

  /**
   * 故障形态：卡片每次重绘都会触发目录刷新；缺少 TTL 缓存与并发去重时，
   * 每次重绘都会 spawn 一个 ACP server 并残留。约束：连续多次刷新
   * （并发 + TTL 窗口内重复点火）只允许 spawn 一次。
   */
  it('TTL 缓存与并发去重：连续多次刷新只 spawn 一个探针', async () => {
    const countFile = path.join(tmpDir, 'probe.count');
    const source = [
      "import fs from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      `const f = ${JSON.stringify(countFile)};`,
      'const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;',
      'fs.writeFileSync(f, String(n + 1));',
      'const rl = createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version: '2.142.0' } } });",
      '  if (msg.id === 2) {',
      "    send({ jsonrpc: '2.0', id: 2, result: " + JSON.stringify(REAL_SHAPED) + ' });',
      '    setTimeout(() => process.exit(0), 50);',
      '  }',
      '});',
    ].join('\n');
    mockProbe(source);

    // 两次并发点火 + 一次 TTL 内重复点火
    const [first, second] = await Promise.all([
      refreshCodebuddyCatalog(BINARY, 5_000),
      refreshCodebuddyCatalog(BINARY, 5_000),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await refreshCodebuddyCatalog(BINARY, 5_000);

    expect(Number(fs.readFileSync(countFile, 'utf8'))).toBe(1);
  }, 20_000);

  /**
   * 故障形态：目录缓存过期后打开 /config，同步读缓存拿不到值 → 模型字段
   * 退化成文本输入；探针随后成功也不会触发重绘，用户只能手输模型才能恢复
   * 下拉。约束：过期缓存继续用于渲染（stale-while-revalidate），后台刷新
   * 失败也不得清掉上次成功目录。
   */
  it('过期缓存继续渲染（stale-while-revalidate），刷新失败保留上次目录', async () => {
    const successSource = [
      "import { createInterface } from 'node:readline';",
      'const rl = createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version: '2.142.0' } } });",
      '  if (msg.id === 2) {',
      "    send({ jsonrpc: '2.0', id: 2, result: " + JSON.stringify(REAL_SHAPED) + ' });',
      '    setTimeout(() => process.exit(0), 50);',
      '  }',
      '});',
    ].join('\n');
    mockProbe(successSource);
    const first = await refreshCodebuddyCatalog(BINARY, 5_000);
    expect(first).not.toBeNull();

    // 只伪造 Date：探针进程与超时计时器仍走真实时间。
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] });
    try {
      // TTL 已过：同步读仍返回上次成功目录 → 卡片保持下拉
      expect(loadCodebuddyCatalog()).toEqual(first);

      // 过期后的这轮刷新换成必失败探针：不得抹掉 stale 目录
      mockProbe('setTimeout(() => process.exit(0), 80);\n');
      const refreshed = await refreshCodebuddyCatalog(BINARY, 5_000);
      expect(refreshed).toBeNull();
      expect(loadCodebuddyCatalog()).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
