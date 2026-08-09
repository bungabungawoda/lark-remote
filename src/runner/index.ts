/**
 * Runner 模块入口
 *
 * 本文件负责：
 * 1. re-export 所有类型（从 types.ts）
 * 2. re-export AgentRunner 实现（从各 agent 目录）
 * 3. re-export 配置路由函数 resolveAgentChoices / syncAgentChoices
 * （共享工具由消费方直接 import `common/*` 具体模块，不走 barrel）
 */

// Re-export AgentRunner 实现（从各 agent 目录）
export { ClaudeRunner } from './claude/index.js';
export { CodexExecRunner } from './codex/index.js';
export { OpencodeExecRunner } from './opencode/index.js';
export { PiRunner } from './pi/index.js';
export { KimiRunner } from './kimi/index.js';
export { BashProcessRunner, type BashRunner } from './bash/index.js';

// Re-export registry
export { AgentRegistry } from './registry.js';

// =============================================================================
// 类型 re-export（从 types.ts）
// =============================================================================

export type {
  ResultEvent,
  PlanEvent,
  FileChangeEvent,
  AgentEvent,
  Runner,
  AgentKind,
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionUsage,
  SessionContent,
  AgentSessionReader,
  AgentRunner,
} from './types.js';

// =============================================================================
// 配置路由函数
// =============================================================================

export { resolveAgentChoices } from './resolve-agent-choices.js';
export { syncAgentChoices } from './sync-agent-choices.js';
