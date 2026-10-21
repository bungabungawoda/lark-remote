/**
 * 共享 `asAgentRunner`：把通用 Runner 包装成 AgentRunner。
 *
 * 5 个 bridge/usage 测试各持一份逐字同构副本（默认 kind、空 sessionReader、
 * getStatusInfo）。bridge 应优先使用 registry 里的真实 reader；这里的
 * sessionReader 仅作兜底/负向哨兵，可用 opts.sessionReader 替换。
 */
import type { AgentKind, AgentRunner, Runner } from '../../src/runner/index.js';

export interface AsAgentRunnerOpts {
  /** getStatusInfo 返回的 model 名（默认 'test'）。 */
  model?: string;
  /** 覆盖默认空结果 sessionReader。 */
  sessionReader?: AgentRunner['sessionReader'];
}

export function asAgentRunner(
  r: Runner,
  kind: AgentKind,
  opts: AsAgentRunnerOpts = {},
): AgentRunner {
  return {
    ...r,
    kind,
    sessionReader: opts.sessionReader ?? {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind, model: opts.model ?? 'test' }),
  };
}
