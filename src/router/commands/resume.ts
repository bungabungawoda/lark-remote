import type { CommandContext, CommandResult } from '../../bridge/index.js';
import type { AgentKind } from '../../agent-kinds.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
} from '../../session-contract.js';
import { isAgentKind } from '../../agent-kinds.js';
import type { SessionDisplayUsage } from '../../card/usage-format.js';
import { agentDisplayName } from '../../card/card-shared.js';
import { buildSessionHistoryCard, paginationBar } from '../../card/card-helpers.js';
import { pageInfo } from '../paging.js';
import { clampInt } from '../../common/clamp.js';

export const AUTO_RESUME_MAX_EVENTS = 5;
export const RESUME_PAGE_SIZE = 5;
const RESUME_CONTENT_PREFETCH = 5;
const RESUME_SUMMARY_PLACEHOLDERS = new Set(['', '(no user message)', '(无摘要)', 'New Session']);
const RESUME_PREVIEW_MAX = 60;

interface ResumeSessionEntry {
  cwd?: string;
  /** SessionStore 的 entry 恒有 sessions（`get()` 只会返回整条或缺席）。 */
  sessions: Map<string, string>;
}

interface SessionDisplay {
  events: AgentSessionContentEvent[];
  usage?: SessionDisplayUsage;
  isActive: boolean;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
  activeRunRunId?: string;
}

export interface ResumeCommandDeps {
  defaultAgent: AgentKind;
  getSessionEntry(userId: string): ResumeSessionEntry | undefined;
  setSessionId(userId: string, agent: AgentKind, sessionId: string, cwd: string): void;
  defaultReader(): AgentSessionReader;
  readerFor(agent: AgentKind): AgentSessionReader;
  dshPresetMismatch(
    reader: AgentSessionReader,
    sessionId: string,
    cwd: string,
  ): { sessionPreset: string; currentPreset: string } | undefined;
  readDisplay(
    sessionId: string,
    cwd: string,
    opts: { agentKind?: string; maxEvents?: number },
  ): SessionDisplay;
  buildActions(opts: {
    isActive: boolean;
    activeRunRunId?: string;
    cwd: string;
    compact?: { sessionId: string; agentKind: string };
    newSession: boolean;
  }): object[];
  canCompact(agent: string, cwd?: string): boolean;
}

function sessionPreviewLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

export function buildResumeCommand(
  args: string[],
  ctx: CommandContext,
  offset: number,
  deps: ResumeCommandDeps,
): CommandResult {
  const entry = deps.getSessionEntry(ctx.userId);
  const cwd = entry?.cwd;

  let agentKind: AgentKind = deps.defaultAgent;
  let limit: number | undefined;
  let sessionIdArg: string | undefined;
  if (args[0]) {
    if (isAgentKind(args[0])) {
      agentKind = args[0];
      if (args[1]) {
        if (/^\d+$/.test(args[1])) limit = parseInt(args[1], 10);
        else sessionIdArg = args[1];
      }
    } else if (/^\d+$/.test(args[0])) {
      limit = parseInt(args[0], 10);
    } else {
      sessionIdArg = args[0];
    }
  }

  if (sessionIdArg) {
    if (!entry || !cwd) return { text: '请先 /cd 设置工作目录' };
    const reader =
      agentKind !== deps.defaultAgent ? deps.readerFor(agentKind) : deps.defaultReader();
    const verifyContent = reader.readSessionContent(sessionIdArg, cwd);
    if (
      verifyContent.events.length === 0 &&
      !verifyContent.usage &&
      !verifyContent.aiTitle &&
      !verifyContent.recap &&
      !verifyContent.displayTitle
    ) {
      return {
        text: `未找到 session ${sessionIdArg}（当前目录: ${cwd}）。请确认该 session 属于此目录，或先 /cd 到正确目录。`,
      };
    }
    if (agentKind === 'dsh' && deps.defaultAgent === 'dsh') {
      const mismatch = deps.dshPresetMismatch(reader, sessionIdArg, cwd);
      if (mismatch) {
        return {
          text:
            `⚠️ 该 DSH session 的 preset 是「${mismatch.sessionPreset}」，与当前配置「${mismatch.currentPreset}」不一致。\n` +
            `preset 在 session 创建时固定，无法中途切换（DSH 返回 agent-preset-conflict）。\n` +
            `继续恢复将在下次 run 失败。请在 /config 中把预设模式改回「${mismatch.sessionPreset}」后重试，或保持当前配置并发新消息新建会话。`,
        };
      }
    }

    deps.setSessionId(ctx.userId, agentKind, sessionIdArg, cwd);
    const display = deps.readDisplay(sessionIdArg, cwd, {
      agentKind,
      maxEvents: AUTO_RESUME_MAX_EVENTS,
    });
    const actions = deps.buildActions({
      isActive: display.isActive,
      activeRunRunId: display.activeRunRunId,
      cwd,
      compact: deps.canCompact(agentKind, cwd) ? { sessionId: sessionIdArg, agentKind } : undefined,
      newSession: true,
    });
    return {
      card: buildSessionHistoryCard(
        {
          sessionId: sessionIdArg,
          cwd,
          displayTitle: display.displayTitle,
          aiTitle: display.aiTitle,
          recap: display.recap,
          events: display.events,
          usage: display.usage,
        },
        {
          agentKind,
          headerText: `📂 \`${cwd}\`\n会话: **${sessionIdArg}**`,
          title: `${display.isActive ? '⏳ 恢复会话（完成中）' : '🔁 恢复会话'} · ${agentDisplayName(agentKind)}`,
          usageResult: 'success',
          emptyPlaceholder: '_该会话暂无新消息可显示（最后一条为用户输入）_',
          actions,
        },
      ),
    };
  }

  if (!cwd) return { text: '请先 /cd 设置工作目录' };
  const pageSize = clampInt(limit ?? RESUME_PAGE_SIZE, 1, RESUME_PAGE_SIZE);
  const reader = agentKind === deps.defaultAgent ? deps.defaultReader() : deps.readerFor(agentKind);

  let pageOffset = offset;
  let pageResult: { sessions: AgentSession[]; total: number };
  try {
    pageResult = reader.listSessions(cwd, { limit: pageSize, offset: pageOffset });
    const maxOffset = Math.max(0, Math.ceil(pageResult.total / pageSize) - 1) * pageSize;
    if (pageOffset < 0 || pageOffset > maxOffset) {
      pageOffset = clampInt(pageOffset, 0, maxOffset);
      pageResult = reader.listSessions(cwd, { limit: pageSize, offset: pageOffset });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `读取 ${agentDisplayName(agentKind)} session 列表失败: ${msg}` };
  }
  const { sessions: allSessions, total } = pageResult;
  if (allSessions.length === 0) {
    const hint =
      agentKind === deps.defaultAgent
        ? `\n提示：可使用 /resume <agent> 切换查看其他 Agent 的 session`
        : '';
    return {
      text: `当前目录没有 ${agentDisplayName(agentKind)} session 记录\n${cwd}${hint}`,
    };
  }

  const sessionMeta = new Map<
    string,
    { aiTitle?: string; recap?: string; displayTitle?: string }
  >();
  for (const session of allSessions.slice(0, RESUME_CONTENT_PREFETCH)) {
    if (session.title || session.lastUserMessage || session.lastAssistantMessage) continue;
    const meta = reader.readSessionSummary
      ? reader.readSessionSummary(session.sessionId, cwd)
      : (() => {
          const content = reader.readSessionContent(session.sessionId, cwd);
          return {
            aiTitle: content.aiTitle,
            recap: content.recap,
            displayTitle: content.displayTitle,
          };
        })();
    sessionMeta.set(session.sessionId, meta);
  }

  const now = Date.now();
  const formatRelativeTime = (mtimeMs: number): string => {
    const diffSec = Math.floor((now - mtimeMs) / 1000);
    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} 天前`;
    return new Date(mtimeMs).toLocaleDateString('zh-CN');
  };

  const elements: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `📂 当前工作目录：\`${cwd}\`` } },
  ];
  const currentId = entry.sessions.get(agentKind) ?? '';
  for (const session of allSessions) {
    const isCurrent = agentKind === deps.defaultAgent && session.sessionId === currentId;
    const meta = sessionMeta.get(session.sessionId);
    const summaryIsPlaceholder = RESUME_SUMMARY_PLACEHOLDERS.has(session.summary.trim());
    const prefetchedTitle = meta?.displayTitle;
    const rowTitleRaw = session.title?.trim() ?? '';
    const rowTitle =
      rowTitleRaw && !RESUME_SUMMARY_PLACEHOLDERS.has(rowTitleRaw) ? rowTitleRaw : undefined;
    const titleText = prefetchedTitle ?? rowTitle ?? (summaryIsPlaceholder ? '' : session.summary);
    const titleLabel = prefetchedTitle
      ? meta?.aiTitle
        ? 'AI 标题'
        : '最近输入'
      : rowTitle
        ? '标题'
        : summaryIsPlaceholder
          ? ''
          : '会话摘要';
    const sections: string[] = [];
    if (titleText) {
      sections.push(
        `🏷️ **${titleLabel}**\n${titleText.slice(0, 80)}${titleText.length > 80 ? '...' : ''}`,
      );
    }
    if (meta?.recap) {
      sections.push(
        `📝 **Recap**\n${meta.recap.slice(0, 60)}${meta.recap.length > 60 ? '...' : ''}`,
      );
    }
    if (session.lastUserMessage) {
      sections.push(
        `✏️ **最近输入**\n${sessionPreviewLine(session.lastUserMessage, RESUME_PREVIEW_MAX)}`,
      );
    }
    if (session.lastAssistantMessage) {
      sections.push(
        `📤 **最后输出**\n${sessionPreviewLine(session.lastAssistantMessage, RESUME_PREVIEW_MAX)}`,
      );
    }
    const infoStr = sections.length > 0 ? '\n' + sections.join('\n──\n') : '';
    elements.push(
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${session.sessionId}**${infoStr}\n⏱ ${formatRelativeTime(session.mtime)}${isCurrent ? '  •' : ''}`,
        },
      },
      {
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: isCurrent ? '✓ 当前会话' : '恢复此会话',
                },
                type: isCurrent ? 'default' : 'primary',
                disabled: isCurrent,
                behaviors: [
                  {
                    type: 'callback',
                    value: {
                      cmd: 'resume.use',
                      sessionId: session.sessionId,
                      agent: agentKind,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  }

  if (total > pageSize) {
    const { totalPages, currentPage } = pageInfo(total, pageOffset, pageSize);
    elements.push(
      { tag: 'hr' },
      ...paginationBar({
        cmd: 'resume.page',
        offset: pageOffset,
        pageSize,
        total,
        extra: { agent: agentKind, pageSize },
        label: `第 ${currentPage}/${totalPages} 页 · 共 ${total} 个会话`,
      }),
    );
  }

  return {
    card: {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `🔁 恢复历史会话 · ${agentDisplayName(agentKind)}`,
        },
      },
      body: { elements },
    },
  };
}
