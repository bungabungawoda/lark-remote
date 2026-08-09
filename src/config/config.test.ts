import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, getConfigValue, setConfigValue, AppConfigSchema } from './index.js';
import type { AppConfig } from './index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(yaml: string) {
  const p = path.join(tmpDir, 'config.yaml');
  fs.writeFileSync(p, yaml, 'utf-8');
  return p;
}

const VALID_CONFIG = `feishu:
  appId: cli_test123
  appSecret: secret_test123

claude:
  binary: claude
  model: claude-opus-4-8
  stopGraceMs: 5000

output:
  showThinking: true
  showToolUse: false
  showToolResult: false
`;

describe('loadConfig', () => {
  it('loads valid config', () => {
    const p = writeConfig(VALID_CONFIG);
    const config = loadConfig(p);
    expect(config.feishu.appId).toBe('cli_test123');
    expect(config.feishu.appSecret).toBe('secret_test123');
    expect(config.claude.binary).toBe('claude');
    expect(config.claude.model).toBe('claude-opus-4-8');
    expect(config.claude.stopGraceMs).toBe(5000);
    expect(config.output.showThinking).toBe(true);
  });

  it('fills defaults for optional fields', () => {
    const minimal = `feishu:
  appId: cli_test123
  appSecret: secret_test123
`;
    const p = writeConfig(minimal);
    const config = loadConfig(p);
    expect(config.claude.binary).toBe('claude');
    expect(config.claude.model).toBe('claude-opus-4-8');
    expect(config.claude.stopGraceMs).toBe(5000);
    expect(config.output.showThinking).toBe(true);
    // defaultAgent defaults to 'claude' when absent
    expect(config.defaultAgent).toBe('claude');
  });

  it('defaultAgent defaults to "claude" when absent', () => {
    const p = writeConfig(VALID_CONFIG);
    const config = loadConfig(p);
    expect(config.defaultAgent).toBe('claude');
  });

  it('defaultAgent accepts "codex" and "opencode"', () => {
    const withCodex = VALID_CONFIG + '\ndefaultAgent: codex\n';
    const p = writeConfig(withCodex);
    const config = loadConfig(p);
    expect(config.defaultAgent).toBe('codex');

    const withOpencode = VALID_CONFIG + '\ndefaultAgent: opencode\n';
    const p2 = writeConfig(withOpencode);
    const config2 = loadConfig(p2);
    expect(config2.defaultAgent).toBe('opencode');
  });

  it('defaultAgent rejects unknown values', () => {
    const bad = VALID_CONFIG + '\ndefaultAgent: gemini\n';
    const p = writeConfig(bad);
    expect(() => loadConfig(p)).toThrow();
  });

  it('generated template includes defaultAgent: claude', () => {
    const p = path.join(tmpDir, 'nested', 'config.yaml');
    expect(() => loadConfig(p)).toThrow();
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toMatch(/defaultAgent:\s*claude/);
  });

  it('generates template when config file missing', () => {
    const p = path.join(tmpDir, 'missing', 'config.yaml');
    expect(() => loadConfig(p)).toThrow(); // process.exit throws in vitest
    // Template should have been written
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toContain('appId');
    expect(content).toContain('appSecret');
  });

  it('reports validation errors for missing required fields', () => {
    const bad = `feishu:
  appId: ""
  appSecret: ""
`;
    const p = writeConfig(bad);
    expect(() => loadConfig(p)).toThrow();
  });
});

describe('getConfigValue', () => {
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'cli_x', appSecret: 'sec_x' },
    claude: {
      binary: 'claude',
      model: 'claude-opus-4-8',
      stopGraceMs: 5000,
    },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });

  it('gets top-level nested value', () => {
    expect(getConfigValue(config, 'feishu.appId')).toBe('cli_x');
  });

  it('gets deep nested value', () => {
    expect(getConfigValue(config, 'claude.stopGraceMs')).toBe(5000);
  });

  it('returns undefined for unknown key', () => {
    expect(getConfigValue(config, 'feishu.nonexistent')).toBeUndefined();
  });
});

describe('setConfigValue', () => {
  it('sets a value and persists to file', () => {
    const p = writeConfig(VALID_CONFIG);
    const config = loadConfig(p);
    const updated = setConfigValue(p, config, 'claude.model', 'claude-sonnet-4-20250514');
    expect(updated.claude.model).toBe('claude-sonnet-4-20250514');
    // Verify persisted
    const reloaded = loadConfig(p);
    expect(reloaded.claude.model).toBe('claude-sonnet-4-20250514');
  });

  it('parses boolean values', () => {
    const p = writeConfig(VALID_CONFIG);
    const config = loadConfig(p);
    const updated = setConfigValue(p, config, 'output.showToolUse', 'true');
    expect(updated.output.showToolUse).toBe(true);
  });

  it('parses numeric values', () => {
    const p = writeConfig(VALID_CONFIG);
    const config = loadConfig(p);
    const updated = setConfigValue(p, config, 'idle.watchdogMinutes', '20');
    expect(updated.idle.watchdogMinutes).toBe(20);
  });
});
