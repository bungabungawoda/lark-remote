/**
 * TEST: pi provider config path mapping
 *
 * Bug: config 卡片字段 key 是 'pi.provider'，但 schema 期望 'agents.pi.provider'
 * 保存时路径不匹配，导致配置写到错误位置，PiRunner 启动时读不到配置只能用默认值
 *
 * 验证：保存 'pi.provider' 后，应该能从 config.agents.pi.provider 读取到值
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { setConfigValues, getAgentConfig, loadConfig } from '../../src/config/index.js';

describe('pi config path mapping bug', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-config-test-'));
    configPath = path.join(tmpDir, 'config.yaml');

    // 创建初始配置（没有 agents.pi 段）
    const initialConfig = {
      feishu: { appId: 'test', appSecret: 'test' },
      defaultAgent: 'claude',
      claude: {
        binary: 'claude',
        model: 'opus',
        settings: '',
        stopGraceMs: 5000,
      },
      idle: { watchdogMinutes: 15 },
      output: { showThinking: true, showToolUse: true, showToolResult: true },
      logging: { level: 'info' },
    };

    fs.writeFileSync(configPath, JSON.stringify(initialConfig), 'utf-8');
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * 这是核心 bug 测试：
   * 用户在 /config 卡片里设置 'pi.provider' = 'lt'
   * 期望保存后能从 config.agents.pi.provider 读取到 'lt'
   * 但实际上保存到了 config.pi.provider（不存在），导致 PiRunner 读不到
   */
  it('should save pi.provider to agents.pi.provider path', () => {
    // 1. 加载初始配置
    const config = loadConfig(configPath);

    // 2. 确认初始状态没有 agents.pi
    expect(config.agents?.pi).toBeUndefined();

    // 3. 保存 pi.provider 配置（这是用户在卡片里设置的 key）
    const updates = { 'pi.provider': 'lt' };
    setConfigValues(configPath, config, updates);

    // 4. 重新加载配置（模拟 bridge 重启后读取）
    const reloadedConfig = loadConfig(configPath);

    // 5. 验证：配置应该保存到 agents.pi.provider
    const piConfig = getAgentConfig(reloadedConfig, 'pi');

    // BUG: 当前会失败，因为配置写到了 config.pi 而不是 config.agents.pi
    expect(piConfig).toBeDefined();
    expect(piConfig?.provider).toBe('lt');
  });

  /**
   * 测试 pi.model 也应该正确保存到 agents.pi.model
   */
  it('should save pi.model to agents.pi.model path', () => {
    const config = loadConfig(configPath);

    const updates = { 'pi.model': 'glm-5.1' };
    setConfigValues(configPath, config, updates);

    const reloadedConfig = loadConfig(configPath);
    const piConfig = getAgentConfig(reloadedConfig, 'pi');

    // BUG: 当前会失败
    expect(piConfig).toBeDefined();
    expect(piConfig?.model).toBe('glm-5.1');
  });

  /**
   * 测试多个 pi 配置一起保存
   */
  it('should save multiple pi config fields together', () => {
    const config = loadConfig(configPath);

    const updates = {
      'pi.provider': 'lt',
      'pi.model': 'glm-5.1',
      'pi.thinking': 'high',
    };
    setConfigValues(configPath, config, updates);

    const reloadedConfig = loadConfig(configPath);
    const piConfig = getAgentConfig(reloadedConfig, 'pi');

    // BUG: 当前会失败
    expect(piConfig).toBeDefined();
    expect(piConfig?.provider).toBe('lt');
    expect(piConfig?.model).toBe('glm-5.1');
    expect(piConfig?.thinking).toBe('high');
  });
});
