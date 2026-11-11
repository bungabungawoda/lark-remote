/**
 * 测试：pi provider 和 model 应该来自 `pi --list-models`
 *
 * 验证以下行为：
 * 1. pi provider 下拉选项来自 pi 自己列出的清单（不是硬编码）
 * 2. pi model 下拉选项来自同一清单，并按当前 provider 过滤
 * 3. pi.model 是 select 类型，不是 input 类型
 *
 * 语义说明：`pi --list-models` 是 pi 运行时的解析结果——内置 provider 目录与
 * models.json 叠加、再按凭据可用性过滤。只读 models.json 会漏掉内置 provider
 * 的模型（models[] 是追加语义，不是全集）。
 *
 * 该 CLI 经 src/platform/spawn 拉起，测试 mock 该 seam，不 spawn 真 pi。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractFieldOptions, isSelectField } from '../lib/pi-card-fields.js';

// 生产代码经 platform/spawn（cross-spawn）调用 pi，mock 该 seam。
const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('../../src/platform/spawn.js', async () => ({
  ...(await import('../lib/spawn-mock.js')).spawnModuleMock(mockSpawnSync),
}));
vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

import { createRouterFixture } from '../lib/router-fixture.js';
import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
import { AppConfigSchema } from '../../src/config/index.js';
import { getPiModelOptions, _invalidatePiListCacheForTest } from '../../src/config/pi-config.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function buildPiConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'pi',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: {
      pi: {
        provider: 'Volcano',
        model: 'glm-5.2',
        thinking: 'medium',
        tools: 'read,bash,edit,write,grep,find,ls',
      },
    },
    idle: { watchdogMinutes: 15 },
    logging: {
      level: 'info',
      dir: 'logs',
    },
  });
}

/** 两个 provider 的清单：Volcano 选中项在、lt 的模型只属于 lt。 */
const TWO_PROVIDERS = [
  'provider  model    context  max-out  thinking  images',
  'Volcano   glm-5.2  262.1K   16.4K    yes       no    ',
  'lt        glm-5.1  200K     16.4K    yes       no    ',
].join('\n');

/** mock 一次成功的 `pi --list-models`（表格文本）。 */
function mockListModels(table: string): void {
  mockSpawnSync.mockReturnValue({ status: 0, stdout: table, stderr: '' });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('pi provider/model config from pi list', () => {
  let tmpDir: string;
  let savedPiConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-test-'));
    savedPiConfigDir = process.env.PI_CONFIG_DIR;
    process.env.PI_CONFIG_DIR = tmpDir;
    mockSpawnSync.mockReset();
    _invalidatePiListCacheForTest();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (savedPiConfigDir !== undefined) {
      process.env.PI_CONFIG_DIR = savedPiConfigDir;
    } else {
      delete process.env.PI_CONFIG_DIR;
    }
  });

  /**
   * TEST 1: provider 清单来自 pi 的输出
   */
  it('should read providers from pi --list-models', async () => {
    mockListModels(
      [
        'provider        model        context  max-out  thinking  images',
        'custom-provider  custom-1    128K     16.4K    no        no    ',
        'custom-provider  custom-2    128K     16.4K    no        no    ',
        'lt               glm-5.1     200K     16.4K    yes       no    ',
        'anthropic        claude-opus 200K     64K      yes       yes   ',
      ].join('\n'),
    );

    const providers = (await import('../../src/config/pi-config.js')).loadPiConfig().providerNames;

    expect(providers).toContain('custom-provider');
    expect(providers).toContain('lt');
    expect(providers).toContain('anthropic');
  });

  /**
   * TEST 2: getPiModelOptions 返回 pi 列出的模型（不是配置文件里的子集）
   */
  it('should return the models pi lists', async () => {
    mockListModels(TWO_PROVIDERS);

    const models = getPiModelOptions();
    expect(models).toEqual(['glm-5.2', 'glm-5.1']);
  });

  /**
   * TEST 3: pi.model 应该是 select 类型（不是 input）
   */
  it('should use select for pi.model field', async () => {
    mockListModels(TWO_PROVIDERS);

    const config = buildPiConfig();
    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry({}),
    }).router;

    const result = router.buildConfigCard();
    const card = result.card!;

    expect(isSelectField(card, 'agents.pi.model')).toBe(true);
    expect(isSelectField(card, 'agents.pi.provider')).toBe(true);
  });

  /**
   * TEST 4: provider 选项含两个清单项；model 选项按当前 provider 过滤
   */
  it('should have options for provider and model fields', async () => {
    mockListModels(TWO_PROVIDERS);

    const config = buildPiConfig();
    const router = createRouterFixture({
      tmpDir,
      config,
      bridge: createMockBridge(),
      sessionReaderRegistry: createMockSessionReaderRegistry({}),
    }).router;

    const result = router.buildConfigCard();
    const card = result.card!;

    const providerOptions = extractFieldOptions(card, 'agents.pi.provider');
    const modelOptions = extractFieldOptions(card, 'agents.pi.model');

    // 精确断言：model 选项按当前选中 provider 过滤，只含 Volcano 的模型
    expect(providerOptions).toEqual(expect.arrayContaining(['Volcano', 'lt']));
    expect(modelOptions).toContain('glm-5.2');
    expect(modelOptions).not.toContain('glm-5.1');
  });

  /**
   * TEST 5: 内置 provider 的模型不因 models.json 只写一条而丢失
   */
  it('should keep built-in provider models that models.json only appends to', async () => {
    mockListModels(
      [
        'provider    model                       context  max-out  thinking  images',
        'minimax-cn  MiniMax-M2.7                204.8K   131.1K   yes       no    ',
        'minimax-cn  MiniMax-M3                  1M       524.3K   yes       yes   ',
        'minimax-cn  MiniMax-M3.1-Flash-Preview  512K     128K     yes       yes   ',
      ].join('\n'),
    );

    expect(getPiModelOptions('minimax-cn')).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M3',
      'MiniMax-M3.1-Flash-Preview',
    ]);
  });
});
