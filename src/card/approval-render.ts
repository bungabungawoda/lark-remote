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
  } else if (approval.kind === 'file') {
    elements.push(...renderFileApproval(approval, opts?.expired, opts?.runId));
  } else if (approval.kind === 'permissions') {
    elements.push(...renderPermissionsApproval(approval, opts?.expired, opts?.runId));
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
    decline: { label: '❌ 拒绝', type: 'danger' },
  };
  // Fixed presentation order; only offer decisions the protocol listed
  // (accept/decline are always available).
  const offered = ['accept', 'acceptForSession', 'acceptWithExecpolicyAmendment', 'decline'].filter(
    (d) => d === 'accept' || d === 'decline' || approval.availableDecisions.includes(d),
  );

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
// Command Approval
// =============================================================================

function renderCommandApproval(
  approval: ApprovalView,
  expired?: boolean,
  runId?: string,
): object[] {
  const elements: object[] = [];

  // Command display
  const cmdContent = approval.command ? `\`${approval.command.slice(0, 500)}\`` : '(no command)';
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

  if (approval.reason) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `💡 ${approval.reason}` },
    });
  }

  // Action buttons — derived from the real protocol decision list (see
  // renderDecisionButtons): accept/decline always, acceptForSession and
  // acceptWithExecpolicyAmendment only when the server offers them.
  elements.push(...renderDecisionButtons(approval, expired, runId));

  // Pending count
  if (approval.pendingTotal > 1) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📋 还有 ${approval.pendingTotal - 1} 个待审批请求` },
    });
  }

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

  if (approval.reason) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `💡 ${approval.reason}` },
    });
  }

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

  if (approval.pendingTotal > 1) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📋 还有 ${approval.pendingTotal - 1} 个待审批请求` },
    });
  }

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

  if (approval.reason) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `💡 ${approval.reason}` },
    });
  }

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

  if (approval.pendingTotal > 1) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `📋 还有 ${approval.pendingTotal - 1} 个待审批请求` },
    });
  }

  return elements;
}
