/**
 * renderApprovalArea: renders the approval request area in a run card.
 *
 * Renders command/file/permissions approval areas with button mappings.
 * Uses CardKit 2.0 (no tag:"action" container — 200861 rule).
 */

import type { ApprovalView } from '../runner/types.js';
import { collapsibleMarkdownPanel } from './collapsible.js';
import { truncateMarkdownTables } from './text-truncate.js';
import { truncateUtf8 } from '../common/truncate.js';
import { cardButton } from './card-shared.js';
import { countCardElements } from './card-budget.js';
import { isRunActive, type RunTerminal } from './run-state.js';

/** Unique nonce for card button callbacks (SDK dedup + router validation). */
function mkNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 计划面板正文字节预算（折叠展示 + 截断保护 28KB 卡片预算）。 */
const PLAN_PANEL_BYTES = 6000;

/**
 * 审批区自由文本字段（reason/note/题面/描述/回执等 agent 产出的散文）的统一
 * 字节预算。这些字段此前无上限：实测 reason 30,000 字符 → 整卡 31,450 字节被
 * 飞书 11310 拒收，审批彻底不可见，run 只能挂到审批超时/看门狗。1KB 足以传达
 * 语义并支撑决策。
 */
const APPROVAL_FIELD_BYTES = 1000;

/** 短标签类字段（题头/工具名/路径）的字节预算。 */
const APPROVAL_LABEL_BYTES = 300;

/**
 * 提问批次的渲染上限：题数 × 每题元素（选项行 + 输入框 + 按钮）撑爆的是元素
 * 数预算（实测 8 题 × 5 选项 = 144 元素 > 90 上限 → 11310 整卡报废）。超出的
 * 题折叠为计数提示；被折叠的题无法在卡上作答（整批「跳过」与 Web UI/终端
 * 兜底），仍远好于整卡被拒、一题都答不了。
 */
const MAX_RENDERED_QUESTIONS = 5;
/** 单题选项渲染上限（超过折叠为计数提示；选项 label 是回调 payload，不可截断）。 */
const MAX_RENDERED_OPTIONS = 8;
/** 文件变更 / 权限条目的渲染上限（每条 1–2 个元素，无上限时百条级直接爆元素预算）。 */
const MAX_RENDERED_CHANGE_ITEMS = 20;

/**
 * 审批区自身的元素数预算：卡总预算（MAX_CARD_ELEMENTS=90）减去状态行 / goal /
 * summary / 操作行等骨架（约 20 个，含极端情况的余量）后的安全份额。按已渲染
 * 元素数**自适应**截断——固定题数 × 选项数的组合上限挡不住「少题多选项」与
 * 「多题少选项」的两种组合（一行选项 = column_set + button + div 共 3 个
 * 元素，5 题 × 5 选项就 ~92 个）。
 */
const APPROVAL_AREA_ELEMENT_BUDGET = 50;

/** 审批区自由文本统一入口：反引号中和（防 11311）+ 字节预算截断（防 11310）。 */
function capApprovalText(text: string, maxBytes: number = APPROVAL_FIELD_BYTES): string {
  return truncateUtf8(text.replace(/`/g, '·'), maxBytes);
}

/** reason div（3 处共用）；反引号中和防 lark_md 解析错误 + 字节预算截断。 */
function reasonDiv(approval: ApprovalView): object | null {
  if (!approval.reason) return null;
  const neutralized = capApprovalText(approval.reason);
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
  opts?: { expired?: boolean; runId?: string; terminal?: RunTerminal },
): object[] {
  if (!approval) return [];
  // 终态（done/error/interrupted/idle_timeout）下 run 已结束：coordinator 已
  // 释放，按钮点击无处响应，隐藏整个审批区避免"点了没反应"。
  if (isTerminalHidden(opts)) return [];

  const elements: object[] = [];

  if (approval.note) {
    const neutralized = capApprovalText(approval.note);
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `ℹ️ ${neutralized}` },
    });
  }

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

  // 响应发送失败：明确告知原因 + 可重试，而不是静默停在可点状态。
  if (approval.deliveryError) {
    const neutralized = capApprovalText(approval.deliveryError);
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `⚠️ **审批提交失败**：${neutralized}\n可直接再次点击按钮重试。`,
      },
    });
  }

  return elements;
}

/**
 * 紧凑审批区（run 卡 skeleton/truncatedSkeleton 兜底档专用）：固定小体积的
 * 「标题 + 摘要 reason + 决策按钮」，不渲染正文/选项/题面。
 *
 * 为什么需要：完整审批区是唯一不受估算器管辖、也不参与 degraded/extreme 分层
 * 裁剪的区域； pathological 输入（超长 reason、题数×选项爆元素数）会让所有兜底
 * 层一起超限，超限卡被飞书整卡拒收（11310）→ 审批不可见。兜底层换用本入口后
 * 结构性保证 ≤ 几个元素 + ≤ 1KB 文本，审批入口（红线）在任何降级档都活着。
 */
export function renderApprovalAreaCompact(
  approval: ApprovalView | undefined,
  opts?: { expired?: boolean; runId?: string; terminal?: RunTerminal },
): object[] {
  if (!approval) return [];
  if (isTerminalHidden(opts)) return [];

  const elements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '✋ **等待审批**（内容过长已折叠，完整内容请查终端 / Web UI）',
      },
    },
  ];
  pushIf(elements, reasonDiv(approval));
  if (approval.kind === 'question') {
    if (opts?.expired) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: '⏰ **提问已超时**' } });
    } else {
      // 提问批次的紧凑形态只保留整批跳过（逐题作答 UI 被折叠）。
      elements.push(
        cardButton(
          '⏭️ 跳过回答',
          {
            cmd: 'approval.respond',
            decision: 'decline',
            requestId: approval.requestId,
            runId: opts?.runId,
            nonce: mkNonce(),
          },
          { type: 'default' },
        ),
      );
    }
  } else {
    elements.push(...renderDecisionButtons(approval, opts?.expired, opts?.runId));
  }
  return elements;
}

/** 终态隐藏判定（renderApprovalArea 与 compact 共用）：仍在推进的 run 不隐藏按钮。 */
function isTerminalHidden(opts?: { terminal?: RunTerminal }): boolean {
  return !!opts?.terminal && !isRunActive(opts.terminal);
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

  // ExitPlanMode 计划审批用 TUI 语义文案；其他审批保持原文案。
  const isPlanExit = approval.kind === 'tool' && approval.toolName === 'ExitPlanMode';
  const BUTTONS: Record<string, { label: string; type: 'primary' | 'default' | 'danger' }> = {
    accept: { label: isPlanExit ? '✅ 批准并执行' : '✅ 允许', type: 'primary' },
    acceptForSession: { label: '✅ 允许本次会话', type: 'primary' },
    acceptWithExecpolicyAmendment: { label: '🔒 允许并记住命令', type: 'primary' },
    acceptAll: { label: isPlanExit ? '✅ 批准并自动放行' : '✅ 允许所有', type: 'primary' },
    acceptWithFeedback: { label: '✍️ 批准并采纳修改', type: 'primary' },
    declineWithFeedback: { label: '✏️ 拒绝并附意见', type: 'default' },
    decline: { label: '❌ 拒绝', type: 'danger' },
  };
  // Fixed presentation order; only offer decisions the protocol listed
  // (accept/decline are always available; 其余按 availableDecisions 出现)。
  const offered = [
    'accept',
    'acceptForSession',
    'acceptWithExecpolicyAmendment',
    'acceptAll',
    'acceptWithFeedback',
    'declineWithFeedback',
    'decline',
  ].filter((d) => d === 'accept' || d === 'decline' || approval.availableDecisions.includes(d));

  // 决策按钮逐个作为 body 直接元素返回（CardKit body 纵向堆叠 = 上下排列）。
  // 不能用 column_set width:auto 横排：手机窄屏下多个按钮挤在一行，按钮文字
  // 被截断成省略号，用户无法辨认审批动作。
  return offered.map((d) =>
    cardButton(
      BUTTONS[d].label,
      {
        cmd: 'approval.respond',
        decision: d,
        requestId: approval.requestId,
        runId,
        nonce: mkNonce(),
      },
      { type: BUTTONS[d].type },
    ),
  );
}

// =============================================================================
// Tool Approval (non-command tools, e.g. ExitPlanMode)
// =============================================================================

/**
 * 通用工具权限请求（kind === 'tool'）：展示工具名 + 用途说明（reason）+ 原始
 * input（若有）。ExitPlanMode 走独立计划审批分支（计划全文 + 修改意见输入）。
 */
function renderToolApproval(approval: ApprovalView, expired?: boolean, runId?: string): object[] {
  // ExitPlanMode：对齐 TUI「先看完整计划再交互」——计划全文折叠面板 +
  // 修改意见输入 + 五决策按钮（批准并执行 / 批准并自动放行 / 拒绝并附意见 /
  // 批准并采纳修改 / 拒绝）。
  if (approval.toolName === 'ExitPlanMode') {
    return renderPlanApproval(approval, expired, runId);
  }

  const elements: object[] = [];

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '**🔧 工具请求**',
    },
  });

  const toolLabel = capApprovalText(approval.toolName ?? '(unknown tool)', APPROVAL_LABEL_BYTES);
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `🔧 \`${toolLabel}\`` },
  });

  pushIf(elements, reasonDiv(approval));

  // 原始 input（非空时展示，截断保护卡片预算；ExitPlanMode 的 `{}` 不展示）。
  if (approval.toolInput && approval.toolInput !== '{}') {
    const neutralized = capApprovalText(approval.toolInput, 500);
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `\`${neutralized}\`` },
    });
  }

  elements.push(...renderDecisionButtons(approval, expired, runId));

  return elements;
}

/**
 * ExitPlanMode 计划审批区：
 * - 计划全文（input.plan 或计划文件读取）折叠展示，反引号中和 + 表格限数 +
 *   字节预算截断；
 * - 计划文件路径（有则展示，含模型写错目录的退化场景）；
 * - 修改意见输入框（approval.planFeedback → coordinator 回流回显），供
 *   「拒绝并附意见」/「批准并采纳修改」复用；
 * - 决策按钮由 renderDecisionButtons 按 availableDecisions 渲染。
 */
function renderPlanApproval(approval: ApprovalView, expired?: boolean, runId?: string): object[] {
  const elements: object[] = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '**📋 计划审批**' },
  });

  pushIf(elements, reasonDiv(approval));

  if (approval.planFilePath) {
    const neutralizedPath = capApprovalText(approval.planFilePath, APPROVAL_LABEL_BYTES);
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📄 ${neutralizedPath}` },
    });
  }

  if (approval.plan) {
    // 反引号中和防 11311（同 reasonDiv/command 策略）；表格限数防 11310；
    // 字节预算截断防 28KB 超限。
    const neutralized = approval.plan.replace(/`/g, '·');
    const tableSafe = truncateMarkdownTables(neutralized);
    const content = truncateUtf8(tableSafe, PLAN_PANEL_BYTES);
    elements.push(
      collapsibleMarkdownPanel({
        title: '📋 计划',
        expanded: false,
        border: 'blue',
        content,
      }),
    );
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '📋 未获取到计划文件内容（可参考上方正文摘要）',
      },
    });
  }

  if (!expired) {
    elements.push(renderPlanFeedbackInput(approval.requestId, runId));
    if (approval.planFeedback) {
      const neutralized = capApprovalText(approval.planFeedback);
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `📝 ${neutralized}` },
      });
    }
  }

  elements.push(...renderDecisionButtons(approval, expired, runId));

  return elements;
}

/**
 * 计划修改意见输入行：输入后提交（移动端键盘回车/完成键，桌面端右侧提交图标），
 * input_value 经 connector raw 事件回传（CardKit input 的 input_value 会被
 * SDK normalizer 丢弃，必须走 includeRawEvent 路径，同 answerNote）。
 */
function renderPlanFeedbackInput(requestId: number | string, runId?: string): object {
  return {
    tag: 'input',
    name: `plan-feedback-${requestId}`,
    placeholder: {
      tag: 'plain_text',
      content: '填写修改意见（可配合「拒绝并附意见」/「批准并采纳修改」）…',
    },
    behaviors: [
      {
        type: 'callback',
        value: {
          cmd: 'approval.planFeedback',
          requestId,
          runId,
          nonce: mkNonce(),
        },
      },
    ],
  };
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
  // 命令里的反引号会提前终止 lark_md 行内代码 span，奇数次
  // 反引号极易触发 11311 解析错误导致整卡失败（同 renderFileDiff 的中和策略）。
  const neutralizedCommand = capApprovalText(approval.command ?? '', 500);
  const cmdContent = neutralizedCommand ? `\`${neutralizedCommand}\`` : '(no command)';
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**⚡ 命令审批**\n${cmdContent}` },
  });

  if (approval.commandCwd) {
    const neutralizedCwd = capApprovalText(approval.commandCwd, APPROVAL_LABEL_BYTES);
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📂 \`${neutralizedCwd}\`` },
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
    // 条目数上限（元素预算）：每条 1 path div + 至多 1 diff div，无上限时
    // 百条级变更直接撑爆元素数（>90 → 11310 整卡报废）。
    const changes = approval.fileChanges.slice(0, MAX_RENDERED_CHANGE_ITEMS);
    const omittedChanges = approval.fileChanges.length - changes.length;
    for (const change of changes) {
      const icon = change.kind === 'add' ? '🆕' : change.kind === 'delete' ? '🗑️' : '✏️';
      const path = capApprovalText(change.path, APPROVAL_LABEL_BYTES);
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${icon} \`${path}\` (${change.kind})` },
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
    if (omittedChanges > 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `_…另有 ${omittedChanges} 个文件变更未展示（卡片预算）_` },
      });
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
    // 条目数上限（元素预算）：每条 label div + toggle button 共 2 个元素。
    const items = approval.permissions.items.slice(0, MAX_RENDERED_CHANGE_ITEMS);
    const omittedItems = approval.permissions.items.length - items.length;
    for (const item of items) {
      const icon = item.selected ? '✅' : '⬜';
      // label 仅展示（payload 用 item.id），可安全截断。
      const label = capApprovalText(item.label, APPROVAL_LABEL_BYTES);
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${icon} ${label}` },
      });
      elements.push(
        cardButton(
          item.selected ? '取消授予' : '授予',
          {
            cmd: 'approval.toggle',
            requestId: approval.requestId,
            permId: item.id,
            selected: !item.selected,
            runId,
            nonce: mkNonce(),
          },
          { type: item.selected ? 'default' : 'primary', size: 'small' },
        ),
      );
    }
    if (omittedItems > 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `_…另有 ${omittedItems} 项权限未展示（卡片预算）_` },
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
      text: { tag: 'lark_md', content: `📝 ${capApprovalText(approval.intro)}` },
    });
  }

  if (expired) {
    // 提问不是权限审批：过期后 agent 侧要么已按跳过继续、要么转由 Web UI
    // 回答，统一文案不能写成「审批已过期」。是否还能在别处回答由数据驱动
    // （DSH 可继续在 Web UI 答，Claude/Codex 不能），渲染层不写死语义。
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⏰ **提问已超时**' },
    });
    if (approval.expiredHint) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: capApprovalText(approval.expiredHint) },
      });
    }
    return elements;
  }

  const questions = approval.questions ?? [];
  let renderedQuestions = 0;
  for (let i = 0; i < questions.length; i++) {
    // 题数粗上限 + 审批区元素预算（自适应）：任一触发即折叠剩余题。
    if (
      i >= MAX_RENDERED_QUESTIONS ||
      countCardElements({ elements }) > APPROVAL_AREA_ELEMENT_BUDGET
    ) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `_…另有 ${questions.length - renderedQuestions} 题未展示（卡片元素预算）；可在终端 / Web UI 回答，或点下方「跳过回答」跳过整批_`,
        },
      });
      break;
    }
    renderedQuestions++;
    const q = questions[i];
    const selected = q.selected ?? [];
    const header = capApprovalText(q.header || `问题 ${i + 1}`, APPROVAL_LABEL_BYTES);
    const freeText = (q.options?.length ?? 0) === 0;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${header}**${q.multiSelect ? '（可多选）' : ''}\n${capApprovalText(q.question)}`,
      },
    });

    if (q.detail) {
      // 题面外的补充正文（DSH plan-review 提问把计划全文放这里）：必须随题
      // 渲染，否则用户是在「看不见计划」的情况下批准。与 ExitPlanMode 的
      // 计划面板同口径：反引号中和 + 表格限数 + 字节预算折叠展示。
      const neutralized = q.detail.replace(/`/g, '·');
      const content = truncateUtf8(truncateMarkdownTables(neutralized), PLAN_PANEL_BYTES);
      elements.push(
        collapsibleMarkdownPanel({
          title: '📋 详情',
          expanded: false,
          border: 'blue',
          content,
        }),
      );
    }

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
          text: { tag: 'lark_md', content: `✍️ 已答：${capApprovalText(answered)}` },
        });
      }
      continue;
    }

    // 选项渲染上限（label 是回调 payload 不可截断，只能按条数折叠）。
    const options = q.options ?? [];
    for (const option of options.slice(0, MAX_RENDERED_OPTIONS)) {
      const isSelected = selected.includes(option.label);
      // 单选/多选图标区分：单选 ⚪/🔵（radio 隐喻），多选 ⬜/☑️（checkbox 隐喻）。
      const icon = q.multiSelect ? (isSelected ? '☑️' : '⬜') : isSelected ? '🔵' : '⚪';
      elements.push(renderOptionRow(approval.requestId, i, option, isSelected, icon, runId));
    }
    if (options.length > MAX_RENDERED_OPTIONS) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `_…另有 ${options.length - MAX_RENDERED_OPTIONS} 个选项未展示（卡片元素预算）_`,
        },
      });
    }

    // 自定义答案（Other）的选中态展示：选项按钮无法表示自由文本，单独显示
    // 已选文本，避免「点了没反应」的困惑。
    const customSelected = q.selected?.find((s) => !q.options.some((o) => o.label === s));
    if (customSelected) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `✍️ 自定义答案：${capApprovalText(customSelected)}` },
      });
    }

    // 单选问题提供自定义答案（Other）输入——输入文本后提交
    // （移动端键盘回车/完成键，桌面端输入框右侧提交图标），input_value 经
    // connector raw 事件回传。
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
          text: { tag: 'lark_md', content: `📝 ${capApprovalText(q.note)}` },
        });
      }
    }

    // 多选问题：有勾选才给提交按钮（单选在协调器内即时提交）。
    if (q.multiSelect && selected.length > 0) {
      elements.push(
        cardButton(
          `✅ 提交答案（已选 ${selected.length} 项）`,
          {
            cmd: 'approval.answerSubmit',
            requestId: approval.requestId,
            questionIndex: i,
            runId,
            nonce: mkNonce(),
          },
          { type: 'primary' },
        ),
      );
    }
  }

  // 提问卡底部统一「跳过回答」：走现有 approval.respond + decision=decline
  // （coordinator 对 question 允许 decline 作为安全兜底），runner 按协议映射
  // 跳过语义（Claude deny / Codex 空 answers / Kimi action decline / Pi cancelled）。
  if (!expired) {
    elements.push(
      cardButton(
        '⏭️ 跳过回答',
        {
          cmd: 'approval.respond',
          decision: 'decline',
          requestId: approval.requestId,
          runId,
          nonce: mkNonce(),
        },
        { type: 'default' },
      ),
    );
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
          // 固定宽度让所有选项行的按钮左对齐（描述长短不影响按钮列）。
          cardButton(
            isSelected ? '取消选择' : '选择',
            {
              cmd: 'approval.answer',
              requestId,
              questionIndex,
              option: option.label,
              runId,
              nonce: mkNonce(),
            },
            { type: isSelected ? 'default' : 'primary', size: 'small', width: '100px' },
          ),
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
                option.description ? `\n_${capApprovalText(option.description)}_` : ''
              }`,
            },
          },
        ],
      },
    ],
  };
}

/**
 * 文本输入行（Other 输入与自由文本题共用）：输入后提交（移动端键盘回车/完成键，
 * 桌面端右侧提交图标），input_value 经 connector raw 事件回传（CardKit input 的
 * input_value 会被 SDK normalizer 丢弃，必须走 includeRawEvent 路径）。
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
