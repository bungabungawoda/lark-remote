import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './index.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('agentChoices config', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-choices-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should accept agentChoices in config', () => {
    const configYaml = `
feishu:
  appId: test
  appSecret: test

defaultAgent: codex

agentChoices:
  codex:
    model: glm-5.2
    modelProvider: volcengine-coding-plan
  pi:
    model: glm-5.2
    provider: lt
    thinking: high
`;
    fs.writeFileSync(configPath, configYaml, 'utf-8');
    const config = loadConfig(configPath);

    expect(config.agentChoices?.codex?.model).toBe('glm-5.2');
    expect(config.agentChoices?.codex?.modelProvider).toBe('volcengine-coding-plan');
    expect(config.agentChoices?.pi?.model).toBe('glm-5.2');
    expect(config.agentChoices?.pi?.provider).toBe('lt');
    expect(config.agentChoices?.pi?.thinking).toBe('high');
  });

  it('should allow empty agentChoices', () => {
    const configYaml = `
feishu:
  appId: test
  appSecret: test

defaultAgent: claude
`;
    fs.writeFileSync(configPath, configYaml, 'utf-8');
    const config = loadConfig(configPath);

    expect(config.agentChoices).toBeUndefined();
  });
});
