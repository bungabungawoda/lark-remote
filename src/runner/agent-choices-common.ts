import type { AgentKind } from './types.js';

/** 一对需要同步的字段：agents.<agent> 上的配置键 ↔ agentChoices.<agent> 上的选择键。 */
export interface ChoiceField {
  configKey: string;
  choicesKey: string;
}

/**
 * 非 claude agent 的字段映射表。
 *
 * claude 的配置在顶层 `config.claude`，不走 agents/agentChoices，因此不在此表中。
 * syncAgentChoices（保存配置时写入 agentChoices）与 resolveAgentChoices（启动时
 * 恢复）共用这张表，新增字段只需改一处。
 */
export const AGENT_CHOICE_FIELDS: Record<Exclude<AgentKind, 'claude'>, readonly ChoiceField[]> = {
  codex: [
    { configKey: 'model', choicesKey: 'model' },
    { configKey: 'modelProvider', choicesKey: 'modelProvider' },
  ],
  pi: [
    { configKey: 'model', choicesKey: 'model' },
    { configKey: 'provider', choicesKey: 'provider' },
    { configKey: 'thinking', choicesKey: 'thinking' },
  ],
  opencode: [
    { configKey: 'modelID', choicesKey: 'modelID' },
    { configKey: 'providerID', choicesKey: 'providerID' },
  ],
  kimi: [
    { configKey: 'model', choicesKey: 'model' },
    { configKey: 'thinkingEffort', choicesKey: 'thinkingEffort' },
  ],
  // DSH has no model/provider choice fields (host endpoint is connection
  // config, not a per-run choice) — empty to satisfy the Record type.
  dsh: [],
};

/** 返回指定 agent 的字段映射；claude 或未知 agent 返回 undefined。 */
export function choiceFieldsFor(agent: string): readonly ChoiceField[] | undefined {
  return (AGENT_CHOICE_FIELDS as Record<string, readonly ChoiceField[] | undefined>)[agent];
}
