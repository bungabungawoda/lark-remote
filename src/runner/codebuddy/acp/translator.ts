/**
 * CodebuddyAcpTranslator: translates CodeBuddy ACP session/update notifications
 * and session/request_permission server requests into AgentEvents.
 *
 * Extends BaseAcpTranslator (shared envelope dispatch, prompt-response
 * stopReason mapping, tool_call normalization, usage occupancy). Content
 * channel: agent_message_chunk / agent_thought_chunk 的 `content.text` 是
 * 增量 delta（与 opencode 同语义），直接走 assistant 增量通道——无累积、
 * 无 turn_diff 快照。
 *
 * CodeBuddy 私有扩展（Agent Teams 成员消息/团队状态）不在这里处理：runner 的
 * handleNotification 先按 `_meta['codebuddy.ai/*']` 过滤（§9.27 同源教训——
 * 子线程/成员事件不得污染主会话时间线），进到 translator 的就是标准 ACP 事件。
 *
 * 工具事件：基类 rawInput 归一化 + kind→常用工具名映射；tool_result 内容从
 * rawOutput 对象取 `.text`（真机形状）。真量 token 在 usage_update 的
 * `_meta.usage`（`used/size` 恒 0），按 turn 累加后随 result 事件折叠。
 */

import type { ApprovalView } from '../../types.js';
import type {
  AgentThoughtChunkEvent,
  RequestPermissionParams,
  ToolCallEvent,
  ToolCallUpdateEvent,
  UsageUpdateEvent,
} from '../../common/acp/protocol-types.js';
import {
  deriveAcpAvailableDecisions,
  truncateWithEllipsis,
} from '../../common/acp/acp-approval.js';
import { getLogger } from '../../../logger/index.js';
import {
  acpStringify,
  BaseAcpTranslator,
  type AcpTranslatorEvent,
} from '../../common/acp/base-translator.js';

export class CodebuddyAcpTranslator extends BaseAcpTranslator {
  protected readonly logTag = 'codebuddy-acp-translator';

  /** 本 turn 的 live flow 累加器（translator 按 turn 新建 → 实例即 turn 生命周期）。 */
  private readonly turnFlow: TurnFlow = { input: 0, output: 0, cacheRead: 0, total: 0 };

  /**
   * thinking 增量的分块身份：CodeBuddy 真机（2.142.0）的 agent_thought_chunk
   * **不带** `messageId` 字段——块身份藏在 `_meta['codebuddy.ai/messageId']`
   * （同一 LLM 请求的 reasoning 增量共享它）。缺了 itemId 时卡片 thinking
   * 分块退化，所以两处都取。
   */
  protected override handleAgentThoughtChunk(
    event: AgentThoughtChunkEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
    // 真机不带 messageId 时退回 _meta；两条通道合并为一个可选 itemId。
    const itemId = event.messageId ?? thoughtItemIdFromMeta(event);
    return [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'thinking',
              thinking: event.content.text,
              ...(itemId ? { itemId } : {}),
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  /**
   * tool args 不从 content text 提取（返回 undefined → 基类兜底改用 rawInput
   * 归一化）。CodeBuddy 的 content 语义未验证，按「可能带输出快照」的保守
   * 口径，防止把输出当命令渲染——同 opencode 的防污染理由。
   */
  protected override extractToolCallArgsText(
    _event: ToolCallEvent | ToolCallUpdateEvent,
  ): string | undefined {
    return undefined;
  }

  protected override handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[] {
    if (!params.toolCall) {
      getLogger().info(
        `[codebuddy-acp-translator] permission request without toolCall, leaving to runner fallback (requestId=${requestId})`,
      );
      return [];
    }

    const rawInput = (params.toolCall.rawInput ?? {}) as Record<string, unknown>;
    const toolName = toolNameFromMeta(params.toolCall as { _meta?: Record<string, unknown> });
    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: approvalCommandFrom(rawInput, params.toolCall.title, toolName),
      reason: approvalReasonFrom(rawInput),
      availableDecisions: deriveAcpAvailableDecisions(params.options ?? []),
    };

    return this.approvalRequestedEvents(requestId, params.sessionId, view);
  }

  /**
   * tool_result 内容提取：CodeBuddy 的 rawOutput 是对象
   * `{type:'text', text:'Stdout: …'}`（真机 2.142.0 实测），直接透传会把
   * 对象整个塞进卡片——取 `.text`；字符串原样（kimi 语义兜底）。
   */
  protected override extractToolResultContent(event: ToolCallUpdateEvent): unknown {
    const rawOutput = event.rawOutput;
    if (rawOutput && typeof rawOutput === 'object') {
      const text = (rawOutput as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    if (typeof rawOutput === 'string') return rawOutput;
    return '';
  }

  /**
   * usage_update 的真量提取：CodeBuddy 的 `used/size` 恒为 0，token 明细在
   * `_meta.usage`（OpenAI 风格，真机实测）。一 turn 有多次模型请求 = 多条
   * usage_update，translator 按 turn 新建实例 → 实例内累加即为本 turn flow
   * （§9.21：多步 run 只取末条会低报）。口径：input = cache_miss（未命中
   * 缓存的输入）、cacheRead = cache_hit、output = completion（含 reasoning）。
   */
  protected override onUsageSample(event: UsageUpdateEvent): void {
    const metaUsage = (event as { _meta?: { usage?: Record<string, unknown> } })._meta?.usage;
    if (!metaUsage || typeof metaUsage !== 'object') return;
    const flow = usageFromMeta(metaUsage);
    this.turnFlow.input += flow.input;
    this.turnFlow.cacheRead += flow.cacheRead;
    this.turnFlow.output += flow.output;
    this.turnFlow.total += flow.total;
    this.hasLiveUsage = true;
    this.liveUsage = {
      input_tokens: this.turnFlow.input,
      output_tokens: this.turnFlow.output,
      total_tokens: this.turnFlow.total,
      ...(event.size > 0 ? { context_limit: event.size } : {}),
      ...(this.turnFlow.cacheRead > 0 ? { cache_read_tokens: this.turnFlow.cacheRead } : {}),
    } as typeof this.liveUsage;
  }
}

/** 一 turn 内逐模型请求累加的 flow（translator 按 turn 新建 → 实例即 turn 生命周期）。 */
export interface TurnFlow {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

/**
 * E7：审批卡片 command 的候选回退链 + 300 字截断（保留原截断与长度）。
 * 真机形状：Bash rawInput={command,description}、Read rawInput={file_path,limit}；
 * 卡片 command 列优先真实命令/文件路径（title 是带反引号的 shell 呈现串）。
 */
export function approvalCommandFrom(
  rawInput: Record<string, unknown>,
  title: string | undefined,
  toolName: string | undefined,
): string | undefined {
  const command =
    (typeof rawInput.command === 'string' && rawInput.command) ||
    (typeof rawInput.file_path === 'string' && rawInput.file_path) ||
    title ||
    toolName ||
    undefined;
  return command ? truncateWithEllipsis(command, 300) : undefined;
}

/** E7：reason 优先 description，否则 rawInput 序列化后截断到 200 兜底；最终统一再截断到 200。 */
export function approvalReasonFrom(rawInput: Record<string, unknown>): string | undefined {
  const reason =
    (typeof rawInput.description === 'string' && rawInput.description) ||
    (Object.keys(rawInput).length > 0
      ? truncateWithEllipsis(acpStringify(rawInput), 200)
      : undefined);
  return reason ? truncateWithEllipsis(reason, 200) : undefined;
}

/**
 * E8：`_meta.usage`（OpenAI 风格）归一化成本 turn 一条 flow。口径：input =
 * cache_miss、cacheRead = cache_hit、output = completion。cache_miss 缺字段时
 * 按 prompt − cacheHit 兜底；cache_hit 缺字段时按
 * prompt_tokens_details.cached_tokens 兜底。字段缺失一律按 0，不抛。
 */
export function usageFromMeta(metaUsage: Record<string, unknown>): TurnFlow {
  const num = (key: string): number => {
    const v = metaUsage[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const prompt = num('prompt_tokens');
  const cacheHit =
    num('prompt_cache_hit_tokens') ||
    ((metaUsage.prompt_tokens_details as { cached_tokens?: unknown } | null)?.cached_tokens as
      number | undefined) ||
    0;
  const input = num('prompt_cache_miss_tokens') || Math.max(0, prompt - cacheHit);
  return {
    input,
    output: num('completion_tokens'),
    cacheRead: cacheHit,
    total: num('total_tokens'),
  };
}

/** request_permission.toolCall 的 `_meta['codebuddy.ai/toolName']`（真名优先于 title）。 */
function toolNameFromMeta(toolCall: { _meta?: Record<string, unknown> }): string | undefined {
  const value = toolCall._meta?.['codebuddy.ai/toolName'];
  return typeof value === 'string' && value ? value : undefined;
}

/** `_meta['codebuddy.ai/messageId']` → thinking 块身份（字段缺失/类型不对 → undefined）。 */
function thoughtItemIdFromMeta(event: AgentThoughtChunkEvent): string | undefined {
  const meta = (event as { _meta?: Record<string, unknown> })._meta;
  const value = meta?.['codebuddy.ai/messageId'];
  return typeof value === 'string' && value ? value : undefined;
}
