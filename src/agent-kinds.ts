/**
 * Agent 名单单源（运行时数组 + 类型同源，二者不可能漂移）。
 *
 * 中立层：config（校验 defaultAgent）、session（按 agent 存 sessionId）、card
 * （显示名）、router（解析用户输入）、runner（实现各家 runner）都要用这个名字，
 * 谁都不该为了拿它去 import 别层的模块 —— 名单原先住在 runner/types.ts 时，
 * 地基层 config 就得反向 import 上层 runner。
 *
 * 历史上这份名单被手抄成多份（router 的 VALID_AGENTS、bridge 的 resume.compact
 * 校验、各 agent 的 config builder…），漂移过：dsh 加入后 bridge 的
 * resume.compact 仍只有 5 个，带 dsh 的 resume 卡片会静默退回 defaultAgent。
 * 新增 agent 只改这里。
 */
export const AGENT_KINDS = ['claude', 'codex', 'opencode', 'pi', 'kimi', 'dsh'] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** 用户可见 agent 显示名单源：启动注册与无 registry 的回退路径共用。 */
export const AGENT_DISPLAY_NAMES: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'Opencode',
  pi: 'Pi',
  kimi: 'Kimi',
  dsh: 'DSH',
};

/** 任意输入（卡片 payload / 命令行参数）是否是一个已知 agent 名。 */
export function isAgentKind(value: unknown): value is AgentKind {
  return AGENT_KINDS.includes(value as AgentKind);
}

/**
 * 解析用户给出的 agent 名，未知/缺省时回退 `fallback`。
 *
 * 判定此前抄了三份（router 的两处 resume 分支 + commands/resume.ts）；名单与
 * 判定同源才有意义——`resume.compact` 曾因手抄名单漏掉 dsh 而静默退回
 * defaultAgent（见 `AGENT_KINDS` 头注）。
 */
export function resolveAgentKind(value: unknown, fallback: AgentKind): AgentKind {
  return isAgentKind(value) ? value : fallback;
}
