import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCodebuddyConfig, resolveCodebuddyConfigDir } from './codebuddy-config.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';

// 目录探针会 spawn 真二进制：测试一律 mock 掉（目录解析单测在 codebuddy-catalog.test.ts）。
vi.mock('./codebuddy-catalog.js', () => ({
  loadCodebuddyCatalog: vi.fn(() => null),
  THOUGHT_LEVEL_FALLBACK: [
    { value: 'enabled', name: 'On（默认）' },
    { value: 'disabled', name: 'Off' },
  ],
}));

describe('resolveCodebuddyConfigDir', () => {
  it('explicit configDir wins; default is ~/.codebuddy', () => {
    expect(resolveCodebuddyConfigDir('/tmp/cb-home')).toBe('/tmp/cb-home');
    expect(resolveCodebuddyConfigDir()).toMatch(/\.codebuddy$/);
    expect(resolveCodebuddyConfigDir('  ')).toMatch(/\.codebuddy$/);
  });
});

describe('loadCodebuddyConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-codebuddy-config-'));
  });

  afterEach(() => {
    rmRf(tmpDir);
  });

  it('reads the current model from settings.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ trustedDirectories: ['/home/user/**'], model: 'hy4-preview' }),
      'utf-8',
    );
    expect(loadCodebuddyConfig(tmpDir).currentModel).toBe('hy4-preview');
  });

  it('returns undefined when settings.json is missing or has no model（catalog 不可用回退）', () => {
    expect(loadCodebuddyConfig(tmpDir)).toEqual({
      currentModel: undefined,
      modelOptions: [],
      modelDisplayNames: {},
      modelCredits: {},
      thoughtLevels: [
        { value: 'enabled', name: 'On（默认）' },
        { value: 'disabled', name: 'Off' },
      ],
    });
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({}), 'utf-8');
    expect(loadCodebuddyConfig(tmpDir).currentModel).toBeUndefined();
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), 'not json', 'utf-8');
    expect(loadCodebuddyConfig(tmpDir).currentModel).toBeUndefined();
  });

  it('catalog wins over settings.json (model list + display names + thought levels)', async () => {
    const { loadCodebuddyCatalog } = await import('./codebuddy-catalog.js');
    vi.mocked(loadCodebuddyCatalog).mockReturnValue({
      models: [
        { id: 'hy4free', name: 'Hy4', efforts: ['high'] },
        { id: 'glm-5.3', name: 'GLM-5.3', efforts: [] },
      ],
      currentModelId: 'hy4-preview',
      thoughtLevels: [{ value: 'enabled', name: 'On (default)' }],
    });
    const result = loadCodebuddyConfig(tmpDir);
    expect(result.modelOptions).toEqual(['hy4free', 'glm-5.3']);
    expect(result.modelDisplayNames).toEqual({ hy4free: 'Hy4', 'glm-5.3': 'GLM-5.3' });
    expect(result.currentModel).toBe('hy4-preview');
    expect(result.thoughtLevels).toEqual([{ value: 'enabled', name: 'On (default)' }]);
  });
});
