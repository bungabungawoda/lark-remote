/**
 * Codex Config Card Custom Model Input - ANCHOR TEST
 *
 * SPEC: Codex config card should have custom model input field similar to Claude's "自定义模型名"
 *
 * 验证策略：
 * 1. 当 defaultAgent 为 codex 时，buildConfigCard() 应生成带有自定义模型输入框的卡片
 * 2. 输入框的 key 应该是 `agents.codex.model`（与下拉框共享相同的 key）
 * 3. 输入框的 label 应该是 "自定义模型名"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Bridge } from '../../../src/bridge/index.js';
import type { SessionReaderRegistry } from '../../../src/session/registry.js';
import { invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * P2-2（codex-y review）：本文件此前未 mock node:child_process，卡片构建会真实调用
 * `codex debug models`，依赖宿主机二进制且每次同步阻塞最长 8s。现改为 mock，行为
 * 镜像真实 codex：config.toml 声明 model_catalog_json → 返回该文件内容；否则返回
 * bundled fixture（gpt-5.2 等，覆盖 AC1-3 的预设断言）。
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

const BUNDLED_FIXTURE = makeCatalog([
  makeModel('gpt-5.2', [{ effort: 'medium' }], {
    default_reasoning_level: 'medium',
    description: 'GPT-5.2',
  }),
]);

type RouterInternals = {
  buildConfigCard: () => { card: object };
  ensurePendingConfig: () => void;
  pendingConfig: AppConfig | null;
};

// ---------------------------------------------------------------------------
// Helpers: extract input fields from CardKit 2.0 config card
// ---------------------------------------------------------------------------

function extractInputFields(
  card: object,
): Array<{ key: string; label: string; defaultValue: string }> {
  const results: Array<{ key: string; label: string; defaultValue: string }> = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;

    if (record.tag === 'column_set' && record.columns) {
      const columns = record.columns as Array<Record<string, unknown>>;
      let label = '';

      if (columns[0]?.elements) {
        const leftElements = columns[0].elements as Array<Record<string, unknown>>;
        for (const el of leftElements) {
          if (el.tag === 'div' && (el.text as { content?: string } | undefined)?.content) {
            const content = (el.text as { content: string }).content;
            if (content.startsWith('**') && content.endsWith('**')) {
              label = content.slice(2, -2);
            } else {
              label = content;
            }
            break;
          }
        }
      }

      if (columns[1]?.elements) {
        const rightElements = columns[1].elements as Array<Record<string, unknown>>;
        for (const el of rightElements) {
          if (el.tag === 'input' && el.name) {
            results.push({
              key: el.name as string,
              label,
              defaultValue: (el.default_value as string) || '',
            });
          }
        }
      }
      return;
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return results;
}

/**
 * Extract select_static options by callback key (CardKit 2.0).
 * Returns the value list for the field whose callback `value.key` matches `key`.
 */
function extractSelectOptions(card: object, key: string): string[] {
  const values: string[] = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        const options = record.options as Array<{ value?: string }> | undefined;
        for (const opt of options ?? []) {
          if (typeof opt.value === 'string') values.push(opt.value);
        }
        return;
      }
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return values;
}

function extractModelSelectOptions(card: object): string[] {
  return extractSelectOptions(card, 'agents.codex.model');
}

function extractProviderOptions(card: object): string[] {
  return extractSelectOptions(card, 'agents.codex.modelProvider');
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function createMockBridge(): Bridge {
  return {
    sendResult: vi.fn().mockResolvedValue(undefined),
    forwardToClaude: vi.fn().mockResolvedValue(undefined),
    isBusy: false,
    isBusyFor: vi.fn().mockReturnValue(false),
    enqueue: vi.fn(),
    interruptCurrentRun: vi.fn().mockResolvedValue(false),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn(),
    setIdleTimeout: vi.fn(),
    removeFromQueue: vi.fn().mockReturnValue(false),
    updateCardInPlace: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    getQueuedTasks: vi.fn().mockReturnValue([]),
    getQueuedTask: vi.fn().mockReturnValue(undefined),
    getQueueInfo: vi.fn().mockReturnValue({ position: 0, isRunning: false, tasksAhead: 0 }),
    getAllActiveRuns: vi.fn().mockReturnValue(new Map()),
    sendFile: vi.fn().mockResolvedValue(''),
    getActiveRunFor: vi.fn().mockReturnValue(undefined),
    clearRunners: vi.fn(),
  } as unknown as Bridge;
}

function createMockSessionReaderRegistry(
  agentKinds: string[] = ['claude', 'codex'],
): SessionReaderRegistry {
  return {
    listRegistered: vi.fn().mockReturnValue(agentKinds),
    get: vi.fn(),
  } as unknown as SessionReaderRegistry;
}

function buildCodexConfig(model: string = 'gpt-5.2'): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    agents: {
      codex: {
        model,
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        stopGraceMs: 5000,
      },
    },
    output: {
      showThinking: true,
      showToolUse: true,
      showToolResult: true,
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}

// ---------------------------------------------------------------------------
// ANCHOR Tests
// ---------------------------------------------------------------------------

describe('codex config card custom model input - ANCHOR', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;
  let fallbackHome: string;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-custom-model-'));
    // 固定 fallback 环境（无 model_catalog_json）：内置 bundled 目录仍含 gpt-5.2，
    // 测试不依赖开发者本机 ~/.codex 的 catalog 配置。
    oldCodexHome = process.env.CODEX_HOME;
    fallbackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-custom-home-'));
    process.env.CODEX_HOME = fallbackHome;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args.includes('--bundled')) {
        return BUNDLED_FIXTURE;
      }
      // 非 bundled：镜像真实行为——config.toml 声明 model_catalog_json 则返回其内容
      const home = process.env.CODEX_HOME;
      if (home) {
        const cfgPath = path.join(home, 'config.toml');
        if (fs.existsSync(cfgPath)) {
          const cfgRaw = fs.readFileSync(cfgPath, 'utf-8');
          const m = cfgRaw.match(/model_catalog_json\s*=\s*"([^"]+)"/);
          if (m && fs.existsSync(m[1])) {
            return fs.readFileSync(m[1], 'utf-8');
          }
        }
      }
      return BUNDLED_FIXTURE;
    });
  });

  afterEach(() => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    fs.rmSync(fallbackHome, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateCodexBundledCache();
  });

  /**
   * ANCHOR AC1: Codex config card should have custom model input field
   *
   * Expected: A field with key 'agents.codex.model' and label containing "自定义模型名"
   * Current behavior: NO custom model input field exists (will FAIL)
   */
  it('should include custom model input field when defaultAgent=codex', () => {
    const config = buildCodexConfig('gpt-5.2');
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'codex']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
    const inputFields = extractInputFields(result.card);

    // Should have a custom model input field with label containing "自定义模型名"
    // Must use label to distinguish from other inputs with same key
    const customModelInput = inputFields.find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );

    expect(customModelInput).toBeDefined();
    expect(customModelInput?.key).toBe('agents.codex.model');
  });

  /**
   * ANCHOR AC2: When current model is not in dropdown options, input field should show custom value
   *
   * Expected: When model is a custom value (e.g., 'custom-model-xyz'), input shows that value
   * Current behavior: NO custom model input field exists (will FAIL)
   */
  it('should show custom value in input field when model is not in dropdown options', () => {
    const config = buildCodexConfig('custom-model-xyz');
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'codex']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
    const inputFields = extractInputFields(result.card);

    // Find the custom model input field - MUST use the label "自定义模型名" to distinguish from other inputs
    const customModelInput = inputFields.find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );

    // When model is not in preset options, the input should show the custom value
    expect(customModelInput?.defaultValue).toBe('custom-model-xyz');
  });

  /**
   * ANCHOR AC3: When current model is in dropdown options, input field should be empty
   *
   * Expected: When model is a preset option (e.g., 'o3'), input should be empty
   * Current behavior: NO custom model input field exists (will FAIL)
   */
  it('should show empty input field when model is in preset options', () => {
    const config = buildCodexConfig('gpt-5.2');
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'codex']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
    const inputFields = extractInputFields(result.card);

    // Find the custom model input field - MUST use the label "自定义模型名" to distinguish from other inputs
    const customModelInput = inputFields.find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );

    // When model is a preset option (o3), input field should be empty
    expect(customModelInput?.defaultValue).toBe('');
  });

  /**
   * ANCHOR AC4: config.input handler should update pendingConfig for codex custom model
   *
   * Expected: When user inputs custom model via config.input, pendingConfig should be updated
   * Current behavior: config.input may not handle codex custom model correctly (will FAIL)
   */
  it('should update pendingConfig when user inputs custom model via config.input', () => {
    const config = buildCodexConfig('gpt-5.2');
    const sessionStore = new SessionStore();
    const bridge = createMockBridge();
    const sessionReaderRegistry = createMockSessionReaderRegistry(['claude', 'codex']);

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry,
    });

    // Simulate user typing in custom model input and submitting
    (router as unknown as RouterInternals).ensurePendingConfig();

    // Access internal method to set value
    const internals = router as unknown as RouterInternals;
    if (internals.pendingConfig) {
      internals.pendingConfig.agents = {
        ...(internals.pendingConfig.agents ?? {}),
        codex: { ...(config.agents?.codex ?? {}), model: 'custom-codex-model-xyz' },
      } as AppConfig['agents'];
    }

    // Verify pendingConfig was updated
    expect(internals.pendingConfig?.agents?.codex?.model).toBe('custom-codex-model-xyz');
  });

  /**
   * ANCHOR AC5 (catalog 模式语义，2026-07-31): 活动目录是唯一权威。
   * - 活动目录内的模型（deepseek-v4-flash + deepseek provider）→ 预设，输入框为空
   * - 旧 bundled 模型（gpt-5.2 + openai provider）不在活动目录 → 视为自定义值回显
   */
  it('should treat catalog model as preset and legacy bundled model as custom in catalog mode', () => {
    // catalog 模式 fixture：tmp CODEX_HOME + config.toml + models.json
    const catalogHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-custom-catalog-home-'));
    fs.writeFileSync(
      path.join(catalogHome, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(catalogHome, 'models.json')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(catalogHome, 'models.json'),
      makeCatalog([
        makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
          default_reasoning_level: 'high',
          description: 'Latest frontier agentic coding model.',
        }),
      ]),
    );
    process.env.CODEX_HOME = catalogHome;

    // 场景 1：catalog 模型 + 对应 provider → 预设，输入框为空
    const config1 = buildCodexConfig('deepseek-v4-flash');
    config1.agents!.codex!.modelProvider = 'deepseek';
    const router1 = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config: config1,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(['claude', 'codex']),
    });
    const card1 = (router1 as unknown as RouterInternals).buildConfigCard() as { card: object };
    const inputs1 = extractInputFields(card1.card);
    const custom1 = inputs1.find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );
    expect(custom1?.defaultValue).toBe('');
    // 强化：模型下拉必须恰为活动目录模型（防止 catalog 解析失败时回退 FALLBACK 的假阳性）
    const modelSelect1 = extractModelSelectOptions(card1.card);
    expect(modelSelect1).toEqual(['deepseek-v4-flash']);

    // 场景 2：旧 bundled 模型 + openai provider → 不在活动目录，视为自定义回显
    const config2 = buildCodexConfig('gpt-5.2');
    const router2 = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config: config2,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(['claude', 'codex']),
    });
    const card2 = (router2 as unknown as RouterInternals).buildConfigCard() as { card: object };
    const inputs2 = extractInputFields(card2.card);
    const custom2 = inputs2.find(
      (f) => f.label.includes('自定义模型名') && f.key === 'agents.codex.model',
    );
    expect(custom2?.defaultValue).toBe('gpt-5.2');
    // 强化：provider 下拉含内置 openai（codex 合并内置 provider，review4 P2）但无 anthropic；
    // openai+内置模型路径在 catalog 模式下已失效——模型下拉仍只含活动目录模型
    const providerOptions2 = extractProviderOptions(card2.card);
    expect(providerOptions2).toContain('openai');
    expect(providerOptions2).not.toContain('anthropic');

    fs.rmSync(catalogHome, { recursive: true, force: true });
  });
});
