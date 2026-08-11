/**
 * Anchor Test: P1-15 — Claude factory must read config from configContainer, not startup closure
 *
 * ① 验证什么行为：
 *   src/runner/factory.ts 中 claude agent 工厂必须通过 agentRegistry.getConfigContainer()
 *   读取最新配置，而非闭包中的启动时 config 快照。这是 P1-15 修复的核心：
 *   运行时 config 变更（model, effort, stopGraceMs）在 bridge.setConfig() +
 *   clearRunners() 后必须生效。
 *
 * ② 缺失/错误会导致什么问题：
 *    如果 claude factory 被回退为 `const claudeConfig = config.claude`（启动时闭包），
 *    则运行时 setConfig() 修改的 model/effort 不会传递给新创建的 runner，
 *    用户改配置后仍使用旧模型运行。
 *
 * ③ 依据：factory.ts 的 createAgentRegistries 不导出、工厂闭包不可注入测试，
 *   故用源码级守卫。行为覆盖由 factory.test.ts 的 configContainer 动态切换测试提供；
 *   本测试是编译时/重构守卫——防止有人把 `(container?.current as AppConfig) ?? config`
 *   简化回 `config` 闭包模式时无声通过。
 *
 * ④ 测试策略：
 *   - 正向断言：claude factory 中必须出现 `agentRegistry.getConfigContainer()` 调用
 *   - 正向断言：claude factory 中必须出现 `latestConfig.claude`（从 container 读取）
 *   - 反向断言：claude factory 中不得出现 `config.claude`（闭包旧模式）
 *   - 同样验证 codex factory 使用 `getConfigContainer()` 模式
 *   - 验证 `setConfigContainer` 被调用（确保 container 基础设施存在）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const factorySource = fs.readFileSync(path.join(process.cwd(), 'src/runner/factory.ts'), 'utf-8');

/**
 * Extract the body of a specific agent's factory closure from factory.ts source.
 * Returns the source between `agentRegistry.register('agentName', (ws) => {` and the matching `});`
 *
 * CAVEAT: brace balancing ignores braces inside string/template literals.
 * Currently safe because factory bodies don't contain template literals,
 * but a future refactor adding `${...}` would break the depth counter.
 */
function extractFactoryBody(source: string, agentName: string): string {
  // Match agentRegistry.register('agentName', (ws) => { ... });
  // We need to find the opening and then balance braces to find the end.
  const registerPattern = new RegExp(
    `agentRegistry\\.register\\('${agentName}'\\s*,\\s*\\(ws[^)]*\\)\\s*=>\\s*\\{`,
  );
  const match = registerPattern.exec(source);
  if (!match) {
    throw new Error(`Could not find agentRegistry.register('${agentName}', ...) in factory.ts`);
  }

  const startIdx = match.index + match[0].length;
  let depth = 1;
  let endIdx = startIdx;

  for (let i = startIdx; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    if (depth === 0) {
      endIdx = i;
      break;
    }
  }

  return source.substring(startIdx, endIdx);
}

describe('P1-15: Claude factory configContainer wiring', () => {
  it('test_anchor_claude_factory_uses_configContainer_not_closure', () => {
    const claudeFactory = extractFactoryBody(factorySource, 'claude');

    // Positive: must read from configContainer
    expect(claudeFactory).toContain('agentRegistry.getConfigContainer()');

    // Positive: must use latestConfig.claude (from container), not config.claude (closure)
    expect(claudeFactory).toContain('latestConfig.claude');

    // Negative: must NOT use config.claude directly (old closure pattern)
    // The startup `config` variable is in scope — if factory uses it directly,
    // runtime config changes won't take effect.
    expect(claudeFactory).not.toMatch(/\bconfig\.claude\b/);
  });

  it('test_anchor_codex_factory_uses_configContainer_not_closure', () => {
    const codexFactory = extractFactoryBody(factorySource, 'codex');

    // Codex factory must also use configContainer
    expect(codexFactory).toContain('agentRegistry.getConfigContainer()');
    expect(codexFactory).toContain('latestConfig');

    // Negative: must NOT pass the startup closure `config` to getAgentConfig.
    // Old broken pattern: getAgentConfig(config, 'codex') — ignores runtime updates.
    expect(codexFactory).not.toMatch(/getAgentConfig\s*\(\s*config\b/);
  });

  it('test_anchor_configContainer_exists_in_createAgentRegistries', () => {
    // The configContainer must be set up (setConfigContainer call) so that
    // factories can read from it. Verify this call exists in createAgentRegistries.
    expect(factorySource).toContain('agentRegistry.setConfigContainer(');
  });
});
