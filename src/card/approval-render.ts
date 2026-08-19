/**
 * renderApprovalArea: renders the approval request area in a run card.
 *
 * Renders command/file/permissions approval areas with button mappings per §8.3.
 * Uses CardKit 2.0 (no tag:"action" container — 200861 rule).
 */

import type { ApprovalView } from '../runner/types.js';

/** Unique nonce for card button callbacks (SDK dedup + router validation). */
function mkNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** reason div（3 处共用）；反引号中和防 lark_md 解析错误（review P2-2）。 */
function reasonDiv(approval: ApprovalView): object | null {
  if (!approval.reason) return null;
  const neutralized = approval.reason.replace(/`/g, '·');
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: `💡 ${neutralized}` },
  };
}

/**
 * Append a possibly-null element to the array (convenience for optional divs).
 * If the element is null, nothing is appended.
 */
function pushIf<T>(arr: T[], el: T | null): void {
  if (el !== null) arr.push(el);
}

/**
 * Render the approval area for a run card.
 * Returns an array of CardKit 2.0 elements to append to the card body.
 */
export function renderApprovalArea(
  approval: ApprovalView | undefined,
  opts?: { expired?: boolean; runId?: string; terminal?: string },
): object[] {
  if (!approval) return [];
  // 终态（done/error/interrupted/idle_timeout）下 run 已结束：coordinator 已
  // 释放，按钮点击无处响应，隐藏整个审批区避免"点了没反应"（P2-7）。
  if (opts?.terminal && opts.terminal !== 'running' && opts.terminal !== 'finalizing') {
    return [];
  }

  const elements: object[] = [];

  if (approval.kind === 'command') {
    elements.push(...renderCommandApproval(approval, opts?.expired, opts?.runId));
  } else if (approval.kind === 'tool') {
    elements.push(...renderToolApproval(approval, opts?.expired, opts?.runId));
  } else if (approval.kind === 'file') {
    elements.push(...renderFileApproval(approval, opts?.expired, opts?.runId));
  } else if (approval.kind === 'permissions') {
    elements.push(...renderPermissionsApproval(approval, opts?.expired, opts?.runId));
  } else if (approval.kind === 'question') {
    elements.push(...renderQuestionApproval(approval, opts?.expired, opts?.runId));
  }

  return elements;
}

/**
 * Render approval action buttons from the real protocol decision list.
 * accept and decline are always offered (decline is a universal safety
 * affordance even when the server omits it); acceptForSession and
 * acceptWithExecpolicyAmendment appear only when the server offers them.
 */
function renderDecisionButtons(
  approval: ApprovalView,
  expired?: boolean,
  runId?: string,
): object[] {
  if (expired) {
    return [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '⏰ **审批已过期**' },
      },
    ];
  }

  const BUTTONS: Record<string, { label: string; type: 'primary' | 'danger' }> = {
    accept: { label: '✅ 允许', type: 'primary' },
    acceptForSession: { label: '✅ 允许本次会话', type: 'primary' },
    acceptWithExecpolicyAmendment: { label: '🔒 允许并记住命令', type: 'primary' },
    acceptAll: { label: '✅ 允许所有', type: 'primary' },
    decline: { label: '❌ 拒绝', type: 'danger' },
  };
  // Fixed presentation order; only offer decisions the protocol listed
  // (accept/decline are always available; acceptAll is Claude 专属「允许所有」)。
  const offered = [
    'accept',
    'acceptForSession',
    'acceptWithExecpolicyAmendment',
    'acceptAll',
    'decline',
  ].filter((d) => d === 'accept' || d === 'decline' || approval.availableDecisions.includes(d));

  // 决策按钮逐个作为 body 直接元素返回（CardKit body 纵向堆叠 = 上下排列）。
  // 不能用 column_set width:auto 横排：手机窄屏下多个按钮挤在一行，按钮文字
  // 被截断成省略号，用户无法辨认审批动作。
  return offered.map((d) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: BUTTONS[d].label },
    type: BUTTONS[d].type,
    behaviors: [
      {
        type: 'callback',
        value: {
          cmd: 'approval.respond',
          decision: d,
          requestId: approval.requestId,
          runId,
          nonce: mkNonce(),
        },
      },
    ],
  }));
}

// =============================================================================
// Tool Approval (non-command tools, e.g. ExitPlanMode)
// =============================================================================

/**
 * 通用工具权限请求（kind === 'tool'）：展示工具名 + 用途说明（reason）+ 原始
 * input（若有）。ExitPlanMode 的 input 为空对象，工具名本身即审批内容，
 * 不再落入 command 槽位显示无意义 `{}`。
 */
function renderToolApproval(approval: ApprovalView, expired?: boolean, runId?: string): object[] {
  const elements: object[] = [];

  // ExitPlanMode 是「退出计划模式」：标题用计划审批语义；其他工具用通用标题。
  const isPlanExit = approval.toolName === 'ExitPlanMode';
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: isPlanExit ? '**📋 计划审批**' : '**🔧 工具请求**',
    },
  });

  const toolLabel = approval.toolName ?? '(unknown tool)';
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `🔧 \`${toolLabel}\`` },
  });

  pushIf(elements, reasonDiv(approval));

  // 原始 input（非空时展示，截断保护卡片预算；ExitPlanMode 的 `{}` 不展示）。
  if (approval.toolInput && approval.toolInput !== '{}') {
    const neutralized = approval.toolInput.replace(/`/g, '·');
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `\`${neutralized.slice(0, 500)}\`` },
    });
  }

  elements.push(...renderDecisionButtons(approval, expired, runId));

  return elements;
}

// =============================================================================
// Command Approval
// =============================================================================

function renderCommandApproval(
  approval: ApprovalView,
  expired?: boolean,
  runId?: string,
): object[] {
  const elements: object[] = [];

  // Command display
  // review P2-2：命令里的反引号会提前终止 lark_md 行内代码 span，奇数次
  // 反引号极易触发 11311 解析错误导致整卡失败（同 renderFileDiff 的中和策略）。
  const neutralizedCommand = (approval.command ?? '').replace(/`/g, '·');
  const cmdContent = neutralizedCommand
    ? `\`${neutralizedCommand.slice(0, 500)}\``
    : '(no command)';
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**⚡ 命令审批**\n${cmdContent}` },
  });

  if (approval.commandCwd) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📂 \`${approval.commandCwd}\`` },
    });
  }

  pushIf(elements, reasonDiv(approval));

  // Action buttons — derived from the real protocol decision list (see
  // renderDecisionButtons): accept/decline always, acceptForSession and
  // acceptWithExecpolicyAmendment only when the server offers them.
  elements.push(...renderDecisionButtons(approval, expired, runId));

  return elements;
}

// =============================================================================
// File Approval
// =============================================================================

function renderFileApproval(approval: ApprovalView, expired?: boolean, runId?: string): object[] {
  const elements: object[] = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '**📄 文件变更审批**' },
  });

  pushIf(elements, reasonDiv(approval));

  // File changes list
  if (approval.fileChanges && approval.fileChanges.length > 0) {
    // 审批区 diff 总预算：估算函数不计审批区，多文件大 diff 可能顶爆 28KB 卡
    // （ErrCode 11310）。与 tool-render 的 OUTPUT_MAX/BODY_TOTAL_MAX 同思路。
    const TOTAL_DIFF_CHARS = 2400;
    let renderedDiffChars = 0;
    let omittedDiffs = 0;
    for (const change of approval.fileChanges) {
      const icon = change.kind === 'add' ? '🆕' : change.kind === 'delete' ? '🗑️' : '✏️';
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${icon} \`${change.path}\` (${change.kind})` },
      });
      if (change.diff) {
        if (renderedDiffChars < TOTAL_DIFF_CHARS) {
          elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: renderFileDiff(change.diff) },
          });
          renderedDiffChars += Math.min(change.diff.length, MAX_DIFF_CHARS);
        } else {
          omittedDiffs += 1;
        }
      }
    }
    if (omittedDiffs > 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `_…${omittedDiffs} 个 diff 已省略（卡片预算）_` },
      });
    }
  }

  // Action buttons
  // Derived from the real protocol decision list (see renderDecisionButtons).
  elements.push(...renderDecisionButtons(approval, expired, runId));

  return elements;
}

/**
 * Render a file-change diff as a fenced code block.
 * Truncates to protect the 28KB card budget and neutralizes triple backticks
 * that would break the markdown fence (飞书 11311 类解析错误防线).
 */
function renderFileDiff(diff: string): string {
  const sanitized = diff.replace(/```/g, '···');
  const truncated =
    sanitized.length > MAX_DIFF_CHARS
      ? `${sanitized.slice(0, MAX_DIFF_CHARS)}\n…(diff 已截断)`
      : sanitized;
  return `\`\`\`diff\n${truncated}\n\`\`\``;
}

/** Per-diff render cap (chars), see TOTAL_DIFF_CHARS for the approval-area cap. */
const MAX_DIFF_CHARS = 1200;

// =============================================================================
// Permissions Approval
// =============================================================================

function renderPermissionsApproval(
  approval: ApprovalView,
  expired?: boolean,
  runId?: string,
): object[] {
  const elements: object[] = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '**🔒 权限审批**' },
  });

  pushIf(elements, reasonDiv(approval));

  // Permission items with toggle buttons
  if (approval.permissions?.items) {
    for (const item of approval.permissions.items) {
      const icon = item.selected ? '✅' : '⬜';
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${icon} ${item.label}` },
      });
      elements.push({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: item.selected ? '取消授予' : '授予',
        },
        type: item.selected ? 'default' : 'primary',
        size: 'small',
        behaviors: [
          {
            type: 'callback',
            value: {
              cmd: 'approval.toggle',
              requestId: approval.requestId,
              permId: item.id,
              selected: !item.selected,
              runId,
              nonce: mkNonce(),
            },
          },
        ],
      });
    }
  }

  // Action buttons
  // Derived from the real protocol decision list (see renderDecisionButtons).
  elements.push(...renderDecisionButtons(approval, expired, runId));

  return elements;
}

// =============================================================================
// AskUserQuestion Approval
// =============================================================================

/**
 * 渲染 Claude AskUserQuestion 选项卡（审批区复用）。
 *
 * - 单选问题：点击选项即选中（协调器在全部问题答完后自动提交）。
 * - 多选问题：点击切换勾选，勾选后出现「提交答案」按钮。
 * - 已选状态经 approval_view_updated 回流（view.questions[].selected）。
 */
function renderQuestionApproval(
  approval: ApprovalView,
  expired?: boolean,
  runId?: string,
): object[] {
  const elements: object[] = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '**❓ 需要你回答**' },
  });

  // Kimi elicitation form：完整题干只在 form message 里合并出现，概要行展示
  // 于提问卡顶部（数据驱动，Kimi runner 翻译时填充 approval.intro）。
  if (approval.intro) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📝 ${approval.intro}` },
    });
  }

  if (expired) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⏰ **审批已过期**' },
    });
    return elements;
  }

  const questions = approval.questions ?? [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = q.selected ?? [];
    const header = q.header || `问题 ${i + 1}`;
    const freeText = (q.options?.length ?? 0) === 0;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${header}**${q.multiSelect ? '（可多选）' : ''}\n${q.question}`,
      },
    });

    if (freeText) {
      // 自由文本题（Codex options:null / Pi extension input）：无选项行，
      // 直接渲染题面 + 输入框，提交走 answerCustom（coordinator 不要求有选项）。
      elements.push(renderAnswerInput(approval.requestId, i, q.placeholder ?? '输入回答…', runId));
      // 已答回显：input_value 不跨卡片更新保留，多题场景下用户提交后若还有
      // 其他问题未答，卡片必须展示已答文本（与自定义答案选中态同模式）。
      const answered = q.selected?.find((s) => s.length > 0);
      if (answered) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `✍️ 已答：${answered}` },
        });
      }
      continue;
    }

    for (const option of q.options ?? []) {
      const isSelected = selected.includes(option.label);
      // 单选/多选图标区分：单选 ⚪/🔵（radio 隐喻），多选 ⬜/☑️（checkbox 隐喻）。
      const icon = q.multiSelect ? (isSelected ? '☑️' : '⬜') : isSelected ? '🔵' : '⚪';
      elements.push(renderOptionRow(approval.requestId, i, option, isSelected, icon, runId));
    }

    // 自定义答案（Other）的选中态展示：选项按钮无法表示自由文本，单独显示
    // 已选文本，避免「点了没反应」的困惑（review P3）。
    const customSelected = q.selected?.find((s) => !q.options.some((o) => o.label === s));
    if (customSelected) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `✍️ 自定义答案：${customSelected}` },
      });
    }

    // review P3-4：单选问题提供自定义答案（Other）输入——输入文本后点击
    // 输入框右侧 ✓ 提交图标，input_value 经 connector raw 事件回传。
    // 显隐按 isOther !== false：Kimi form 会丢弃非声明选项值，翻译时置
    // isOther=false 隐藏输入；Claude 未设置该字段默认显示（行为不变）。
    if (!q.multiSelect && q.isOther !== false) {
      elements.push(
        renderAnswerInput(
          approval.requestId,
          i,
          '自定义答案（Other）…',
          runId,
          'approval.answerCustom',
        ),
      );
    }

    // Codex user_note：选项之外的补充说明（allowNote 数据驱动门控）。
    // 提交走 answerNote（coordinator 记录 note，随答案一起提交），已填回显。
    if (q.allowNote === true) {
      elements.push(
        renderAnswerInput(approval.requestId, i, '补充说明（可选）…', runId, 'approval.answerNote'),
      );
      if (q.note) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `📝 ${q.note}` },
        });
      }
    }

    // 多选问题：有勾选才给提交按钮（单选在协调器内即时提交）。
    if (q.multiSelect && selected.length > 0) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `✅ 提交答案（已选 ${selected.length} 项）` },
        type: 'primary',
        behaviors: [
          {
            type: 'callback',
            value: {
              cmd: 'approval.answerSubmit',
              requestId: approval.requestId,
              questionIndex: i,
              runId,
              nonce: mkNonce(),
            },
          },
        ],
      });
    }
  }

  // 提问卡底部统一「跳过回答」：走现有 approval.respond + decision=decline
  // （coordinator 对 question 允许 decline 作为安全兜底），runner 按协议映射
  // 跳过语义（Claude deny / Codex 空 answers / Kimi action decline / Pi cancelled）。
  if (!expired) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏭️ 跳过回答' },
      type: 'default',
      behaviors: [
        {
          type: 'callback',
          value: {
            cmd: 'approval.respond',
            decision: 'decline',
            requestId: approval.requestId,
            runId,
            nonce: mkNonce(),
          },
        },
      ],
    });
  }

  return elements;
}

/**
 * 选项行：左按钮右描述（固定 100px 按钮列保证对齐），单选/多选图标区分。
 * 与 renderAnswerInput 分开以便自由文本题不渲染选项行。
 */
function renderOptionRow(
  requestId: number | string,
  questionIndex: number,
  option: { label: string; description?: string },
  isSelected: boolean,
  icon: string,
  runId?: string,
): object {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: isSelected ? '取消选择' : '选择' },
            type: isSelected ? 'default' : 'primary',
            size: 'small',
            // 固定宽度让所有选项行的按钮左对齐（描述长短不影响按钮列）。
            width: '100px',
            behaviors: [
              {
                type: 'callback',
                value: {
                  cmd: 'approval.answer',
                  requestId,
                  questionIndex,
                  option: option.label,
                  runId,
                  nonce: mkNonce(),
                },
              },
            ],
          },
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `${icon} ${option.label}${
                option.description ? `\n_${option.description}_` : ''
              }`,
            },
          },
        ],
      },
    ],
  };
}

/**
 * 文本输入行（Other 输入与自由文本题共用）：输入后点击右侧 ✓ 提交图标，
 * input_value 经 connector raw 事件回传（CardKit input 的 input_value 会被
 * SDK normalizer 丢弃，必须走 includeRawEvent 路径）。
 */
function renderAnswerInput(
  requestId: number | string,
  questionIndex: number,
  placeholder: string,
  runId?: string,
  cmd: 'approval.answerCustom' | 'approval.answerNote' = 'approval.answerCustom',
): object {
  // name 必须含 cmd，保证同一题同时渲染多个输入框（如单选选项题的
  // Other 输入 + Note 输入）时元素 name 唯一——飞书对同卡内重复 name
  // 报 ErrCode 11310 拒绝整卡（2026-08-19 线上：name(answer-custom-0-0) duplicate）。
  const kind = cmd === 'approval.answerNote' ? 'note' : 'custom';
  return {
    tag: 'input',
    name: `answer-${kind}-${requestId}-${questionIndex}`,
    placeholder: { tag: 'plain_text', content: placeholder },
    behaviors: [
      {
        type: 'callback',
        value: {
          cmd,
          requestId,
          questionIndex,
          runId,
          nonce: mkNonce(),
        },
      },
    ],
  };
}
