import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockLogger } from '../../tests/lib/logger-mock.js';

// 直接在模块顶层定义 mock（兼容 bun 的 vitest）。
// 生产代码经 platform/spawn（cross-spawn）调用 codex，mock 该 seam。
const mockSpawnSync = vi.fn();

vi.mock('../platform/spawn.js', () => ({
  spawnProcessSync: (...args: any[]) => mockSpawnSync(...args),
  spawnProcess: () => {
    throw new Error('sync test must not spawn async');
  },
}));
vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

import { resolveCodexHome, loadCodexConfig, invalidateCodexBundledCache } from './codex-config.js';
import {
  getCodexBundledModelSlugs,
  invalidateCodexBundledTestCache,
} from '../../tests/lib/codex-bundled-test-helpers.js';

/** spawnProcessSync 成功返回形态 */
const syncOk = (stdout: string) => ({ status: 0, stdout, stderr: '' });
/** spawnProcessSync 失败返回形态（spawn error，如 ENOENT） */
const syncErr = (message: string) => ({ status: null, error: new Error(message), stdout: '' });

beforeEach(() => {
  mockSpawnSync.mockReset();
  mockLogger.warn.mockReset();
  invalidateCodexBundledCache();
  invalidateCodexBundledTestCache();
});

/** 造一个 bundled 目录 JSON（含 1 个 hide 应被排除） */
const BUNDLED_JSON = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      visibility: 'list',
      supported_in_api: true,
      priority: 2,
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      supported_in_api: true,
      priority: 43,
    },
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
    },
    {
      slug: 'gpt-5.4',
      display_name: 'GPT-5.4',
      visibility: 'list',
      supported_in_api: true,
      priority: 16,
    },
  ],
});

describe('resolveCodexHome', () => {
  const originalEnv = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalEnv;
  });

  it('uses explicit codexHome argument first', () => {
    process.env.CODEX_HOME = '/from-env';
    expect(resolveCodexHome('/explicit')).toBe('/explicit');
  });

  it('falls back to $CODEX_HOME when no argument given', () => {
    process.env.CODEX_HOME = '/from-env';
    expect(resolveCodexHome()).toBe('/from-env');
  });

  it('falls back to ~/.codex when neither argument nor $CODEX_HOME set', () => {
    delete process.env.CODEX_HOME;
    expect(resolveCodexHome()).toBe(path.join(os.homedir(), '.codex'));
  });

  it('空串/纯空白不算「已设置」：落回 ~/.codex，且结果恒为绝对路径', () => {
    // `??` 只挡 undefined：`CODEX_HOME=''` 会带着空串往下走，
    // path.join('', 'config.toml') 变成相对**进程 cwd** 的路径——同一个
    // resolveCodexHome 在两种启动目录下解析出两个不同文件（红线：路径解析单源）。
    for (const value of ['', '   ']) {
      process.env.CODEX_HOME = value;
      expect(resolveCodexHome()).toBe(path.join(os.homedir(), '.codex'));
    }
    process.env.CODEX_HOME = '/from-env';
    expect(resolveCodexHome('')).toBe('/from-env');
    expect(resolveCodexHome('  /from-env  ')).toBe('/from-env');
    expect(path.isAbsolute(path.join(resolveCodexHome(''), 'config.toml'))).toBe(true);
  });
});

describe('getCodexBundledModelSlugs', () => {
  it('excludes visibility:"hide" and sorts by priority ascending', () => {
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    const slugs = getCodexBundledModelSlugs();

    expect(slugs).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4']);
    expect(slugs).not.toContain('codex-auto-review');
    // invoked once
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'codex',
      ['debug', 'models', '--bundled'],
      expect.objectContaining({ encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('caches: repeated calls within TTL only spawn once', () => {
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    getCodexBundledModelSlugs();
    getCodexBundledModelSlugs();

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidateCodexBundledTestCache', () => {
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    getCodexBundledModelSlugs();
    invalidateCodexBundledTestCache();
    getCodexBundledModelSlugs();

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('returns [] and warns on spawn failure (ENOENT)', () => {
    mockSpawnSync.mockReturnValue(syncErr('spawn codex ENOENT'));

    const slugs = getCodexBundledModelSlugs();

    expect(slugs).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns [] and warns on invalid JSON', () => {
    mockSpawnSync.mockReturnValue(syncOk('not json {{{'));
    expect(getCodexBundledModelSlugs()).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('treats models array missing/empty as empty result (no crash)', () => {
    mockSpawnSync.mockReturnValue(syncOk(JSON.stringify({ models: [] })));
    expect(getCodexBundledModelSlugs()).toEqual([]);

    mockSpawnSync.mockReturnValue(syncOk(JSON.stringify({})));
    expect(getCodexBundledModelSlugs()).toEqual([]);
  });
});

describe('loadCodexConfig model options merge', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-test-'));

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    invalidateCodexBundledCache();
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeConfig(toml: string): string {
    const codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), toml, 'utf-8');
    return codexHome;
  }

  it('merges config.toml model + bundled (config model first, hide excluded)', () => {
    const codexHome = writeConfig(
      [
        'model = "glm-5.2"',
        'model_provider = "volcengine-coding-plan"',
        '',
        '[model_providers.volcengine-coding-plan]',
        'name = "volcengine-coding-plan"',
        'base_url = "https://example.com"',
        'env_key = "ARK_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    const cfg = loadCodexConfig({ codexHome });
    const opts = cfg.modelOptions();

    // glm-5.2 (config model) 在首位；bundled 非 hide 模型按 priority 跟随；不含 hide
    expect(opts).toEqual(['glm-5.2', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4']);
    expect(opts).not.toContain('codex-auto-review');
    expect(cfg.currentModel).toBe('glm-5.2');
    expect(cfg.currentProvider).toBe('volcengine-coding-plan');
  });

  it('dedupes when config model also appears in bundled catalog', () => {
    const codexHome = writeConfig(
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "openai"',
        '',
        '[model_providers.openai]',
        'name = "openai"',
        'base_url = "https://api.openai.com"',
        'env_key = "OPENAI_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    const opts = loadCodexConfig({ codexHome }).modelOptions();

    // gpt-5.6-sol 只出现一次（在首位）
    expect(opts.filter((m) => m === 'gpt-5.6-sol')).toHaveLength(1);
    expect(opts[0]).toBe('gpt-5.6-sol');
  });

  it('always includes openai in providerNames even when not declared in config.toml', () => {
    const codexHome = writeConfig(
      [
        'model = "glm-5.2"',
        'model_provider = "volcengine-coding-plan"',
        '',
        '[model_providers.volcengine-coding-plan]',
        'name = "volcengine-coding-plan"',
        'base_url = "https://example.com"',
        'env_key = "ARK_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    const cfg = loadCodexConfig({ codexHome });

    // openai 是内置 provider，即使 config.toml 没声明也要出现在列表中
    expect(cfg.providerNames).toContain('openai');
    expect(cfg.providerNames).toContain('volcengine-coding-plan');
    // openai 应在列表首位（unshift）
    expect(cfg.providerNames[0]).toBe('openai');
  });

  it('falls back to FALLBACK_MODELS (with currentModel first) when bundled fails', () => {
    const codexHome = writeConfig(
      [
        'model = "glm-5.2"',
        'model_provider = "volcengine-coding-plan"',
        '',
        '[model_providers.volcengine-coding-plan]',
        'name = "volcengine-coding-plan"',
        'base_url = "https://example.com"',
        'env_key = "ARK_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    mockSpawnSync.mockReturnValue(syncErr('spawn ENOENT'));

    const opts = loadCodexConfig({ codexHome }).modelOptions();

    expect(opts[0]).toBe('glm-5.2');
    expect(opts).toContain('o3');
    expect(opts).toContain('gpt-4o');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns fallback providers + merged options when config.toml absent', () => {
    mockSpawnSync.mockReturnValue(syncOk(BUNDLED_JSON));

    const cfg = loadCodexConfig({ codexHome: path.join(tmpRoot, 'no-such-home') });
    const opts = cfg.modelOptions();

    // config absent -> 默认模型取目录首个可用（codex default_model_from_available），
    // 不再虚构 'o3'；fallback provider 只含 openai（anthropic 非 codex 内置，P3-2 对齐）
    expect(opts[0]).toBe('gpt-5.6-sol');
    expect(opts).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4']);
    expect(cfg.currentModel).toBe('gpt-5.6-sol');
    expect(cfg.providerNames).toEqual(['openai']);
  });
});
