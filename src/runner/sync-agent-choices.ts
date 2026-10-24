/**
 * Sync agent configuration to agentChoices.
 * Called when user saves config to remember their choices for quick switching.
 */
import type { AppConfig } from '../config/index.js';
import { choiceFieldsFor } from './agent-choices-common.js';

export function syncAgentChoices(config: AppConfig, agent: string): AppConfig {
  // claude 的配置在顶层 config.claude，不在 agents 下，无需同步
  const fields = choiceFieldsFor(agent);
  if (!fields || fields.length === 0) return config;

  const agents = config.agents as unknown as Record<string, unknown> | undefined;
  const agentCfg = agents?.[agent];
  if (!agentCfg) return config;

  const updated = structuredClone(config);
  const choices = (updated.agentChoices ??= {});
  const agentChoices = ((choices as Record<string, Record<string, unknown>>)[agent] ??= {});
  const source = agentCfg as Record<string, unknown>;

  for (const { configKey, choicesKey } of fields) {
    const value = source[configKey];
    // 显式空串也要同步（用户清空 = 回到默认）：旧真值判断不同步空串，
    // agentChoices 里残留上一次的选择——/config 卡片显示的与实际生效的
    // 配置从此分叉，重启后 resolve 还会把残留填回 config。
    if (value !== undefined) agentChoices[choicesKey] = value;
  }
  return updated;
}
