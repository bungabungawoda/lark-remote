import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeConfigBuilder } from './claude.js';
import { CLAUDE_PERMISSION_MODES, type AppConfig } from '../../config/index.js';

vi.mock('../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/index.js')>();
  return {
    ...actual,
    MODEL_ID_TO_ALIAS: { 'claude-opus-5': 'opus', 'claude-sonnet-5': 'sonnet' },
    MODEL_ALIAS_TO_ID: { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5' },
    getModelOptionsFromSettings: vi.fn(() => ['opus', 'sonnet']),
    CLAUDE_EFFORTS: ['low', 'medium', 'high'],
  };
});

function makeConfig(overrides?: Record<string, unknown>): AppConfig {
  return {
    feishu: { appId: 'test', appSecret: 'test' },
    ...overrides,
  } as AppConfig;
}

/**
 * ClaudeConfigBuilder tests.
 *
 * findSettingsPath() checks CLAUDE_SETTINGS_PATH env first, then ~/.claude/settings.json.
 * To avoid depending on whether the developer's machine has ~/.claude/settings.json:
 * - "settings exists" tests: set CLAUDE_SETTINGS_PATH to a real temp file so findSettingsPath()
 *   returns a path, then rely on mocked getModelOptionsFromSettings for the return value.
 * - "settings absent" test: env path points at a non-existent file **and** os.homedir() is
 *   spied to an empty temp dir, so the default path cannot exist either.
 */
describe('ClaudeConfigBuilder', () => {
  let builder: ClaudeConfigBuilder;
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(() => {
    builder = new ClaudeConfigBuilder();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-test-'));
    settingsFile = path.join(tmpDir, 'settings.json');
    // Create a minimal settings file so findSettingsPath() succeeds via CLAUDE_SETTINGS_PATH
    fs.writeFileSync(settingsFile, '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDE_SETTINGS_PATH;
  });

  describe('findSettingsPath (via buildFields)', () => {
    it('neither env path nor ~/.claude/settings.json exists → default alias options', async () => {
      process.env.CLAUDE_SETTINGS_PATH = '/nonexistent/path/settings.json';
      // 家目录必须为空：开发者本机若有 ~/.claude/settings.json，findSettingsPath
      // 就返回它，于是断言只能写成 if/else 守卫——两条分支都算通过等于没断言。
      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      try {
        const config = makeConfig();
        const fields = builder.buildFields(config);
        const modelField = fields.find((f) => f.key === 'claude.model' && f.type === 'select');

        expect(modelField!.options).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
      } finally {
        homedirSpy.mockRestore();
      }
    });
  });

  describe('buildFields', () => {
    it('uses dynamic model options when settings file exists', async () => {
      process.env.CLAUDE_SETTINGS_PATH = settingsFile;
      const { getModelOptionsFromSettings } = await import('../../config/index.js');
      vi.mocked(getModelOptionsFromSettings).mockReturnValue(['opus', 'sonnet']);

      const config = makeConfig();
      const fields = builder.buildFields(config);

      const modelField = fields.find((f) => f.key === 'claude.model' && f.type === 'select');
      expect(modelField!.options).toEqual(['opus', 'sonnet']);
    });

    it('custom model not in options → shows in input field', async () => {
      process.env.CLAUDE_SETTINGS_PATH = settingsFile;
      const { getModelOptionsFromSettings } = await import('../../config/index.js');
      vi.mocked(getModelOptionsFromSettings).mockReturnValue(['opus', 'sonnet']);

      const config = makeConfig({ claude: { model: 'claude-custom-99' } });
      const fields = builder.buildFields(config);

      const modelSelect = fields.find((f) => f.key === 'claude.model' && f.type === 'select');
      const modelInput = fields.find((f) => f.key === 'claude.model' && f.type === 'input');

      // Custom model should not be selected in the dropdown
      expect(modelSelect!.currentValue).toBeUndefined();
      // Custom model should appear in the input field
      expect(modelInput!.currentValue).toBe('claude-custom-99');
    });

    it('resolves known model ID to alias for display', async () => {
      process.env.CLAUDE_SETTINGS_PATH = settingsFile;
      const { getModelOptionsFromSettings } = await import('../../config/index.js');
      vi.mocked(getModelOptionsFromSettings).mockReturnValue(['opus', 'sonnet']);

      const config = makeConfig({ claude: { model: 'claude-opus-5' } });
      const fields = builder.buildFields(config);

      const modelSelect = fields.find((f) => f.key === 'claude.model' && f.type === 'select');
      expect(modelSelect!.currentValue).toBe('opus');
    });

    it('known alias in options → selected in dropdown', async () => {
      process.env.CLAUDE_SETTINGS_PATH = settingsFile;
      const { getModelOptionsFromSettings } = await import('../../config/index.js');
      vi.mocked(getModelOptionsFromSettings).mockReturnValue(['opus', 'sonnet']);

      const config = makeConfig({ claude: { model: 'sonnet' } });
      const fields = builder.buildFields(config);

      const modelSelect = fields.find((f) => f.key === 'claude.model' && f.type === 'select');
      expect(modelSelect!.currentValue).toBe('sonnet');
    });

    it('includes permissionMode select with official Claude modes (manual alias hidden)', async () => {
      const config = makeConfig({ claude: { model: 'opus', permissionMode: 'manual' } });
      const fields = builder.buildFields(config);

      const permField = fields.find((f) => f.key === 'claude.permissionMode');
      expect(permField).toBeDefined();
      expect(permField!.type).toBe('select');
      // manual 是 default 的别名：配置为 manual 时按 default 显示，下拉无 manual 项
      expect(permField!.currentValue).toBe('default');
      const optionValues = (permField!.options ?? []).map((o) =>
        typeof o === 'string' ? o : o.value,
      );
      expect(optionValues).toEqual(CLAUDE_PERMISSION_MODES.filter((m) => m !== 'manual'));
      expect(optionValues).not.toContain('manual');
    });
  });

  describe('handleFieldChange', () => {
    it('returns [{key, value}] directly with no dependent field patches', () => {
      const config = makeConfig();
      const patches = builder.handleFieldChange('claude.model', 'sonnet', config);
      expect(patches).toEqual([{ key: 'claude.model', value: 'sonnet' }]);
    });

    it('passes through effort change unchanged', () => {
      const config = makeConfig();
      const patches = builder.handleFieldChange('claude.effort', 'high', config);
      expect(patches).toEqual([{ key: 'claude.effort', value: 'high' }]);
    });
  });
});
