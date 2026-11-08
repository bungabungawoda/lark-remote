/**
 * QoderAcpTranslator: translates Qoder ACP session/update notifications and
 * session/request_permission server requests into AgentEvents.
 *
 * Extends BaseAcpTranslator (shared envelope dispatch, prompt-response
 * stopReason mapping, tool_call normalization, usage occupancy). Content
 * channel: agent_message_chunk / agent_thought_chunk 的 `content.text` 是增量
 * delta，走基类默认直通。
 *
 * qoder ACP 的 wire 细节（thinking 块身份、tool content 语义、usage_update
 * 形状）尚未真机验证（2026-11-07 后端对新会话故障，验证被阻塞），因此全部按
 * 保守口径处理：
 * - tool content 不当 args（同 codebuddy 的防污染理由，基类兜底用 rawInput）；
 * - thinking 块身份只用 wire 自带的 messageId；
 * - tool_result 取对象 `.text` / 字符串透传（codebuddy 同款兜底）。
 * 真机验证后如出现 codebuddy 式 `_meta` 标记，再按实测形状补提取。
 */

import type { ApprovalView } from '../../types.js';
import type {
  AgentThoughtChunkEvent,
  RequestPermissionParams,
  ToolCallEvent,
  ToolCallUpdateEvent,
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

export class QoderAcpTranslator extends BaseAcpTranslator {
  protected readonly logTag = 'qoder-acp-translator';

  protected override handleAgentThoughtChunk(
    event: AgentThoughtChunkEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
    return [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'thinking',
              thinking: event.content.text,
              ...(event.messageId ? { itemId: event.messageId } : {}),
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  /**
   * tool args 不从 content text 提取（qoder 的 content 语义未验证，按「可能
   * 带输出快照」的保守口径，防止把输出当命令渲染——codebuddy 同款）。
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
        `[qoder-acp-translator] permission request without toolCall, leaving to runner fallback (requestId=${requestId})`,
      );
      return [];
    }

    const rawInput = (params.toolCall.rawInput ?? {}) as Record<string, unknown>;
    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: approvalCommandFrom(rawInput, params.toolCall.title),
      reason: approvalReasonFrom(rawInput),
      availableDecisions: deriveAcpAvailableDecisions(params.options ?? []),
    };

    return this.approvalRequestedEvents(requestId, params.sessionId, view);
  }

  /**
   * tool_result 内容提取：rawOutput 为对象时取 `.text`（qoder 形状未实测，
   * 沿用 codebuddy 已验证的兜底链），字符串原样，其余空串。
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
}

/** 审批 command 候选链：真实命令 → 文件路径 → title，300 字截断。 */
function approvalCommandFrom(
  rawInput: Record<string, unknown>,
  title: string | undefined,
): string | undefined {
  const command =
    (typeof rawInput.command === 'string' && rawInput.command) ||
    (typeof rawInput.file_path === 'string' && rawInput.file_path) ||
    title ||
    undefined;
  return command ? truncateWithEllipsis(command, 300) : undefined;
}

/** 审批 reason：优先 description，否则 rawInput 序列化截断到 200。 */
function approvalReasonFrom(rawInput: Record<string, unknown>): string | undefined {
  const reason =
    (typeof rawInput.description === 'string' && rawInput.description) ||
    (Object.keys(rawInput).length > 0
      ? truncateWithEllipsis(acpStringify(rawInput), 200)
      : undefined);
  return reason ? truncateWithEllipsis(reason, 200) : undefined;
}
