/**
 * 会话读取契约：`AgentSessionReader` 与其数据类型。
 *
 * 中立模块——runner 与 session 两侧都只是它的实现方/消费方。此前住在
 * `runner/types.ts` 里，于是 session/* 有十一处为了一个类型反向 import 上层
 * runner（runner ↔ session 双向循环的一半）；挪到这里后两边同向依赖它。
 */

/** Unified session descriptor returned by every AgentSessionReader. */
export interface AgentSession {
  sessionId: string;
  summary: string;
  mtime: number;
  /** DSH：session 创建时固定的 preset；其他 agent 无此概念（undefined）。 */
  agentPreset?: string;
  /**
   * 服务端投影已有的会话标题（DSH `projections.values.title`）。
   *
   * 与 `summary` 的区别：`summary` 是「首条用户输入」的兜底口径（claude /
   * codex / pi / kimi 无标题字段），`title` 是 agent 自己起的标题。列表卡
   * 用它决定标签文案（标题 / 会话摘要），缺省时回退 `summary`。
   */
  title?: string;
  /**
   * 最后一轮用户输入（服务端投影，单行预览）。
   *
   * 只给「列表响应里已顺带返回」的 reader 用（DSH 的 `turnOutline` 末条），
   * 目的是让列表卡不必为每行做一次全量内容读取。
   */
  lastUserMessage?: string;
  /** 最后一轮助手输出（服务端投影已截断，单行预览）。 */
  lastAssistantMessage?: string;
}

/** A single renderable event from session history. */
export interface AgentSessionContentEvent {
  type: string;
  /** 正文（展开后的面板内容）。 */
  content: string;
  /**
   * 面板标题（可选，覆盖 reader 的默认标签）。
   *
   * 折叠面板默认只显示标题：工具调用这种"标题即全部信息"的事件必须把
   * `bash — npm test` 这类摘要放进标题，否则折叠态只剩 `🔧 工具调用`。
   */
  title?: string;
  timestamp?: string;
}

export interface AgentSessionUsage {
  inputTokens: number;
  outputTokens: number;
  contextLength: number;
  /** Agent 上报的当前模型 context window 上限（codex token_count.info.model_context_window）。
   *  仅 codex 提供；缺省时卡片只显示绝对量、不显示百分比。 */
  contextLimit?: number;
  /** Claude auto-compact 次数（数 compact_boundary 事件）；codex/opencode 无此概念，留 undefined。 */
  compactCount?: number;
  /** 压缩前上下文水位（codex compact 后从会话 jsonl 读取，仅会话以压缩收尾时有值）。 */
  compactPreContextLength?: number;
  /** 从缓存读取的 token 数（节省的费用）。 */
  cacheReadTokens?: number;
  /** 新建缓存的 token 数。 */
  cacheCreationTokens?: number;
  /** Agent 声明的总量；展示用 max(total, 分项和)。 */
  totalTokens?: number;

  /** 会话累计 total token（所有 run 之和，含本次）。用于 Run 卡片"累计"展示。 */
  cumulativeTotalTokens?: number;
  /** 会话累计 input token（所有 run 之和，含本次）。用于 Run 卡片"累计"展示。 */
  cumulativeInputTokens?: number;
  /** 会话累计 output token（所有 run 之和，含本次）。 */
  cumulativeOutputTokens?: number;
  /** 会话累计 cache read token（所有 run 之和）。用于 Run 卡片展示累计缓存命中。 */
  cumulativeCacheReadTokens?: number;
  /** 会话累计 cache creation token（所有 run 之和）。 */
  cumulativeCacheCreationTokens?: number;
}

/**
 * 一张 run 卡的用量快照：`AgentSessionUsage` 的可选形态 + 只有 live 侧有的
 * 推理计数。桥侧记账、reducer 写入 RunState、渲染层格式化都吃这一份——
 * 字段清单原先手抄在 6 个 interface 里（§9.21「五处一致」靠人记），
 * 新增一个 usage 字段要同步改 6 处，漏一处就是卡片少一行。
 *
 * 中立层：card / bridge / runner / router 都引用它，谁也不向上依赖。
 */
export type UsageSnapshot = Partial<AgentSessionUsage> & {
  /** 推理 token（pi usage.reasoning 累加）；reader 契约里没有，只有 live 事件带。 */
  reasoningTokens?: number;
};

/** Unified session content payload returned by every AgentSessionReader. */
export interface SessionContent {
  events: AgentSessionContentEvent[];
  usage?: AgentSessionUsage;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
}

/**
 * Lightweight session summary used by `/resume` list prefetch.
 *
 * Carries only the display fields (title / recap / usage) — **no `events`
 * array**. Readers that can extract these without constructing the full event
 * list (e.g. codex, which would otherwise JSON.parse every response_item and
 * build an `events[]` that the prefetch immediately discards) implement the
 * optional `readSessionSummary` on `AgentSessionReader`.
 */
export interface SessionSummary {
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
  usage?: AgentSessionUsage;
}

/**
 * 手动压缩的在途状态（由会话里的 begin/terminal 记录重建）。
 * 只有把压缩写成 wire 状态机的 agent 能提供，见
 * {@link AgentSessionReader.readCompactionState}。
 */
export interface CompactionState {
  inFlight: boolean;
  /** 在途 begin 的 time（epoch ms）。 */
  inFlightSince?: number;
}

/**
 * Reads an agent's session history. Each agent implements its own (Claude reads
 * `~/.claude/projects/`, Codex calls `thread/list`, OpenCode calls `GET /session`).
 *
 * Q-C decision: `projectsDir` and other agent-specific path config live on the
 * concrete reader's constructor, NOT on these method opts. The router/bridge
 * depend only on this interface and never pass path config.
 */
export interface AgentSessionReader {
  /**
   * List sessions for a cwd, newest first by mtime.
   *
   * `sessions` is the page `[offset, offset+limit)` of the full set ordered
   * by mtime desc, with same-mtime ties broken by a deterministic secondary
   * key (sessionId/file path) so ordering is stable across calls. When
   * `limit` is omitted, codex/pi/kimi return their default-sized page
   * (default 20); claude/opencode return the full remaining set from
   * `offset`. `total` is ALWAYS the size of the full cwd-matched set before
   * pagination — never the truncated page length. A negative `offset` is
   * clamped to 0 (first page).
   */
  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number };
  getNewestSession(cwd: string): AgentSession | null;
  readSessionContent(sessionId: string, cwd: string, opts?: { maxEvents?: number }): SessionContent;
  /**
   * Optional lightweight summary for list-prefetch.
   *
   * Returns only the display fields (aiTitle/recap/displayTitle/usage) without
   * constructing the full `events` array. When absent, callers fall back to
   * `readSessionContent` and take the needed fields.
   */
  readSessionSummary?(sessionId: string, cwd: string): SessionSummary;
  /**
   * 这个会话此刻是否还在被使用。**证据强度按 reader 不同，调用方必须知道自己
   * 问的是哪一个**：
   *
   * - DSH：服务端事实（session 有在跑的 turn）。启动自动恢复路径用它，
   *   见 `src/index.ts` 的 `stillRunning` 分支。
   * - claude/codex/opencode/pi/kimi：只有「最近一段时间有写入」这一层文件证据
   *   （mtime + 末行终态标记），拿它当 turn 在跑会每次误报。
   *
   * 「agent 现在忙不忙」的运行时真相仍归 `bridge.isBusyFor(cwd)`（内存态，
   * 见 cmdPs）；本方法是文件/服务端侧的补充探针，不是它的替代品。
   */
  isSessionActive(sessionId: string, cwd: string): boolean;
  /**
   * 手动压缩是否已在途（只有把压缩写成 wire 状态机的 agent 能提供，目前 kimi）。
   * 未实现 = 该 agent 没有这个概念，调用方按「不在途」处理。
   */
  readCompactionState?(sessionId: string, cwd: string): CompactionState;
}
