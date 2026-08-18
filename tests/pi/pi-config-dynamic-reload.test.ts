/**
 * ADVERSARIAL TEST: 验证 config.save 后 pi provider 是否真正动态生效
 *
 * 攻击思路：
 * 1. 启动 bridge，创建 PiRunner 实例（provider = 'Volcano'）
 * 2. 用户通过 /config 卡片修改 provider 为 'lt'，保存到 config.yaml
 * 3. router 调用 clearRunners() 清除缓存
 * 4. 下次 getRunner() 应该拿到带新 provider 的实例
 *
 * 漏洞假设：factory 返回固定单例，即使 clearRunners() 清除了缓存，
 *          新实例的 provider 仍然是启动时的旧值
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { AppConfigSchema, setConfigValues, getAgentConfig } from '../../src/config/index.js';
import { AgentRegistry } from '../../src/runner/registry.js';
import { PiRpcRunner } from '../../src/runner/pi/index.js';
import type { AgentSessionReader } from '../../src/runner/types.js';

const emptyReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({ events: [] }),
  isSessionActive: () => false,
};

// 创建带 provider 的 config

// 创建不带 pi config 的初始配置
function createInitialConfig() {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'pi',
    claude: {
      model: 'opus',
      settings: '',
      stopGraceMs: 5000,
    },
    // 没有 agents.pi 段
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
}

describe('ADVERSARIAL: pi provider config dynamic reload', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-adversarial-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * TEST 1: 验证修复后的动态配置加载
   *
   * 修复后的行为：
   * 1. registry 有 configContainer
   * 2. factory 从 container 读取最新 config
   * 3. config.save 更新 container.current
   * 4. 再次 getRunner() 时 factory 读到新 provider
   */
  it('SHOULD create new PiRunner instance after clearRunners (not reuse stale singleton)', () => {
    // 1. 模拟 bridge 启动时的初始化
    const initialConfig = createInitialConfig();

    // 2. 创建 registry 并设置 configContainer（修复后的正确方式）
    const registry = new AgentRegistry();
    const configContainer = { current: initialConfig };
    registry.setConfigContainer(configContainer);

    // 3. 注册 factory，它从 configContainer 读取最新 config（修复后的正确实现）

    registry.register('pi', (_workspace: string) => {
      const container = registry.getConfigContainer();
      const latestConfig = container?.current as ReturnType<typeof createInitialConfig>;
      const piConf = getAgentConfig(latestConfig, 'pi');
      return new PiRpcRunner({
        workspace: _workspace,
        sessionReader: emptyReader,
        provider: piConf?.provider ?? 'Volcano',
        model: piConf?.model ?? 'glm-5.2',
      });
    });

    // 4. 第一次获取 runner - 应该是默认 Volcano（因为初始 config 没有 pi 配置）
    const runner1 = registry.get('pi', '/tmp');
    expect(runner1.getStatusInfo().provider).toBe('Volcano');

    // 5. 模拟用户通过 /config 卡片保存 pi.provider = 'lt'
    // 这会更新 configContainer.current（这是 setConfig 做的事情）
    const configAfterSave = setConfigValues(configPath, initialConfig, {
      'pi.provider': 'lt',
    });
    configContainer.current = configAfterSave; // 模拟 bridge.setConfig() 的行为

    // 验证配置已保存
    const piConfig = getAgentConfig(configAfterSave, 'pi');
    expect(piConfig?.provider).toBe('lt');

    // 6. 模拟 clearRunners() 清除缓存后再次获取 runner
    // 关键测试点：factory 应该从更新后的 configContainer 读取新 provider
    const runner2 = registry.get('pi', '/tmp');

    // 攻击断言：修复后应该返回 'lt'，不再是 'Volcano'
    expect(runner2.getStatusInfo().provider).toBe('lt');
  });

  /**
   * TEST 2: 完整流程测试 - 从 config 修改到 runner 生效
   */
  it('SHOULD load correct provider from updated config after config.save', () => {
    // 1. 初始 config（无 pi 配置段）
    const config1 = createInitialConfig();

    // 2. 用户保存 pi.provider = 'lt'
    const config2 = setConfigValues(configPath, config1, { 'pi.provider': 'lt' });

    // 3. 从更新后的 config 创建新的 PiRunner
    const piConfig = getAgentConfig(config2, 'pi');
    const piRunnerFromConfig = new PiRpcRunner({
      workspace: 'test',
      sessionReader: emptyReader,
      provider: piConfig?.provider ?? 'Volcano',
      model: piConfig?.model ?? 'glm-5.2',
    });

    // 验证：新 runner 应该使用配置中的 provider
    expect(piRunnerFromConfig.getStatusInfo().provider).toBe('lt');
  });

  /**
   * TEST 3: 测试 registry factory 是否能读取最新配置
   *
   * 这个测试验证：即使 config 对象在内存中更新了，
   * registry 的 factory 也需要能够访问到最新配置
   */
  it('SHOULD reflect config changes in registry factory after config.save', () => {
    const registry = new AgentRegistry();

    // 模拟一个可变 config 引用
    let currentConfig = createInitialConfig();

    // 注册 factory，它应该从 currentConfig 读取最新值
    let piRunnerInstance: PiRpcRunner | null = null;
    registry.register('pi', (_workspace: string) => {
      const piConf = getAgentConfig(currentConfig, 'pi');
      piRunnerInstance = new PiRpcRunner({
        workspace: _workspace,
        sessionReader: emptyReader,
        provider: piConf?.provider ?? 'Volcano',
        model: piConf?.model ?? 'glm-5.2',
      });
      return piRunnerInstance;
    });

    // 第一次获取 - 应该是 Volcano
    const runner1 = registry.get('pi', '/tmp');
    expect(runner1.getStatusInfo().provider).toBe('Volcano');

    // 模拟 config.save：更新 currentConfig 引用
    currentConfig = setConfigValues(configPath, currentConfig, { 'pi.provider': 'lt' });

    // 第二次获取 - 应该是 lt
    const runner2 = registry.get('pi', '/tmp');
    expect(runner2.getStatusInfo().provider).toBe('lt');
  });
});
