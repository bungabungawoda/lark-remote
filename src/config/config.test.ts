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

    expect(config.claude.model).toBe('claude-opus-4-8');
    expect(config.claude.stopGraceMs).toBe(5000);
    // claude 审批配置默认：bypassPermissions（保持旧行为）+ 5 分钟超时 + 30 分钟空闲回收
    expect(config.claude.permissionMode).toBe('bypassPermissions');
    expect(config.claude.approvalTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.claude.idleTtlMinutes).toBe(30);
    expect(config.output.showThinking).toBe(true);
    // defaultAgent defaults to 'claude' when absent
    expect(config.defaultAgent).toBe('claude');
  });

  it('claude permissionMode accepts official --permission-mode enum plus default', () => {
    for (const mode of [
      'default',
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]) {
      const p = writeConfig(`feishu:
  appId: cli_test123
  appSecret: secret_test123
claude:
  permissionMode: ${mode}
`);
      const config = loadConfig(p);
      expect(config.claude.permissionMode).toBe(mode);
    }
  });

  it('claude custom approvalTimeoutMs and idleTtlMinutes are honored', () => {
    const p = writeConfig(`feishu:
  appId: cli_test123
  appSecret: secret_test123
claude:
  approvalTimeoutMs: 120000
  idleTtlMinutes: 0
`);
    const config = loadConfig(p);
    expect(config.claude.approvalTimeoutMs).toBe(120000);
    expect(config.claude.idleTtlMinutes).toBe(0);
  });

  it('fresh config defaults codex to on-request / workspace-write', () => {
    const p = writeConfig(VALID_CONFIG);
    const config = loadConfig(p);

    // codex 恒为 app-server 模式，无运行模式字段
    expect(config.agents?.codex?.serviceMode).toBeUndefined();
    expect(config.agents?.codex?.approvalPolicy).toBe('on-request');
    expect(config.agents?.codex?.sandbox).toBe('workspace-write');
  });

  it('agents.opencode.mode defaults to build and accepts build/plan (§P5)', () => {
    const p = writeConfig(VALID_CONFIG + '\nagents:\n  opencode:\n    providerID: anthropic\n');
    const config = loadConfig(p);
    expect(config.agents?.opencode?.mode).toBe('build');

    const plan = writeConfig(
      VALID_CONFIG + '\nagents:\n  opencode:\n    providerID: anthropic\n    mode: plan\n',
    );
    expect(loadConfig(plan).agents?.opencode?.mode).toBe('plan');

    const invalid = writeConfig(
      VALID_CONFIG + '\nagents:\n  opencode:\n    providerID: anthropic\n    mode: oops\n',
    );
    expect(() => loadConfig(invalid)).toThrow();
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

  // Kimi ACP config schema

  it('kimi config defaults: permissionMode=manual', () => {
    const p = writeConfig(VALID_CONFIG + '\nagents:\n  kimi:\n    model: kimi-code/k3\n');
    const config = loadConfig(p);
    expect(config.agents?.kimi?.permissionMode).toBe('manual');
  });

  it('kimi config accepts permissionMode and acp sub-config', () => {
    const yaml =
      VALID_CONFIG +
      `
agents:
  kimi:
    model: kimi-code/k3
    permissionMode: yolo
    acp:
      binary: /usr/local/bin/kimi
      requestTimeoutMs: 30000
      idleTtlMs: 600000
      turnIdleTimeoutMinutes: 5
`;
    const p = writeConfig(yaml);
    const config = loadConfig(p);
    expect(config.agents?.kimi?.permissionMode).toBe('yolo');
    expect(config.agents?.kimi?.acp?.binary).toBe('/usr/local/bin/kimi');
    expect(config.agents?.kimi?.acp?.requestTimeoutMs).toBe(30000);
    expect(config.agents?.kimi?.acp?.idleTtlMs).toBe(600000);
    expect(config.agents?.kimi?.acp?.turnIdleTimeoutMinutes).toBe(5);
  });

  it('kimi config rejects invalid permissionMode value', () => {
    const bad =
      VALID_CONFIG + '\nagents:\n  kimi:\n    model: kimi-code/k3\n    permissionMode: always\n';
    const p = writeConfig(bad);
    expect(() => loadConfig(p)).toThrow();
  });

  it('kimi acp sub-config stays undefined when not set', () => {
    const yaml = VALID_CONFIG + '\nagents:\n  kimi:\n    model: kimi-code/k3\n';
    const p = writeConfig(yaml);
    const config = loadConfig(p);
    // acp is optional, so when not provided it stays undefined
    // (defaults are applied in KimiAcpRunner constructor, not in schema)
    expect(config.agents?.kimi?.acp).toBeUndefined();
  });

  it('kimi schema accepts permissionMode alongside model', () => {
    const yaml =
      VALID_CONFIG + '\nagents:\n  kimi:\n    model: kimi-code/k3\n    permissionMode: yolo\n';
    const p = writeConfig(yaml);
    const config = loadConfig(p);
    expect(config.agents?.kimi?.permissionMode).toBe('yolo');
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
