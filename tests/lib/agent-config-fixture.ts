/**
 * 共享 agent 配置 fixture。
 *
 * codex 相关锚点此前各自手抄一份 `buildCodexConfig`（feishu/agents.codex/
 * idle/logging 逐字同构，仅 model/modelProvider/reasoningEffort 不同）。
 * 在这里提供单源工厂，调用方只传差异项。
 */
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';

export interface CodexConfigOpts {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  stopGraceMs?: number;
  /** 需要同时保留 claude 配置时传入（如卡片同时渲染 claude 分区）。 */
  claude?: { model?: string; effort?: string; stopGraceMs?: number };
}

export function makeCodexConfig(opts: CodexConfigOpts = {}): AppConfig {
  const {
    model = 'gpt-5.2',
    modelProvider = 'openai',
    reasoningEffort = 'medium',
    stopGraceMs = 5000,
    claude,
  } = opts;
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    ...(claude ? { claude: { model: 'opus', stopGraceMs: 5000, ...claude } } : {}),
    agents: {
      codex: {
        model,
        modelProvider,
        reasoningEffort,
        stopGraceMs,
      },
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}
