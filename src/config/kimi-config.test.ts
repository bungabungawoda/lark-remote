import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadKimiConfig, invalidateKimiConfigCache } from './kimi-config.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const mockExecFileSync = vi.mocked(await import('node:child_process')).execFileSync;

function makeProviderListJson(overrides: {
  models?: Record<string, object>;
  providers?: Record<string, object>;
}) {
  return JSON.stringify({
    providers: overrides.providers ?? {
      'kimi-code': { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.kimi.ai' },
    },
    models: overrides.models ?? {
      'kimi-code/k3': {
        provider: 'kimi-code',
        model: 'k3',
        maxContextSize: 128000,
        capabilities: ['coding'],
        displayName: 'K3',
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
      },
    },
  });
}

describe('loadKimiConfig', () => {
  beforeEach(() => {
    invalidateKimiConfigCache();
    vi.clearAllMocks();
  });

  it('returns default result when execFileSync throws', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('kimi not found');
    });

    const result = loadKimiConfig();

    expect(result.currentModel).toBe('kimi-code/k3');
    expect(result.modelOptions).toEqual([
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
    ]);
    expect(result.modelDisplayNames['kimi-code/k3']).toBe('K3');
    expect(result.modelEfforts['kimi-code/k3']).toEqual(['low', 'high', 'max']);
    expect(result.modelDefaultEfforts['kimi-code/k3']).toBe('max');
  });

  it('uses first modelOption as fallback when kimi-code/k3 does not exist', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/custom-a': {
              provider: 'kimi-code',
              model: 'custom-a',
              maxContextSize: 64000,
              capabilities: ['coding'],
              displayName: 'Custom A',
            },
            'kimi-code/custom-b': {
              provider: 'kimi-code',
              model: 'custom-b',
              maxContextSize: 64000,
              capabilities: ['coding'],
              displayName: 'Custom B',
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    // No kimi-code/k3, so first modelOption is the fallback
    expect(result.currentModel).toBe('kimi-code/custom-a');
    expect(result.modelOptions).toEqual(['kimi-code/custom-a', 'kimi-code/custom-b']);
    expect(result.modelDisplayNames['kimi-code/custom-a']).toBe('Custom A');
  });

  it('returns defaults when models object is empty', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(makeProviderListJson({ models: {} })));

    const result = loadKimiConfig();

    expect(result.currentModel).toBe('kimi-code/k3');
    expect(result.modelOptions).toEqual([
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
    ]);
  });

  it('caches result and does not call execFileSync again on second call', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(makeProviderListJson({})));

    const result1 = loadKimiConfig();
    const result2 = loadKimiConfig();

    expect(result1).toBe(result2);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('re-executes execFileSync after cache invalidation', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(makeProviderListJson({})));

    loadKimiConfig();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);

    invalidateKimiConfigCache();

    loadKimiConfig();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('populates modelOptions, modelDisplayNames, modelEfforts, modelDefaultEfforts from valid data', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/k3': {
              provider: 'kimi-code',
              model: 'k3',
              maxContextSize: 128000,
              capabilities: ['coding'],
              displayName: 'K3',
              supportEfforts: ['low', 'high', 'max'],
              defaultEffort: 'high',
            },
            'kimi-code/kimi-for-coding': {
              provider: 'kimi-code',
              model: 'kimi-for-coding',
              maxContextSize: 64000,
              capabilities: ['coding'],
              displayName: 'K2.7 Coding',
              supportEfforts: ['low', 'max'],
              defaultEffort: 'low',
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    expect(result.currentModel).toBe('kimi-code/k3');
    expect(result.modelOptions).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding']);
    expect(result.modelDisplayNames).toEqual({
      'kimi-code/k3': 'K3',
      'kimi-code/kimi-for-coding': 'K2.7 Coding',
    });
    expect(result.modelEfforts).toEqual({
      'kimi-code/k3': ['low', 'high', 'max'],
      'kimi-code/kimi-for-coding': ['low', 'max'],
    });
    expect(result.modelDefaultEfforts).toEqual({
      'kimi-code/k3': 'high',
      'kimi-code/kimi-for-coding': 'low',
    });
  });

  it('filters out efforts not in KIMI_THINKING_EFFORTS', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/k3': {
              provider: 'kimi-code',
              model: 'k3',
              maxContextSize: 128000,
              capabilities: ['coding'],
              displayName: 'K3',
              supportEfforts: ['low', 'medium', 'high', 'ultra', 'max'],
              defaultEffort: 'max',
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    // 'medium' and 'ultra' are not in KIMI_THINKING_EFFORTS
    expect(result.modelEfforts['kimi-code/k3']).toEqual(['low', 'high', 'max']);
  });

  it('falls back to FALLBACK_EFFORTS when all efforts are filtered out', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/k3': {
              provider: 'kimi-code',
              model: 'k3',
              maxContextSize: 128000,
              capabilities: ['coding'],
              displayName: 'K3',
              supportEfforts: ['turbo', 'ultra'],
              defaultEffort: 'ultra',
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    expect(result.modelEfforts['kimi-code/k3']).toEqual(['low', 'high', 'max']);
  });

  it('falls back to max when defaultEffort is not a valid KimiThinkingEffort', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/k3': {
              provider: 'kimi-code',
              model: 'k3',
              maxContextSize: 128000,
              capabilities: ['coding'],
              displayName: 'K3',
              supportEfforts: ['low', 'high', 'max'],
              defaultEffort: 'ultra',
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    expect(result.modelDefaultEfforts['kimi-code/k3']).toBe('max');
  });

  it('defaults to max when defaultEffort is not provided', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/k3': {
              provider: 'kimi-code',
              model: 'k3',
              maxContextSize: 128000,
              capabilities: ['coding'],
              displayName: 'K3',
              supportEfforts: ['low', 'high', 'max'],
              // no defaultEffort field
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    expect(result.modelDefaultEfforts['kimi-code/k3']).toBe('max');
  });

  it('uses FALLBACK_EFFORTS when supportEfforts is absent', () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from(
        makeProviderListJson({
          models: {
            'kimi-code/k3': {
              provider: 'kimi-code',
              model: 'k3',
              maxContextSize: 128000,
              capabilities: ['coding'],
              displayName: 'K3',
              // no supportEfforts field
            },
          },
        }),
      ),
    );

    const result = loadKimiConfig();

    expect(result.modelEfforts['kimi-code/k3']).toEqual(['low', 'high', 'max']);
  });
});
