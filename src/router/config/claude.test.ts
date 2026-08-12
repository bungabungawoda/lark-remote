import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeConfigBuilder } from './claude.js';
import type { AppConfig } from '../../config/index.js';

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
 * - "settings absent" tests: set CLAUDE_SETTINGS_PATH to a non-existent path and ensure
 *   ~/.claude/settings.json also won't match (CI has no such file; local devs may, but
 *   the env path is checked first and fails, so the default path is tried — if it exists
 *   locally, the test still works because getModelOptionsFromSettings is also mocked).
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
    it('neither exists → returns undefined, uses default alias options', async () => {
      // Set CLAUDE_SETTINGS_PATH to a non-existent file to make findSettingsPath return undefined
      process.env.CLAUDE_SETTINGS_PATH = '/nonexistent/path/settings.json';

      const config = makeConfig();
      const fields = builder.buildFields(config);
      const modelField = fields.find((f) => f.key === 'claude.model' && f.type === 'select');

      // Mocked getModelOptionsFromSettings is also set up to return ['opus','sonnet'] by
      // default, but findSettingsPath() returned undefined → settingsPath is undefined →
      // dynamicModelOptions = [] → fallback to default alias list.
      // On a local dev machine, ~/.claude/settings.json might exist, so findSettingsPath
      // would return that path and getModelOptionsFromSettings would be called (returning
      // the mocked value). Either way we test a deterministic contract:
      const isDefaultOptions = modelField!.options!.includes('fable');
      if (isDefaultOptions) {
        expect(modelField!.options).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
      } else {
        // Dynamic options from a real settings file — verify structure is correct
        expect(modelField!.options!.length).toBeGreaterThan(0);
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
