import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockLogger } from '../../tests/lib/logger-mock.js';

const mockSpawnSync = vi.fn();
const mockResolveExecutable = vi.fn();

vi.mock('../platform/command.js', () => ({
  resolveExecutable: (...args: unknown[]) => mockResolveExecutable(...args),
}));
vi.mock('../platform/spawn.js', () => ({
  useDetachedProcessGroup: vi.fn(() => true),
  spawnProcessSync: (...args: unknown[]) => mockSpawnSync(...args),
}));
vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

import { loadOpencodeConfig, invalidateOpencodeConfigCache } from './opencode-config.js';

beforeEach(() => {
  mockSpawnSync.mockReset();
  mockResolveExecutable.mockReset();
  mockResolveExecutable.mockReturnValue({ kind: 'direct', file: '/usr/local/bin/opencode' });
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
    mockSpawnSync.mockReturnValue({ status: 0, stdout: VALID_OUTPUT, stderr: '' });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['deepseek', 'myprovider', 'opencode']);
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(cfg.modelOptions('opencode')).toEqual(['big-pickle']);
    expect(cfg.modelOptions('myprovider')).toEqual(['my-model-1']);
    expect(cfg.modelOptions('nonexistent')).toEqual([]);
  });

  it('returns all models sorted when modelOptions called without provider', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: VALID_OUTPUT, stderr: '' });

    const cfg = loadOpencodeConfig();
    const allModels = cfg.modelOptions();

    expect(allModels).toEqual(['big-pickle', 'deepseek-chat', 'deepseek-reasoner', 'my-model-1']);
  });

  it('returns fallback result when execSync throws', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn opencode ENOENT');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['opencode', 'deepseek', 'minimax-cn-coding-plan']);
    expect(cfg.modelOptions('opencode')).toEqual(['big-pickle']);
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-chat']);
    expect(cfg.modelOptions('minimax-cn-coding-plan')).toEqual(['MiniMax-M2.5']);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns fallback models when model list output is empty', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    const cfg = loadOpencodeConfig();

    // Empty output means no providers parsed -> providerNames is []
    expect(cfg.providerNames).toEqual([]);
    expect(cfg.modelOptions()).toEqual([]);
    expect(cfg.modelOptions('opencode')).toEqual([]);
  });

  it('caches result: second call returns cached result without re-executing', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: VALID_OUTPUT, stderr: '' });

    loadOpencodeConfig();
    loadOpencodeConfig();

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('re-executes after cache invalidation', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: VALID_OUTPUT, stderr: '' });

    loadOpencodeConfig();
    invalidateOpencodeConfigCache();
    loadOpencodeConfig();

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('uses negative cache after failure: second call does not re-exec within TTL', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn opencode ENOENT');
    });

    const cfg1 = loadOpencodeConfig();
    const cfg2 = loadOpencodeConfig();

    // Both calls hit execSync only once; second uses negative cache
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    // Both return fallback
    expect(cfg1.providerNames).toEqual(cfg2.providerNames);
    expect(cfg1.modelOptions('opencode')).toEqual(['big-pickle']);
    expect(cfg2.modelOptions('opencode')).toEqual(['big-pickle']);
  });

  it('returns fallback when output is not parseable as model lines', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'some random output\nno model headers here',
      stderr: '',
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual([]);
    expect(cfg.modelOptions()).toEqual([]);
  });

  it('handles model IDs with dots and underscores', () => {
    const output = 'provider-a/model.v2_beta\nprovider-b/gpt-4o-mini\n';
    mockSpawnSync.mockReturnValue({ status: 0, stdout: output, stderr: '' });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['provider-a', 'provider-b']);
    expect(cfg.modelOptions('provider-a')).toEqual(['model.v2_beta']);
    expect(cfg.modelOptions('provider-b')).toEqual(['gpt-4o-mini']);
  });

  it('dedupes models across providers in modelOptions()', () => {
    const output = 'provider-a/shared-model\nprovider-b/shared-model\n';
    mockSpawnSync.mockReturnValue({ status: 0, stdout: output, stderr: '' });

    const cfg = loadOpencodeConfig();
    const allModels = cfg.modelOptions();

    // shared-model appears once after dedup
    expect(allModels).toEqual(['shared-model']);
  });

  it('sorts provider names alphabetically', () => {
    const output = 'zebra/z-model\nalpha/a-model\nmid/m-model\n';
    mockSpawnSync.mockReturnValue({ status: 0, stdout: output, stderr: '' });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toEqual(['alpha', 'mid', 'zebra']);
  });
});

describe('fallback result structure', () => {
  it('has correct providerNames', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.providerNames).toContain('opencode');
    expect(cfg.providerNames).toContain('deepseek');
    expect(cfg.providerNames).toContain('minimax-cn-coding-plan');
  });

  it('modelOptions without provider returns all fallback models sorted and deduped', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();
    const allModels = cfg.modelOptions();

    expect(allModels).toEqual(['MiniMax-M2.5', 'big-pickle', 'deepseek-chat']);
  });

  it('modelOptions for unknown provider returns empty array', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const cfg = loadOpencodeConfig();

    expect(cfg.modelOptions('nonexistent')).toEqual([]);
  });
});
