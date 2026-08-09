import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExecSync = vi.fn();
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));
vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

import { loadOpencodeConfig, invalidateOpencodeConfigCache } from './opencode-config.js';

beforeEach(() => {
  mockExecSync.mockReset();
  mockLogger.warn.mockReset();
  invalidateOpencodeConfigCache();
});

const VALID_OUTPUT = [
  'opencode/big-pickle',
  '',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
  '',
  'myprovider/my-model-1',
  '',
].join('\n');

describe('loadOpencodeConfig', () => {
  it('parses valid model list output', () => {
    mockExecSync.mockReturnValue(VALID_OUTPUT);

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['deepseek', 'myprovider', 'opencode']);
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(cfg.modelOptions('opencode')).toEqual(['big-pickle']);
    expect(cfg.modelOptions('myprovider')).toEqual(['my-model-1']);
    expect(cfg.modelOptions('nonexistent')).toEqual([]);
  });

  it('returns all models sorted when modelOptions called without provider', () => {
    mockExecSync.mockReturnValue(VALID_OUTPUT);

    const cfg = loadOpencodeConfig();
    const allModels = cfg.modelOptions();

    expect(allModels).toEqual(['big-pickle', 'deepseek-chat', 'deepseek-reasoner', 'my-model-1']);
  });

  it('returns fallback result when execSync throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('spawn opencode ENOENT');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual([
      'opencode',
      'deepseek',
      'minimax-cn-coding-plan',
      'myprovider',
      'volcengine-plan',
    ]);
    expect(cfg.modelOptions('opencode')).toEqual(['big-pickle']);
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-chat']);
    expect(cfg.modelOptions('minimax-cn-coding-plan')).toEqual(['MiniMax-M2.5']);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns fallback models when model list output is empty', () => {
    mockExecSync.mockReturnValue('');

    const cfg = loadOpencodeConfig();

    // Empty output means no providers parsed -> providerNames is []
    expect(cfg.providerNames).toEqual([]);
    expect(cfg.modelOptions()).toEqual([]);
    expect(cfg.modelOptions('opencode')).toEqual([]);
  });

  it('caches result: second call returns cached result without re-executing', () => {
    mockExecSync.mockReturnValue(VALID_OUTPUT);

    loadOpencodeConfig();
    loadOpencodeConfig();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('re-executes after cache invalidation', () => {
    mockExecSync.mockReturnValue(VALID_OUTPUT);

    loadOpencodeConfig();
    invalidateOpencodeConfigCache();
    loadOpencodeConfig();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('uses negative cache after failure: second call does not re-exec within TTL', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('spawn opencode ENOENT');
    });

    const cfg1 = loadOpencodeConfig();
    const cfg2 = loadOpencodeConfig();

    // Both calls hit execSync only once; second uses negative cache
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    // Both return fallback
    expect(cfg1.providerNames).toEqual(cfg2.providerNames);
    expect(cfg1.modelOptions('opencode')).toEqual(['big-pickle']);
    expect(cfg2.modelOptions('opencode')).toEqual(['big-pickle']);
  });

  it('returns fallback when output is not parseable as model lines', () => {
    mockExecSync.mockReturnValue('some random output\nno model headers here');

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual([]);
    expect(cfg.modelOptions()).toEqual([]);
  });

  it('handles model IDs with dots and underscores', () => {
    const output = 'provider-a/model.v2_beta\nprovider-b/gpt-4o-mini\n';
    mockExecSync.mockReturnValue(output);

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['provider-a', 'provider-b']);
    expect(cfg.modelOptions('provider-a')).toEqual(['model.v2_beta']);
    expect(cfg.modelOptions('provider-b')).toEqual(['gpt-4o-mini']);
  });

  it('dedupes models across providers in modelOptions()', () => {
    const output = 'provider-a/shared-model\nprovider-b/shared-model\n';
    mockExecSync.mockReturnValue(output);

    const cfg = loadOpencodeConfig();
    const allModels = cfg.modelOptions();

    // shared-model appears once after dedup
    expect(allModels).toEqual(['shared-model']);
  });

  it('sorts provider names alphabetically', () => {
    const output = 'zebra/z-model\nalpha/a-model\nmid/m-model\n';
    mockExecSync.mockReturnValue(output);

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['alpha', 'mid', 'zebra']);
  });
});

describe('fallback result structure', () => {
  it('has correct providerNames', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toContain('opencode');
    expect(cfg.providerNames).toContain('deepseek');
    expect(cfg.providerNames).toContain('minimax-cn-coding-plan');
    expect(cfg.providerNames).toContain('myprovider');
    expect(cfg.providerNames).toContain('volcengine-plan');
  });

  it('modelOptions without provider returns all fallback models sorted and deduped', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();
    const allModels = cfg.modelOptions();

    expect(allModels).toEqual(['MiniMax-M2.5', 'big-pickle', 'deepseek-chat']);
  });

  it('modelOptions for unknown provider returns empty array', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.modelOptions('nonexistent')).toEqual([]);
  });

  it('modelOptions for volcengine-plan returns empty array (no fallback models defined)', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.modelOptions('volcengine-plan')).toEqual([]);
  });
});
