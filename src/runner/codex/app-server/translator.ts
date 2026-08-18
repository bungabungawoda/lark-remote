/**
 * CodexAppServerTranslator: translates protocol notifications and server
 * requests into AgentEvents.
 *
 * The translator is stateful per turn — it tracks the current turn's state,
 * accumulates deltas, and synthesizes the final ResultEvent when the turn
 * completes. Method names and parameter shapes follow the real Codex
 * app-server v2 protocol (see protocol-types.ts).
 */

import type { AgentEvent, TokenUsage, TurnStartedEvent, TurnDiffEvent } from '../../types.js';
import type {
  ApprovalView,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  ApprovalViewUpdatedEvent,
} from '../../types.js';
import {
  NotificationMethod,
  ServerRequestMethod,
  type AgentMessageDeltaNotification,
  type ReasoningSummaryTextDeltaNotification,
  type ReasoningTextDeltaNotification,
  type CommandExecutionOutputDeltaNotification,
  type PlanDeltaNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type ItemCompletedNotification,
  type ThreadTokenUsageUpdatedNotification,
  type ErrorNotification,
  type ServerRequestResolvedNotification,
  type ItemStartedNotification,
  type CommandExecutionRequestApprovalParams,
  type FileChangeRequestApprovalParams,
  type PermissionsRequestApprovalParams,
  type RequestPermissionProfile,
  type FileUpdateChange,
  type FileUpdateChangeKind,
  type CommandExecutionApprovalDecision,
  UNSUPPORTED_SERVER_REQUEST_METHODS,
} from './protocol-types.js';

export type TranslatorEvent =
  AgentEvent | TurnStartedEvent | TurnDiffEvent | ApprovalRequestedEvent | ApprovalResolvedEvent;

// =============================================================================
// Translator
// =============================================================================

export class CodexAppServerTranslator {
  private turnId: string = '';
  private threadId: string = '';
  private turnStatus: string = 'pending';
  /** Full agentMessage text per item id (item-scoped snapshot). */
  private textByItem = new Map<string, string>();
  /**
   * Reasoning content per item id: paragraphs keyed by `contentIndex`
   * (textDelta) plus the summary stream (summaryTextDelta). Each reasoning
   * item is isolated so interleaved items keep their own chronology.
   */
  private reasoningByItem = new Map<string, { content: Map<number, string>; summary: string }>();
  /** Full command output per item id (item-scoped snapshot). */
  private toolOutputByItem = new Map<string, string>();
  /** Full plan text per item id (item-scoped snapshot). */
  private planByItem = new Map<string, string>();
  /** commandExecution items that emitted item/started (tool block position anchor). */
  private startedToolItems = new Set<string>();
  /** fileChange items seen this turn, keyed by item id (item/started). */
  private fileChangeItems = new Map<string, FileUpdateChange[]>();
  /** File approvals whose item/started has not arrived yet (out-of-order flow). */
  private pendingFileApprovalByItemId = new Map<
    string,
    { requestId: number | string; view: ApprovalView }
  >();
  private usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    contextLimit?: number;
  } = { inputTokens: 0, outputTokens: 0 };
  private operationKind: 'exec' | 'compact' = 'exec';

  /**
   * Handle a notification from the server and return events.
   */
  handleNotification(method: string, params: unknown): TranslatorEvent[] {
    switch (method) {
      case NotificationMethod.TURN_STARTED:
        return this.handleTurnStarted(params as TurnStartedNotification['params']);
      case NotificationMethod.ITEM_STARTED:
        return this.handleItemStarted(params as ItemStartedNotification['params']);
      case NotificationMethod.AGENT_MESSAGE_DELTA:
        return this.handleAgentMessageDelta(params as AgentMessageDeltaNotification['params']);
      case NotificationMethod.REASONING_SUMMARY_TEXT_DELTA:
        return this.handleReasoningDelta(params as ReasoningSummaryTextDeltaNotification['params']);
      case NotificationMethod.REASONING_SUMMARY_PART_ADDED:
        return this.handleReasoningPartAdded();
      case NotificationMethod.REASONING_TEXT_DELTA:
        return this.handleReasoningTextDelta(params as ReasoningTextDeltaNotification['params']);
      case NotificationMethod.ITEM_COMPLETED:
        return this.handleItemCompleted(params as ItemCompletedNotification['params']);
      case NotificationMethod.COMMAND_EXECUTION_OUTPUT_DELTA:
        return this.handleCommandOutputDelta(
          params as CommandExecutionOutputDeltaNotification['params'],
        );
      case NotificationMethod.PLAN_DELTA:
        return this.handlePlanUpdated(params as PlanDeltaNotification['params']);
      case NotificationMethod.TOKEN_USAGE_UPDATED:
        return this.handleTokenUsageUpdated(
          params as ThreadTokenUsageUpdatedNotification['params'],
        );
      case NotificationMethod.TURN_COMPLETED:
        return this.handleTurnCompleted(params as TurnCompletedNotification['params']);
      case NotificationMethod.ERROR:
        return this.handleError(params as ErrorNotification['params']);
      case NotificationMethod.THREAD_COMPACTED:
        return this.handleThreadCompacted();
      case NotificationMethod.SERVER_REQUEST_RESOLVED:
        return this.handleServerRequestResolved(
          params as ServerRequestResolvedNotification['params'],
        );
      default:
        return [];
    }
  }

  /**
   * Handle a server request (incoming JSON-RPC request from server, e.g. approval).
   */
  handleServerRequest(id: number | string, method: string, params: unknown): TranslatorEvent[] {
    if (UNSUPPORTED_SERVER_REQUEST_METHODS.has(method)) {
      return [];
    }

    switch (method) {
      case ServerRequestMethod.COMMAND_EXECUTION_APPROVAL:
        return this.handleCommandApproval(id, params as CommandExecutionRequestApprovalParams);
      case ServerRequestMethod.FILE_CHANGE_APPROVAL:
        return this.handleFileApproval(id, params as FileChangeRequestApprovalParams);
      case ServerRequestMethod.PERMISSIONS_APPROVAL:
        return this.handlePermissionsApproval(id, params as PermissionsRequestApprovalParams);
      default:
        return [];
    }
  }

  /**
   * Synthesize a ResultEvent from the current turn state.
   * Called when the turn completes.
   */
  handleTurnCompleted(params?: TurnCompletedNotification['params']): TranslatorEvent[] {
    const turn = params?.turn;
    this.turnStatus = turn?.status ?? 'completed';

    const events: TranslatorEvent[] = [];

    // 兜底：turn.items 里权威 agentMessage / plan item 与已流式内容不一致或
    // 未发过（如 itemsView 摘要只含部分 item）时，补发 item 级快照。已一致则
    // 跳过，避免冗余事件（run-state 按 itemId 原地替换、幂等）。
    for (const item of turn?.items ?? []) {
      if (item.type === 'agentMessage') {
        const text = (item as { text?: string }).text ?? '';
        if (text && this.textByItem.get(item.id) !== text) {
          this.textByItem.set(item.id, text);
          events.push({
            type: 'turn_diff',
            text,
            itemId: item.id,
            complete: true,
            threadId: params?.threadId ?? this.threadId,
            turnId: params?.turn?.id ?? this.turnId,
            timestamp: this.now(),
          } as TurnDiffEvent);
        }
      } else if (item.type === 'plan') {
        // plan 是 EXPERIMENTAL 文本增量，不保证与最终 plan item 一致；
        // turn/completed 的权威 plan item 以此兜底校正。
        const planText = (item as { text?: string }).text ?? '';
        if (planText && this.planByItem.get(item.id) !== planText) {
          this.planByItem.set(item.id, planText);
          events.push({
            type: 'turn_diff',
            plan: planText,
            itemId: item.id,
            complete: true,
            threadId: params?.threadId ?? this.threadId,
            turnId: params?.turn?.id ?? this.turnId,
            timestamp: this.now(),
          } as TurnDiffEvent);
        }
      }
    }

    const usage: TokenUsage = {
      input_tokens: this.usage.inputTokens,
      output_tokens: this.usage.outputTokens,
      cache_read_tokens: this.usage.cachedInputTokens,
      total_tokens: this.usage.totalTokens,
      context_limit: this.usage.contextLimit,
    };

    // 语义保真：interrupted（审批超时/取消、/stop）与 failed（Agent 真失败）
    // 是性质不同的终态。interrupted 走独立 subtype，卡片不再误报「Agent 返回
    // 错误结果」；failed 保持 error。
    const subtype =
      turn?.status === 'failed'
        ? 'error'
        : turn?.status === 'interrupted'
          ? 'interrupted'
          : 'success';
    events.push({
      type: 'result',
      subtype,
      session_id: this.threadId,
      usage,
      errorMessage: turn?.error?.message,
    } as AgentEvent);

    return events;
  }

  /**
   * Get the current usage stats.
   */
  getUsage(): { inputTokens: number; outputTokens: number } {
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
    };
  }

  /**
   * Get the current turn status.
   */
  getTurnStatus(): string {
    return this.turnStatus;
  }

  /**
   * Set the operation kind (exec vs compact).
   */
  setOperationKind(kind: 'exec' | 'compact'): void {
    this.operationKind = kind;
  }

  // =========================================================================
  // Private notification handlers
  // =========================================================================

  private handleTurnStarted(params: TurnStartedNotification['params']): TranslatorEvent[] {
    this.threadId = params.threadId;
    this.turnId = params.turn.id;
    this.turnStatus = params.turn.status ?? 'inProgress';
    this.textByItem.clear();
    this.reasoningByItem.clear();
    this.toolOutputByItem.clear();
    this.planByItem.clear();
    this.startedToolItems.clear();
    this.fileChangeItems.clear();
    this.pendingFileApprovalByItemId.clear();

    return [
      {
        type: 'turn_started',
        threadId: params.threadId,
        turnId: params.turn.id,
        operationKind: this.operationKind === 'compact' ? 'compaction' : 'turn',
        timestamp: this.now(),
      } as TurnStartedEvent,
    ];
  }

  private handleAgentMessageDelta(
    params: AgentMessageDeltaNotification['params'],
  ): TranslatorEvent[] {
    const prev = this.textByItem.get(params.itemId) ?? '';
    const next = prev + params.delta;
    this.textByItem.set(params.itemId, next);
    return [
      {
        type: 'turn_diff',
        text: next,
        itemId: params.itemId,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: this.now(),
      } as TurnDiffEvent,
    ];
  }

  private handleReasoningDelta(
    params: ReasoningSummaryTextDeltaNotification['params'],
  ): TranslatorEvent[] {
    // summaryTextDelta 流的是摘要文本；与 content 段落分开累积，避免段落交错。
    const entry = this.reasoningEntry(params.itemId);
    entry.summary += params.delta;
    return [
      {
        type: 'turn_diff',
        reasoning: this.reasoningSnapshotFor(entry),
        itemId: params.itemId,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: this.now(),
      } as TurnDiffEvent,
    ];
  }

  private handleReasoningPartAdded(): TranslatorEvent[] {
    // 真实协议 `summaryPartAdded` 只携带 itemId/summaryIndex，不携带文本；
    // 摘要内容在 item/completed 的 reasoning item 里（handleItemCompleted）。
    // 此处保持 no-op，避免把 undefined 拼进推理快照。
    return [];
  }

  private handleItemCompleted(params: ItemCompletedNotification['params']): TranslatorEvent[] {
    const item = params.item;
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      // 权威文件变更（含聚合后的 diff）；以快照语义替换本 item 的变更列表。
      this.fileChangeItems.set(item.id, item.changes);
      return [
        {
          type: 'turn_diff',
          fileChanges: normalizeFileChanges(item.changes),
          itemId: item.id,
          complete: true,
          threadId: params.threadId,
          turnId: params.turnId,
          timestamp: this.now(),
        } as TurnDiffEvent,
      ];
    }
    if (item.type === 'reasoning') {
      const content = Array.isArray(item.content) ? (item.content as string[]) : [];
      const summary = Array.isArray(item.summary) ? (item.summary as string[]) : [];
      if (content.length > 0 || summary.length > 0) {
        // 权威内容：summary 优先展示，content 段落保留（per-item 替换）。
        const entry = this.reasoningEntry(item.id);
        entry.content = new Map(content.map((c, i) => [i, c]));
        entry.summary = summary.join('\n');
        return [
          {
            type: 'turn_diff',
            reasoning: this.reasoningSnapshotFor(entry),
            itemId: item.id,
            complete: true,
            threadId: params.threadId,
            turnId: params.turnId,
            timestamp: this.now(),
          } as TurnDiffEvent,
        ];
      }
    }
    if (item.type === 'commandExecution') {
      // 无 outputDelta 流时（短命令），用 item/completed 的聚合输出兜底；
      // 已流式输出则以累积快照收尾（complete 语义标记工具完成）。
      const accumulated = this.toolOutputByItem.get(item.id) ?? '';
      const aggregated = (item as { aggregatedOutput?: string | null }).aggregatedOutput;
      const authoritative = aggregated != null ? String(aggregated) : accumulated;
      // 从未 item/started 且无任何输出（如审批被拒的空命令）→ 不产生工具块，
      // 避免完成时刻凭空冒出一个空命令块。
      if (!authoritative && !this.startedToolItems.has(item.id)) {
        return [];
      }
      this.toolOutputByItem.set(item.id, authoritative);
      return [
        {
          type: 'turn_diff',
          toolOutput: authoritative,
          itemId: item.id,
          complete: true,
          toolStatus: commandExecutionStatusToToolStatus(
            (item as { status?: string | null }).status,
          ),
          threadId: params.threadId,
          turnId: params.turnId,
          timestamp: this.now(),
        } as TurnDiffEvent,
      ];
    }
    if (item.type === 'agentMessage') {
      // item/completed 的 agentMessage 带权威全文（text 字段）；以 item 级
      // 快照收尾，run-state 按 itemId 原地替换，保证内容收敛到权威值。
      const text = (item as { text?: string }).text ?? '';
      const accumulated = this.textByItem.get(item.id) ?? '';
      // 空最终文本但已有流式内容（异常边界）→ 用累积内容收尾，补齐 completedAt；
      // 完全无内容则没有块可完成，不发事件。
      if (text || accumulated) {
        const finalText = text || accumulated;
        this.textByItem.set(item.id, finalText);
        return [
          {
            type: 'turn_diff',
            text: finalText,
            itemId: item.id,
            complete: true,
            threadId: params.threadId,
            turnId: params.turnId,
            timestamp: this.now(),
          } as TurnDiffEvent,
        ];
      }
    }
    if (item.type === 'plan') {
      const text = (item as { text?: string }).text ?? '';
      if (text) {
        this.planByItem.set(item.id, text);
        return [
          {
            type: 'turn_diff',
            plan: text,
            itemId: item.id,
            complete: true,
            threadId: params.threadId,
            turnId: params.turnId,
            timestamp: this.now(),
          } as TurnDiffEvent,
        ];
      }
    }
    return [];
  }

  private handleReasoningTextDelta(
    params: ReasoningTextDeltaNotification['params'],
  ): TranslatorEvent[] {
    const index = params.contentIndex ?? 0;
    const entry = this.reasoningEntry(params.itemId);
    const prev = entry.content.get(index) ?? '';
    entry.content.set(index, prev + params.delta);
    return [
      {
        type: 'turn_diff',
        reasoning: this.reasoningSnapshotFor(entry),
        itemId: params.itemId,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: this.now(),
      } as TurnDiffEvent,
    ];
  }

  private handleCommandOutputDelta(
    params: CommandExecutionOutputDeltaNotification['params'],
  ): TranslatorEvent[] {
    const prev = this.toolOutputByItem.get(params.itemId) ?? '';
    const next = prev + params.delta;
    this.toolOutputByItem.set(params.itemId, next);
    return [
      {
        type: 'turn_diff',
        toolOutput: next,
        itemId: params.itemId,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: this.now(),
      } as TurnDiffEvent,
    ];
  }

  private handlePlanUpdated(params: PlanDeltaNotification['params']): TranslatorEvent[] {
    // 真实协议 plan/delta 是纯文本增量（EXPERIMENTAL），不能假设拼接与最终
    // plan item 一致；item/completed 会带权威 plan item（handleItemCompleted）。
    const prev = this.planByItem.get(params.itemId) ?? '';
    const next = prev + params.delta;
    this.planByItem.set(params.itemId, next);
    return [
      {
        type: 'turn_diff',
        plan: next,
        itemId: params.itemId,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: this.now(),
      } as TurnDiffEvent,
    ];
  }

  private handleTokenUsageUpdated(
    params: ThreadTokenUsageUpdatedNotification['params'],
  ): TranslatorEvent[] {
    const last = params.tokenUsage.last;
    this.usage = {
      inputTokens: last.inputTokens,
      outputTokens: last.outputTokens,
      cachedInputTokens: last.cachedInputTokens,
      totalTokens: last.totalTokens,
      contextLimit: params.tokenUsage.modelContextWindow,
    };
    return [];
  }

  private handleError(params: ErrorNotification['params']): AgentEvent[] {
    if (params.willRetry) {
      // 非终态错误：服务端会重试该 turn。提前结束 run 会造成桥与 server
      // 状态脱节（server 继续跑、卡片却已收场）。仅记录，等待后续通知。
      return [];
    }
    return [
      {
        type: 'result',
        subtype: 'error',
        session_id: this.threadId,
        errorMessage: params.error?.message ?? 'Codex app-server error',
      } as AgentEvent,
    ];
  }

  private handleThreadCompacted(): AgentEvent[] {
    return [
      {
        type: 'result',
        subtype: 'success',
        session_id: this.threadId,
      } as AgentEvent,
    ];
  }

  private handleServerRequestResolved(
    params: ServerRequestResolvedNotification['params'],
  ): ApprovalResolvedEvent[] {
    // 真实协议 serverRequest/resolved 只携带 requestId/threadId，无 outcome；
    // 过期态由桥侧 ApprovalCoordinator 的 timer 单独产出（approval_expired）。
    // requestId 保留原始 wire 值（schema: string | integer），不 Number() 归一，
    // 避免非数字字符串 id 被转成 NaN 后与 pendingApprovals / 卡片对不上。
    return [
      {
        type: 'approval_resolved',
        requestId: params.requestId,
        outcome: 'resolved',
        timestamp: new Date().toISOString(),
      } as ApprovalResolvedEvent,
    ];
  }

  // =========================================================================
  // Private approval handlers
  // =========================================================================

  private handleCommandApproval(
    requestId: number | string,
    params: CommandExecutionRequestApprovalParams,
  ): ApprovalRequestedEvent[] {
    const { decisions, payloads } = normalizeCommandDecisions(params.availableDecisions);
    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: params.command ?? undefined,
      commandCwd: params.cwd ?? undefined,
      reason: params.reason ?? undefined,
      availableDecisions: decisions,
      ...(payloads ? { decisionPayloads: payloads } : {}),
    };

    return [
      {
        type: 'approval_requested',
        requestId,
        kind: 'command',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view,
        timestamp: new Date().toISOString(),
      } as ApprovalRequestedEvent,
    ];
  }

  private handleFileApproval(
    requestId: number | string,
    params: FileChangeRequestApprovalParams,
  ): ApprovalRequestedEvent[] {
    // 真实协议：变更信息在 item/started 的 fileChange item（changes[]）里，
    // 审批请求只带 itemId（grantRoot/reason 实测为 null）。优先按 itemId 关联；
    // 关联不到时退回 grantRoot 合成条目（旧协议/兜底）。
    const storedChanges = this.fileChangeItems.get(params.itemId);
    const fileChanges = storedChanges
      ? normalizeFileChanges(storedChanges)
      : params.grantRoot
        ? [{ path: params.grantRoot, kind: 'update' as const, diff: '' }]
        : undefined;
    const view: ApprovalView = {
      requestId,
      kind: 'file',
      fileChanges,
      reason: params.reason ?? undefined,
      // 真实 FileChangeApprovalDecision 枚举：accept/acceptForSession/decline/cancel。
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    };

    // 乱序流：审批先到、item/started 后到。先出事件（回退信息），item 到达时
    // 以 approval_view_updated 补全，避免卡片永久空白。
    if (!storedChanges) {
      this.pendingFileApprovalByItemId.set(params.itemId, {
        requestId,
        view,
      });
    }

    return [
      {
        type: 'approval_requested',
        requestId,
        kind: 'file',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view,
        timestamp: new Date().toISOString(),
      } as ApprovalRequestedEvent,
    ];
  }

  private handleItemStarted(params: ItemStartedNotification['params']): TranslatorEvent[] {
    const item = params.item;
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      this.fileChangeItems.set(item.id, item.changes);
      const pending = this.pendingFileApprovalByItemId.get(item.id);
      if (pending) {
        this.pendingFileApprovalByItemId.delete(item.id);
        const fileChanges = normalizeFileChanges(item.changes);
        if (fileChanges.length > 0) {
          return [
            {
              type: 'approval_view_updated',
              requestId: pending.requestId,
              view: { ...pending.view, fileChanges },
              timestamp: new Date().toISOString(),
            } as ApprovalViewUpdatedEvent,
            {
              type: 'turn_diff',
              fileChanges,
              itemId: item.id,
              threadId: params.threadId,
              turnId: params.turnId,
              timestamp: this.now(),
            } as TurnDiffEvent,
          ];
        }
      }
      return [
        {
          type: 'turn_diff',
          fileChanges: normalizeFileChanges(item.changes),
          itemId: item.id,
          threadId: params.threadId,
          turnId: params.turnId,
          timestamp: this.now(),
        } as TurnDiffEvent,
      ];
    }
    if (item.type === 'commandExecution') {
      // item/started 锚定工具块位置（真实时序）：命令开始时即创建工具块，
      // 而不是等到首个输出 delta——否则后续 reasoning item 会插到 command 之前。
      this.startedToolItems.add(item.id);
      return [
        {
          type: 'turn_diff',
          toolOutput: '',
          itemId: item.id,
          threadId: params.threadId,
          turnId: params.turnId,
          timestamp: this.now(),
        } as TurnDiffEvent,
      ];
    }
    return [];
  }

  private handlePermissionsApproval(
    requestId: number | string,
    params: PermissionsRequestApprovalParams,
  ): ApprovalRequestedEvent[] {
    const permItems = this.buildPermissionItems(params.permissions);
    const view: ApprovalView = {
      requestId,
      kind: 'permissions',
      reason: params.reason ?? undefined,
      availableDecisions: ['accept', 'decline', 'cancel'],
      permissions: {
        items: permItems,
      },
    };

    return [
      {
        type: 'approval_requested',
        requestId,
        kind: 'permissions',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view,
        timestamp: new Date().toISOString(),
      } as ApprovalRequestedEvent,
    ];
  }

  private buildPermissionItems(profile: RequestPermissionProfile): Array<{
    id: string;
    label: string;
    target: { kind: 'network' } | { kind: 'fsRead' | 'fsWrite'; path: string };
    selected: boolean;
  }> {
    const items: Array<{
      id: string;
      label: string;
      target: { kind: 'network' } | { kind: 'fsRead' | 'fsWrite'; path: string };
      selected: boolean;
    }> = [];

    // entries 是结构化形式（[{ path, access }]），read/write 是 legacy 字符串数组。
    for (const entry of profile.fileSystem?.entries ?? []) {
      if (entry.access === 'read' || entry.access === 'write') {
        items.push({
          id: `fs-${entry.access}:${entry.path}`,
          label: `${entry.access === 'read' ? 'Read' : 'Write'}: ${entry.path}`,
          target: { kind: entry.access === 'read' ? 'fsRead' : 'fsWrite', path: entry.path },
          selected: false,
        });
      }
    }

    for (const path of profile.fileSystem?.read ?? []) {
      if (!items.some((i) => i.id === `fs-read:${path}`)) {
        items.push({
          id: `fs-read:${path}`,
          label: `Read: ${path}`,
          target: { kind: 'fsRead', path },
          selected: false,
        });
      }
    }

    for (const path of profile.fileSystem?.write ?? []) {
      if (!items.some((i) => i.id === `fs-write:${path}`)) {
        items.push({
          id: `fs-write:${path}`,
          label: `Write: ${path}`,
          target: { kind: 'fsWrite', path },
          selected: false,
        });
      }
    }

    if (profile.network?.enabled) {
      // 真实 AdditionalNetworkPermissions 只有 enabled 布尔开关（整体网络访问）。
      items.push({
        id: 'net:all',
        label: '网络访问',
        target: { kind: 'network' },
        selected: false,
      });
    }

    return items;
  }

  /** Get (or lazily create) the reasoning accumulator for one item. */
  private reasoningEntry(itemId: string): { content: Map<number, string>; summary: string } {
    let entry = this.reasoningByItem.get(itemId);
    if (!entry) {
      entry = { content: new Map<number, string>(), summary: '' };
      this.reasoningByItem.set(itemId, entry);
    }
    return entry;
  }

  /** Compose the display snapshot for one reasoning item (content + summary). */
  private reasoningSnapshotFor(entry: { content: Map<number, string>; summary: string }): string {
    const content = [...entry.content.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join('\n');
    return entry.summary ? `${content}\n${entry.summary}` : content;
  }

  /** Receive-time stamp, aligned with the exec JSONL parse path. */
  private now(): string {
    return new Date().toISOString();
  }
}

/** Normalize protocol change kind to the ApprovalView kind vocabulary. */
function normalizeChangeKind(kind: FileUpdateChangeKind): 'add' | 'update' | 'delete' {
  if (kind.type === 'add') return 'add';
  if (kind.type === 'delete') return 'delete';
  // 'move' and 'update' both surface as an update in the approval view.
  return 'update';
}

/**
 * Map protocol commandExecution item.status to the card tool status.
 * 真实枚举值未在协议 schema 中约束；对已知失败语义做防御性映射，
 * 未知/空值一律视为成功（与旧行为一致）。
 */
function commandExecutionStatusToToolStatus(status?: string | null): 'ok' | 'error' {
  if (!status) return 'ok';
  const s = status.toLowerCase();
  return s === 'failed' ||
    s === 'error' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'interrupted'
    ? 'error'
    : 'ok';
}

function normalizeFileChanges(
  changes: FileUpdateChange[],
): Array<{ path: string; kind: 'add' | 'update' | 'delete'; diff: string }> {
  return changes.map((change) => ({
    path: change.path,
    kind: normalizeChangeKind(change.kind),
    diff: change.diff,
  }));
}

/**
 * Normalize the real protocol decision list into canonical string keys plus
 * raw payloads for structured decisions (e.g. acceptWithExecpolicyAmendment).
 * Falls back to the legacy default when the server sends no list.
 */
function normalizeCommandDecisions(list?: CommandExecutionApprovalDecision[] | null): {
  decisions: string[];
  payloads?: Record<string, unknown>;
} {
  if (!list || list.length === 0) return { decisions: ['accept', 'decline', 'cancel'] };

  const decisions: string[] = [];
  const payloads: Record<string, unknown> = {};
  for (const decision of list) {
    if (typeof decision === 'string') {
      decisions.push(decision);
    } else if (decision && typeof decision === 'object') {
      const key = Object.keys(decision)[0];
      if (key) {
        decisions.push(key);
        payloads[key] = (decision as Record<string, unknown>)[key];
      }
    }
  }
  return {
    decisions,
    ...(Object.keys(payloads).length > 0 ? { payloads } : {}),
  };
}
