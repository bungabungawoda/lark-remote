/**
 * QoderAcpTranslator: translates Qoder ACP session/update notifications,
 * session/request_permission server requests and elicitation/create forms into
 * AgentEvents.
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
 *
 * AskUserQuestion 走 elicitation form（initialize 声明 `elicitation.form` 后
 * Qoder 才保留工具）：字段 `title = header || question`，完整题干与选项描述
 * 合并在 `description`（首个换行前是题干），选项在 `oneOf` / `items.anyOf`
 * 的 `const` 里。
 */

import type { ApprovalView, UserQuestion } from '../../types.js';
import { makeQuestionApprovalEvent } from '../../question-common.js';
import {
  ServerRequestMethod,
  type AgentThoughtChunkEvent,
  type ElicitationCreateParams,
  type ElicitationEnumOption,
  type ElicitationPropertySchema,
  type RequestPermissionParams,
  type ToolCallEvent,
  type ToolCallUpdateEvent,
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

  protected override handleOtherServerRequest(
    requestId: number | string,
    method: string,
    params: unknown,
  ): AcpTranslatorEvent[] {
    if (method !== ServerRequestMethod.ELICITATION_CREATE) {
      return [];
    }
    return this.handleElicitationCreate(requestId, params as ElicitationCreateParams);
  }

  /**
   * Qoder elicitation form：requestedSchema.properties 按顺序解析为
   * UserQuestion[]（type:array → 多选；oneOf / items.anyOf 的 const → 选项
   * label）。Qoder 的字段 title 是短 header（`header || question`），完整题干
   * 在 description 第一行（后续行是 `label: description` 的选项说明），因此
   * question 取 description 首行，header 取 title；两者相同时直接用 title。
   * form 只接受声明选项 → isOther=false（卡片隐藏自定义答案输入）。
   */
  private handleElicitationCreate(
    requestId: number | string,
    params: ElicitationCreateParams,
  ): AcpTranslatorEvent[] {
    const properties = params.requestedSchema?.properties ?? {};
    const questions: UserQuestion[] = [];
    for (const [key, prop] of Object.entries(properties)) {
      const q = qoderElicitationPropertyToQuestion(prop);
      if (!q) {
        getLogger().warn(`[qoder-acp-translator] elicitation property skipped: key=${key}`);
        continue;
      }
      questions.push(q);
    }
    if (questions.length === 0) {
      // 无法解析 → 交还 runner 自动回 cancel（不悬挂服务端）。
      return [];
    }
    const message = params.message?.trim();
    const single = questions.length === 1;
    const intro = message && (!single || message !== questions[0]!.question) ? message : undefined;
    const event = makeQuestionApprovalEvent(requestId, questions, params.sessionId);
    if (intro) event.view.intro = intro;
    return [event];
  }
}

/**
 * elicitation schema property → UserQuestion（无法解析返回 null）。
 * Qoder 形状：title = header || question；description = [question,
 * ...options.map(`${label}: ${description}`)].join('\n')。选项描述已在
 * form 级 description 里，oneOf 条目的 description 不重复透传。
 */
function qoderElicitationPropertyToQuestion(prop: ElicitationPropertySchema): UserQuestion | null {
  const title = prop.title?.trim();
  if (!title) return null;
  const multiSelect = prop.type === 'array';
  const rawOptions = multiSelect ? prop.items?.anyOf : prop.oneOf;
  const options = (rawOptions ?? [])
    .filter((opt): opt is ElicitationEnumOption => typeof opt?.const === 'string')
    .map((opt) => ({ label: opt.const }));
  if (options.length === 0) return null;
  const firstLine = prop.description?.split('\n')[0]?.trim();
  const question = firstLine && firstLine !== title ? firstLine : title;
  return {
    question,
    header: title,
    multiSelect,
    isOther: false,
    options,
  };
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
