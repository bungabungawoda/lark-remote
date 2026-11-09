import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mapCatalogResponse,
  refreshCodebuddyCatalog,
  refreshCodebuddyCatalogForConfig,
  invalidateCodebuddyCatalogCache,
  loadCodebuddyCatalog,
  pickWinningRegion,
  detectCodebuddyRegion,
  invalidateCodebuddyRegion,
  getDetectedCodebuddyRegion,
  resolveCodebuddyEnv,
  ensureCodebuddyRegion,
  scheduleCodebuddyRegionRedetect,
  drainCodebuddyProbes,
  CODEBUDDY_ACP_ARGS,
  readHostCodebuddyRegion,
  readCodebuddyProductConfigCacheRegion,
  regionFromProductConfig,
  type RegionProbeResult,
} from './codebuddy-catalog.js';
import { writeMockSource, prependPath, restorePath } from '../../tests/lib/path-mock.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * 宿主被桌面端等上层注入 CODEBUDDY_INTERNET_ENVIRONMENT /
 * ACC_PRODUCT_CONFIG_PATH 时，区域前置判据会在测试里意外命中，双探针用例
 * 会被静默截断。顶层隔离这几个键，让每个用例从「无信号」的确定环境起步。
 */
const HOST_REGION_ENV_KEYS = [
  'CODEBUDDY_INTERNET_ENVIRONMENT',
  'ACC_PRODUCT_CONFIG_PATH',
  'ACC_PRODUCT_CONFIG_V3',
  'ACC_PRODUCT_CONFIG_V2',
  'ACC_PRODUCT_CONFIG',
] as const;
let savedHostRegionEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedHostRegionEnv = {};
  for (const key of HOST_REGION_ENV_KEYS) {
    savedHostRegionEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of HOST_REGION_ENV_KEYS) {
    const value = savedHostRegionEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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

/** 双探针判据：脱敏合成目录，不涉及任何真机数据。 */
describe('pickWinningRegion 区域判据', () => {
  const catalog = (id: string) =>
    mapCatalogResponse({
      models: { currentModelId: id, availableModels: [{ modelId: id, name: id }] },
      configOptions: [],
    })!;
  const both: RegionProbeResult[] = [
    { region: 'internal', catalog: catalog('cn-model') },
    { region: 'external', catalog: catalog('sg-model') },
  ];

  it('只有一个区域拿到目录时直接选它', () => {
    const probes: RegionProbeResult[] = [both[0], { region: 'external', catalog: null }];
    expect(pickWinningRegion(probes, 'cn-model')?.region).toBe('internal');
  });

  it('两边都有目录时用账号当前模型做唯一匹配', () => {
    expect(pickWinningRegion(both, 'cn-model')?.region).toBe('internal');
    expect(pickWinningRegion(both, 'sg-model')?.region).toBe('external');
  });

  it('两边都匹配不上或两边都失败时返回 null（不猜、不接管）', () => {
    expect(pickWinningRegion(both, 'unknown-model')).toBeNull();
    expect(
      pickWinningRegion(
        [
          { region: 'internal', catalog: null },
          { region: 'external', catalog: null },
        ],
        'cn-model',
      ),
    ).toBeNull();
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
    invalidateCodebuddyRegion();
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

  /**
   * 故障形态：WorkBuddy 桌面端占着 CLI 默认的 50403（`codebuddy --acp` 会
   * 起一个本地 HTTP 服务，帮助里写作 "interactive mode reuses a stable port"），
   * 纯 `--acp` 直接 `EADDRINUSE ... exit 1`，探针永远拿不到目录——/config 的
   * 模型列表就停在旧快照。约束：探针必须带 `--serve --port 0`，让 CLI 自动
   * 分配端口（ACP 仍走 stdio）。
   */
  it('探针带 --serve --port 0：不抢 CLI 默认端口', async () => {
    const argsFile = path.join(tmpDir, 'probe.args');
    mockProbe(
      [
        "import fs from 'node:fs';",
        "import { createInterface } from 'node:readline';",
        `fs.writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(' '));`,
        'const rl = createInterface({ input: process.stdin });',
        "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "rl.on('line', (line) => {",
        '  let msg; try { msg = JSON.parse(line); } catch { return; }',
        "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: {} });",
        '  if (msg.id === 2) {',
        "    send({ jsonrpc: '2.0', id: 2, result: { models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'M' }] }, configOptions: [] } });",
        '    setTimeout(() => process.exit(0), 50);',
        '  }',
        '});',
      ].join('\n'),
    );

    await refreshCodebuddyCatalog(BINARY, 5_000, {});

    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain('--acp');
    expect(args).toContain('--serve');
    expect(args).toContain('--port 0');
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
   * 故障形态：CI 机器没装 codebuddy CLI，spawn 以 ENOENT 的 `'error'` 事件
   * 异步到达（win32 上 cross-spawn 的 verifyENOENT 主动 emit）。只 try/catch
   * 同步 throw 而不监听 error，后台预热的 fire-and-forget 探针就会把未捕获
   * 异常丢给测试进程。约束：binary 不存在时探针优雅返回 null。
   */
  it('binary 不存在（spawn ENOENT）时返回 null，不抛未捕获异常', async () => {
    const catalog = await refreshCodebuddyCatalog('codebuddy-not-installed-probe', 1_000, {});

    expect(catalog).toBeNull();
    expect(loadCodebuddyCatalog()).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
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

  /**
   * 故障形态：目录探针不传 env，只继承 lark-remote 进程环境；runner 侧却走
   * mergeProcessEnv(process.env, agents.codebuddy.env)。国内版配了 internal
   * 也只作用于会话连接，/config 下拉仍是海外模型清单。约束：探针必须看到
   * 同一份 env，且缓存按 env 指纹分区（换区不得吃 TTL 内的旧目录）。
   */
  it('探针透传 agents.codebuddy.env，缓存按区域指纹分区', async () => {
    const countFile = path.join(tmpDir, 'probe.count');
    const source = [
      "import fs from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      `const f = ${JSON.stringify(countFile)};`,
      'const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;',
      'fs.writeFileSync(f, String(n + 1));',
      "const env = process.env.CODEBUDDY_INTERNET_ENVIRONMENT || '(unset)';",
      'const rl = createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: {} });",
      '  if (msg.id === 2) {',
      '    send({ jsonrpc: "2.0", id: 2, result: { models: { currentModelId: env, availableModels: [{ modelId: env, name: env }] }, configOptions: [] } });',
      '    setTimeout(() => process.exit(0), 50);',
      '  }',
      '});',
    ].join('\n');
    mockProbe(source);

    const internal = await refreshCodebuddyCatalog(BINARY, 5_000, {
      CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
    });
    expect(internal?.currentModelId).toBe('internal');

    // 同一 TTL 窗口内换区：env 指纹变了，必须重新点火而不是吃旧区域缓存。
    const external = await refreshCodebuddyCatalog(BINARY, 5_000, {
      CODEBUDDY_INTERNET_ENVIRONMENT: 'external',
    });
    expect(external?.currentModelId).toBe('external');
    expect(loadCodebuddyCatalog()?.currentModelId).toBe('external');
    expect(Number(fs.readFileSync(countFile, 'utf8'))).toBe(2);
  }, 20_000);

  /**
   * 故障形态：换了区域后新探针失败，旧实现「失败保留上次成功快照」会把
   * 旧区域的模型清单继续渲染给用户（且落 5 分钟 negative cache）。约束：
   * stale 只允许在「同一身份」内复用。
   */
  it('换区后探针失败：旧区域目录不得 stale 复用', async () => {
    const successSource = [
      "import { createInterface } from 'node:readline';",
      'const rl = createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: {} });",
      '  if (msg.id === 2) {',
      "    send({ jsonrpc: '2.0', id: 2, result: " + JSON.stringify(REAL_SHAPED) + ' });',
      '    setTimeout(() => process.exit(0), 50);',
      '  }',
      '});',
    ].join('\n');
    mockProbe(successSource);
    const first = await refreshCodebuddyCatalog(BINARY, 5_000, {
      CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
    });
    expect(first).not.toBeNull();

    mockProbe('setTimeout(() => process.exit(0), 80);\n');
    const second = await refreshCodebuddyCatalog(BINARY, 5_000, {
      CODEBUDDY_INTERNET_ENVIRONMENT: 'external',
    });
    expect(second).toBeNull();
    expect(loadCodebuddyCatalog()).toBeNull();
  }, 20_000);

  /** 假 bin 按区域 env 返回合成目录；可让 external 失败或两边返回同一目录。 */
  function regionSource(opts: { externalFails?: boolean; sameCatalog?: boolean } = {}): string {
    const guard = opts.externalFails
      ? 'if (env === "external") { setTimeout(() => process.exit(0), 20); } else '
      : '';
    const modelId = opts.sameCatalog ? '"shared-model"' : 'env';
    return [
      "import { createInterface } from 'node:readline';",
      'const env = process.env.CODEBUDDY_INTERNET_ENVIRONMENT || "(unset)";',
      `${guard}{`,
      '  const rl = createInterface({ input: process.stdin });',
      '  const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      '  rl.on("line", (line) => {',
      '    let msg; try { msg = JSON.parse(line); } catch { return; }',
      '    if (msg.id === 1) send({ jsonrpc: "2.0", id: 1, result: {} });',
      '    if (msg.id === 2) {',
      `      const id = ${modelId};`,
      '      send({ jsonrpc: "2.0", id: 2, result: { models: { currentModelId: id, availableModels: [{ modelId: id, name: id }] }, configOptions: [] } });',
      '      setTimeout(() => process.exit(0), 50);',
      '    }',
      '  });',
      '}',
    ].join('\n');
  }

  /**
   * 故障形态：宿主 env 与登录态不同区域，用户又没显式配
   * CODEBUDDY_INTERNET_ENVIRONMENT。约束：启动双探针各跑一次，按账号当前
   * 模型唯一匹配出所属区域，胜出目录直接入缓存（不跑第三次探针），且
   * runner / 目录探针共用 resolveCodebuddyEnv 的同一份 env。
   */
  it('双探针按账号模型判定区域，胜出目录入缓存且 resolve 叠加区域', async () => {
    mockProbe(regionSource());
    const region = await detectCodebuddyRegion({
      binary: BINARY,
      timeoutMs: 5_000,
      accountModel: 'internal',
    });
    expect(region).toBe('internal');
    expect(getDetectedCodebuddyRegion()).toBe('internal');
    expect(loadCodebuddyCatalog()?.currentModelId).toBe('internal');
    expect(resolveCodebuddyEnv({})).toEqual({ CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' });
    // 显式配置原样优先，不被自动判定覆盖。
    expect(resolveCodebuddyEnv({ CODEBUDDY_INTERNET_ENVIRONMENT: 'external' })).toEqual({
      CODEBUDDY_INTERNET_ENVIRONMENT: 'external',
    });
  }, 20_000);

  it('只有一个区域可用时不依赖账号模型也能判定', async () => {
    mockProbe(regionSource({ externalFails: true }));
    const region = await detectCodebuddyRegion({
      binary: BINARY,
      timeoutMs: 5_000,
      accountModel: 'unknown-model',
    });
    expect(region).toBe('internal');
    expect(loadCodebuddyCatalog()?.currentModelId).toBe('internal');
  }, 20_000);

  it('两边目录相同且无法区分时保持宿主 env，不擅自接管', async () => {
    mockProbe(regionSource({ sameCatalog: true }));
    const region = await detectCodebuddyRegion({
      binary: BINARY,
      timeoutMs: 5_000,
      accountModel: 'unknown-model',
    });
    expect(region).toBeNull();
    expect(getDetectedCodebuddyRegion()).toBeNull();
    expect(resolveCodebuddyEnv({})).toEqual({});
  }, 20_000);

  it('显式配置了区域时不接管也不启动探针', async () => {
    const countFile = path.join(tmpDir, 'region-probe.count');
    mockProbe(
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(countFile)}, "1");`,
        'setTimeout(() => process.exit(0), 20);',
      ].join('\n'),
    );
    const region = await detectCodebuddyRegion({
      binary: BINARY,
      timeoutMs: 5_000,
      configuredEnv: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' },
    });
    expect(region).toBeNull();
    expect(fs.existsSync(countFile)).toBe(false);
  }, 20_000);

  it('身份失效后清掉自动判定结果，避免重建 runner 继续注入旧区域', async () => {
    mockProbe(regionSource());
    await detectCodebuddyRegion({
      binary: BINARY,
      timeoutMs: 5_000,
      accountModel: 'internal',
    });
    expect(getDetectedCodebuddyRegion()).toBe('internal');
    invalidateCodebuddyRegion();
    expect(getDetectedCodebuddyRegion()).toBeNull();
    expect(resolveCodebuddyEnv({})).toEqual({});
  }, 20_000);

  /**
   * 故障形态：lark-remote 刚启动、双探针还没跑完，用户第一条消息就到达。
   * 旧实现 runner 直接读 detectedRegion（null），拿宿主 env 打错端点。
   * 约束：开跑前等一次判定；已判定时零成本放行，不重复 spawn。
   */
  it('开跑前屏障：已判定时立即返回，不再 spawn 探针', async () => {
    mockProbe(regionSource());
    await detectCodebuddyRegion({
      binary: BINARY,
      timeoutMs: 5_000,
      accountModel: 'internal',
    });
    expect(getDetectedCodebuddyRegion()).toBe('internal');

    const countFile = path.join(tmpDir, 'ensure.count');
    mockProbe(
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(countFile)}, "1");`,
        'setTimeout(() => process.exit(0), 20);',
      ].join('\n'),
    );
    const region = await ensureCodebuddyRegion({}, { waitMs: 2_000, binary: BINARY });
    expect(region).toBe('internal');
    expect(fs.existsSync(countFile)).toBe(false);
  }, 20_000);

  /**
   * 故障形态：启动探测卡住（CLI 无响应）。开跑前屏障不能把用户堵死——
   * 到点放行、按宿主 env 继续，宁可这一轮可能打错端点。
   */
  it('开跑前屏障：探测超时放行，不阻塞用户', async () => {
    mockProbe('setTimeout(() => process.exit(0), 400);\n');
    const started = Date.now();
    const region = await ensureCodebuddyRegion({}, { waitMs: 150, binary: BINARY });
    expect(region).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    // 等后台那轮探测自然收尾：固定 sleep 在满负载回归里会等不够，残留的
    // in-flight 会让下一个用例少 spawn 一次（断言变成负载相关）。
    await drainCodebuddyProbes();
  }, 20_000);

  it('开跑前屏障：显式配置区域时不探测', async () => {
    const countFile = path.join(tmpDir, 'ensure-explicit.count');
    mockProbe(
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(countFile)}, "1");`,
        'setTimeout(() => process.exit(0), 20);',
      ].join('\n'),
    );
    const region = await ensureCodebuddyRegion(
      { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' },
      { waitMs: 2_000, binary: BINARY },
    );
    expect(region).toBeNull();
    expect(fs.existsSync(countFile)).toBe(false);
  }, 20_000);

  /**
   * 故障形态：两个端点都探不通（CLI 卡住或网络断）。没有退避时，每条消息
   * 都会白等一次判定上限，用户感知是「发什么都先卡 8 秒」。
   */
  it('判定失败后退避：后续消息不再白等一次探针', async () => {
    const countFile = path.join(tmpDir, 'backoff.count');
    mockProbe(
      [
        "import fs from 'node:fs';",
        `const f = ${JSON.stringify(countFile)};`,
        'let n = 0; try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}',
        'fs.writeFileSync(f, String(n + 1));',
        'setTimeout(() => process.exit(0), 20);',
      ].join('\n'),
    );
    const first = await ensureCodebuddyRegion({}, { waitMs: 2_000, binary: BINARY });
    expect(first).toBeNull();
    expect(Number(fs.readFileSync(countFile, 'utf8'))).toBe(2);

    const started = Date.now();
    const second = await ensureCodebuddyRegion({}, { waitMs: 2_000, binary: BINARY });
    expect(second).toBeNull();
    // 退避窗口内立即放行，且不再 spawn。
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Number(fs.readFileSync(countFile, 'utf8'))).toBe(2);
  }, 20_000);

  /**
   * 故障形态：用户重新登录后，旧实现要重启 lark-remote 才重判区域。
   * 约束：401 后进程内自动重判；上游持续 401 时冷却窗口挡住重复 spawn。
   */
  it('401 后自动重判：冷却窗口内连续调度只跑一轮双探针', async () => {
    const countFile = path.join(tmpDir, 'redetect.count');
    mockProbe(
      [
        "import fs from 'node:fs';",
        `const f = ${JSON.stringify(countFile)};`,
        'let n = 0; try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}',
        'fs.writeFileSync(f, String(n + 1));',
        'setTimeout(() => process.exit(0), 20);',
      ].join('\n'),
    );
    scheduleCodebuddyRegionRedetect({}, { binary: BINARY });
    scheduleCodebuddyRegionRedetect({}, { binary: BINARY });
    // 一轮判定 = internal + external 各一次探针（串行）。
    await vi.waitFor(
      () => {
        expect(fs.existsSync(countFile)).toBe(true);
        expect(Number(fs.readFileSync(countFile, 'utf8'))).toBe(2);
      },
      { timeout: 10_000 },
    );
  }, 20_000);
});

/**
 * `/config` 打开时的目录刷新：切换 CodeBuddy 登录（换账号 / 换区域）后，
 * 第一次打开就要看到新模型，而不是等 TTL 过期或下一条消息 401 才被动重建。
 *
 * 账号指纹用 `settings.json` 的 mtime+size：CLI 在登录/切区时重写它，探针
 * 本身不会。测试通过改 HOME 把 settings.json 指到临时目录。
 */
describe('refreshCodebuddyCatalogForConfig', () => {
  const BINARY = 'codebuddy-config-refresh-mock';
  let tmpDir: string;
  let savedPath: string | undefined;
  let savedHome: string | undefined;
  let savedRegionEnv: string | undefined;
  let homeSpy: { mockRestore: () => void } | undefined;
  let settingsFile: string;
  let countFile: string;

  function probeCount(): number {
    return fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  }

  /** 假 bin：数一次探针次数，按区域 env 返回合成目录；`onlyExternal` 让其它区域直接退出。 */
  function countingSource(opts: { onlyExternal?: boolean } = {}): string {
    // 必须同步 exit：用 setTimeout 的话脚本会在退出前就把握手响应发出去，
    // 「非 external 区域探不通」这个前提根本不成立。
    const guard = opts.onlyExternal
      ? 'if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT !== "external") process.exit(0);\n'
      : '';
    return [
      "import fs from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      `const f = ${JSON.stringify(countFile)};`,
      'let n = 0; try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}',
      'fs.writeFileSync(f, String(n + 1));',
      guard + 'const env = process.env.CODEBUDDY_INTERNET_ENVIRONMENT || "host";',
      'const rl = createInterface({ input: process.stdin });',
      'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      'rl.on("line", (line) => {',
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      '  if (msg.id === 1) send({ jsonrpc: "2.0", id: 1, result: {} });',
      '  if (msg.id === 2) {',
      '    send({ jsonrpc: "2.0", id: 2, result: { models: { currentModelId: env, availableModels: [{ modelId: env, name: env }] }, configOptions: [] } });',
      '    setTimeout(() => process.exit(0), 20);',
      '  }',
      '});',
    ].join('\n');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cb-cfg-'));
    countFile = path.join(tmpDir, 'probe.count');
    savedPath = prependPath(tmpDir);
    savedHome = process.env.HOME;
    // 夹具必须显式固定 os.homedir()，不能只改 process.env.HOME：win32 上
    // os.homedir() 读 USERPROFILE，HOME 只是个普通变量。只改 HOME 会让这里写的
    // settings.json 落在临时目录、生产却去 stat 真实家目录，账号指纹恒不变
    // ——TTL 内不重探，正是 Windows CI 上「expected 1 to be 2」的机制。
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    // 宿主进程若自带 CODEBUDDY_INTERNET_ENVIRONMENT（在 CodeBuddy 里跑测试就是
    // 这样），探针会 mergeProcessEnv 继承它，「未锁定区域」这个前提就不成立。
    savedRegionEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
    delete process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
    settingsFile = path.join(tmpDir, '.codebuddy', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    invalidateCodebuddyCatalogCache();
    invalidateCodebuddyRegion();
  });

  afterEach(() => {
    homeSpy?.mockRestore();
    homeSpy = undefined;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedRegionEnv === undefined) delete process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
    else process.env.CODEBUDDY_INTERNET_ENVIRONMENT = savedRegionEnv;
    restorePath(savedPath);
    rmRf(tmpDir);
  });

  it('settings.json 指纹变化后，TTL 内也重新探测', async () => {
    writeMockSource(tmpDir, BINARY, countingSource());
    fs.writeFileSync(settingsFile, '{"model":"m1"}', 'utf8');

    await refreshCodebuddyCatalog(BINARY, 5_000, {});
    expect(probeCount()).toBe(1);
    // TTL 内 + 指纹未变：吃缓存，不再 spawn。
    await refreshCodebuddyCatalog(BINARY, 5_000, {});
    expect(probeCount()).toBe(1);

    // 切换登录：CLI 重写 settings.json（mtime/size 都变）。
    fs.writeFileSync(settingsFile, '{"model":"m2","account":"switched"}', 'utf8');
    const after = await refreshCodebuddyCatalog(BINARY, 5_000, {});
    expect(after).not.toBeNull();
    expect(probeCount()).toBe(2);
  }, 20_000);

  /**
   * 平台守卫：win32 的 os.homedir() 读 USERPROFILE，HOME 不参与 home 解析。
   * 生产必须按 os.homedir() 取 settings.json；若为了「修 Windows」退化成读
   * process.env.HOME，Windows 上将永远读不到 CLI 写入的登录态（指纹恒 null）。
   */
  it('HOME env 不参与账号指纹：改 HOME 下的 settings.json 不触发重探', async () => {
    writeMockSource(tmpDir, BINARY, countingSource());
    fs.writeFileSync(settingsFile, '{"model":"m1"}', 'utf8');
    const decoyHome = path.join(tmpDir, 'decoy-home');
    const decoySettings = path.join(decoyHome, '.codebuddy', 'settings.json');
    fs.mkdirSync(path.dirname(decoySettings), { recursive: true });
    fs.writeFileSync(decoySettings, '{"model":"decoy-1"}', 'utf8');
    process.env.HOME = decoyHome;

    await refreshCodebuddyCatalog(BINARY, 5_000, {});
    expect(probeCount()).toBe(1);
    fs.writeFileSync(decoySettings, '{"model":"decoy-2","account":"switched"}', 'utf8');
    await refreshCodebuddyCatalog(BINARY, 5_000, {});

    expect(probeCount()).toBe(1);
  }, 20_000);

  it('当前区域探不通时双探针重判并接管，且标记 identityChanged', async () => {
    writeMockSource(tmpDir, BINARY, countingSource({ onlyExternal: true }));
    fs.writeFileSync(settingsFile, '{"model":"external"}', 'utf8');

    const first = await refreshCodebuddyCatalogForConfig({ binary: BINARY, timeoutMs: 5_000 });
    expect(first.catalog?.currentModelId).toBe('external');
    expect(first.region).toBe('external');
    // 接管了新区域：调用方要重置旧身份上的 session / runner。
    expect(first.identityChanged).toBe(true);

    const second = await refreshCodebuddyCatalogForConfig({ binary: BINARY, timeoutMs: 5_000 });
    expect(second.catalog?.currentModelId).toBe('external');
    expect(second.identityChanged).toBe(false);
  }, 20_000);

  it('显式锁定区域时探不通也不接管', async () => {
    writeMockSource(tmpDir, BINARY, countingSource({ onlyExternal: true }));
    fs.writeFileSync(settingsFile, '{"model":"external"}', 'utf8');

    const outcome = await refreshCodebuddyCatalogForConfig({
      binary: BINARY,
      env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' },
      timeoutMs: 5_000,
    });
    expect(outcome.catalog).toBeNull();
    expect(outcome.region).toBeNull();
    expect(outcome.identityChanged).toBe(false);
  }, 20_000);
});

describe('宿主/V3 区域前置判据与 ACP 启动参数', () => {
  const BIN = 'codebuddy-region-mock';
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cb-region-'));
    savedPath = prependPath(dir);
    invalidateCodebuddyCatalogCache();
    invalidateCodebuddyRegion();
    mockLogger.warn.mockReset();
  });

  afterEach(async () => {
    await drainCodebuddyProbes();
    restorePath(savedPath);
    rmRf(dir);
  });

  /** 假 CLI：按注入的区域 env 返回一份目录，并把 spawn 次数写盘。 */
  function mockRegionProbe(countFile: string): void {
    writeMockSource(
      dir,
      BIN,
      [
        "import fs from 'node:fs';",
        "import { createInterface } from 'node:readline';",
        `const f = ${JSON.stringify(countFile)};`,
        'const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;',
        'fs.writeFileSync(f, String(n + 1));',
        'const env = process.env.CODEBUDDY_INTERNET_ENVIRONMENT || "(unset)";',
        'const rl = createInterface({ input: process.stdin });',
        "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "rl.on('line', (line) => {",
        '  let msg; try { msg = JSON.parse(line); } catch { return; }',
        "  if (msg.id === 1) send({ jsonrpc: '2.0', id: 1, result: {} });",
        '  if (msg.id === 2) {',
        '    send({ jsonrpc: "2.0", id: 2, result: { models: { currentModelId: env, availableModels: [{ modelId: env, name: env }] }, configOptions: [] } });',
        '    setTimeout(() => process.exit(0), 30);',
        '  }',
        '});',
      ].join('\n'),
    );
  }

  it('V3 配置的 networkEnvironment 优先于 endpoint 域名', () => {
    expect(
      regionFromProductConfig({
        networkEnvironment: 'internal',
        endpoint: 'https://www.codebuddy.ai',
      }),
    ).toBe('internal');
    expect(regionFromProductConfig({ networkEnvironment: 'external' })).toBe('external');
  });

  it('V3 无 networkEnvironment 时用 cn-saas / endpoint 域名兜底', () => {
    expect(
      regionFromProductConfig({
        productFeaturesConfig: { NetworkFailover: { region: 'cn-saas' } },
      }),
    ).toBe('internal');
    expect(regionFromProductConfig({ endpoint: 'https://www.workbuddy.cn' })).toBe('internal');
    expect(regionFromProductConfig({ endpoint: 'https://www.codebuddy.ai' })).toBe('external');
    expect(regionFromProductConfig({ endpoint: 'https://www.workbuddy.ai' })).toBe('external');
    expect(regionFromProductConfig({ endpoint: 'https://copilot.tencent.com' })).toBe('internal');
    expect(regionFromProductConfig({ endpoint: 'https://notcodebuddy.ai' })).toBeNull();
  });

  it('无区域信号 / 非法值时不接管', () => {
    expect(regionFromProductConfig({})).toBeNull();
    expect(regionFromProductConfig({ networkEnvironment: 'ioa' })).toBeNull();
    expect(readHostCodebuddyRegion()).toBeNull();
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'ioa';
    expect(readHostCodebuddyRegion()).toBeNull();
  });

  it('宿主 CODEBUDDY_INTERNET_ENVIRONMENT 直接定区', () => {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'EXTERNAL';
    expect(readHostCodebuddyRegion()).toEqual({ region: 'external', source: 'host-env' });
  });

  it('V3 文件与宿主 env 冲突时 V3 优先', () => {
    const cfg = path.join(dir, 'acc-product-config-v3.json');
    fs.writeFileSync(cfg, JSON.stringify({ networkEnvironment: 'internal' }), 'utf8');
    process.env.ACC_PRODUCT_CONFIG_PATH = cfg;
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'external';
    expect(readHostCodebuddyRegion()).toEqual({ region: 'internal', source: 'v3-config' });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('ACC_PRODUCT_CONFIG_V3 内联 JSON 也能定区', () => {
    process.env.ACC_PRODUCT_CONFIG_V3 = JSON.stringify({ networkEnvironment: 'external' });
    expect(readHostCodebuddyRegion()).toEqual({ region: 'external', source: 'v3-config' });
  });

  it('WorkBuddy V3 缓存按 mtime 取最新配置定区', () => {
    const cache = path.join(dir, 'workbuddy-cache');
    fs.mkdirSync(cache);
    const oldFile = path.join(cache, 'acc-product-config-v3-old.json');
    const newFile = path.join(cache, 'acc-product-config-v3-new.json');
    fs.writeFileSync(oldFile, JSON.stringify({ networkEnvironment: 'external' }), 'utf8');
    fs.writeFileSync(newFile, JSON.stringify({ networkEnvironment: 'internal' }), 'utf8');
    // 明确旧新顺序（同一秒内写入的 mtime 可能相同）
    fs.utimesSync(oldFile, new Date(1_000), new Date(1_000));
    fs.utimesSync(newFile, new Date(2_000), new Date(2_000));

    expect(readCodebuddyProductConfigCacheRegion(cache)).toEqual({
      region: 'internal',
      source: 'workbuddy-cache',
    });
  });

  it('WorkBuddy 缓存无 networkEnvironment 时用 endpoint 域名兜底', () => {
    const cache = path.join(dir, 'workbuddy-cache-endpoint');
    fs.mkdirSync(cache);
    fs.writeFileSync(
      path.join(cache, 'acc-product-config-v3-cn.json'),
      JSON.stringify({ endpoint: 'https://www.workbuddy.cn' }),
      'utf8',
    );
    expect(readCodebuddyProductConfigCacheRegion(cache)?.region).toBe('internal');
  });

  it('WorkBuddy 缓存不可用 / 无有效配置时不接管', () => {
    expect(readCodebuddyProductConfigCacheRegion(null)).toBeNull();
    expect(readCodebuddyProductConfigCacheRegion(path.join(dir, 'missing'))).toBeNull();
    const cache = path.join(dir, 'workbuddy-cache-empty');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'acc-product-config-v3-bad.json'), '{oops', 'utf8');
    expect(readCodebuddyProductConfigCacheRegion(cache)).toBeNull();
  });

  it('宿主缓存声明区域时只跑一次探针并定区', async () => {
    const countFile = path.join(dir, 'spawn.cache.count');
    mockRegionProbe(countFile);
    const cache = path.join(dir, 'workbuddy-cache-hit');
    fs.mkdirSync(cache);
    fs.writeFileSync(
      path.join(cache, 'acc-product-config-v3-hit.json'),
      JSON.stringify({ networkEnvironment: 'internal' }),
      'utf8',
    );

    const region = await detectCodebuddyRegion({
      binary: BIN,
      timeoutMs: 5_000,
      hostProductConfigCacheDir: cache,
    });
    expect(region).toBe('internal');
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1');
  }, 20_000);

  it('命中前置信号时只跑一次探针，区域与目录同时落地', async () => {
    const countFile = path.join(dir, 'spawn.count');
    mockRegionProbe(countFile);
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';

    const region = await detectCodebuddyRegion({ binary: BIN, timeoutMs: 5_000 });

    expect(region).toBe('internal');
    expect(getDetectedCodebuddyRegion()).toBe('internal');
    expect(resolveCodebuddyEnv({})).toEqual({ CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' });
    expect(loadCodebuddyCatalog()?.currentModelId).toBe('internal');
    expect(Number(fs.readFileSync(countFile, 'utf8'))).toBe(1);
  }, 20_000);

  it('显式配置仍优先于宿主信号，且不启动探针', async () => {
    const countFile = path.join(dir, 'spawn.count');
    mockRegionProbe(countFile);
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';

    const region = await detectCodebuddyRegion({
      binary: BIN,
      timeoutMs: 5_000,
      configuredEnv: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' },
    });

    expect(region).toBeNull();
    expect(getDetectedCodebuddyRegion()).toBeNull();
    expect(fs.existsSync(countFile)).toBe(false);
  }, 20_000);

  it('ACP 启动参数不带 --brief（提问走 AskUserQuestion 能力，不走 SendUserMessage）', () => {
    expect([...CODEBUDDY_ACP_ARGS]).toEqual(['--acp', '--serve', '--port', '0']);
  });
});
