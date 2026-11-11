import type { CommandContext, CommandResult } from '../../bridge/index.js';
import type { AgentKind } from '../../agent-kinds.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
} from '../../session-contract.js';
import { isAgentKind } from '../../agent-kinds.js';
import type { SessionDisplayUsage } from '../../card/usage-format.js';
import { agentDisplayName, cardButton } from '../../card/card-shared.js';
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
  /** 宿主侧仍有在途 turn（仅 DSH 的 isSessionActive 是服务端事实）。 */
  hostRunning?: boolean;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
  activeRunRunId?: string;
}

interface ResumeCommandDeps {
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
    /** 宿主侧仍有 turn：绑定 sessionId/cwd/agent，走 session/cancel。 */
    hostStop?: { sessionId: string; agentKind: string; cwd: string };
    newSession: boolean;
  }): object[];
  canCompact(agent: string, cwd?: string): boolean;
}

interface ResumeSessionMeta {
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
}

type ResumeMetaMap = Map<string, ResumeSessionMeta>;

interface ParsedResumeArgs {
  agentKind: AgentKind;
  limit: number | undefined;
  sessionIdArg: string | undefined;
}

interface ResumePage {
  pageOffset: number;
  sessions: AgentSession[];
  total: number;
}

interface RowOptions {
  agentKind: AgentKind;
  defaultAgent: AgentKind;
  currentId: string;
  meta: ResumeMetaMap;
  now: number;
}

function sessionPreviewLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function parseResumeArgs(args: string[], defaultAgent: AgentKind): ParsedResumeArgs {
  let agentKind: AgentKind = defaultAgent;
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
  return { agentKind, limit, sessionIdArg };
}

function readerForAgent(deps: ResumeCommandDeps, agentKind: AgentKind): AgentSessionReader {
  return agentKind !== deps.defaultAgent ? deps.readerFor(agentKind) : deps.defaultReader();
}

/** 恢复指定 session 前的校验；返回 CommandResult 表示应当中止。 */
function verifyResumeTarget(
  reader: AgentSessionReader,
  deps: ResumeCommandDeps,
  agentKind: AgentKind,
  sessionIdArg: string,
  cwd: string,
): CommandResult | undefined {
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
  return undefined;
}

function resumeSessionCard(
  ctx: CommandContext,
  deps: ResumeCommandDeps,
  agentKind: AgentKind,
  sessionIdArg: string,
  cwd: string,
): CommandResult {
  deps.setSessionId(ctx.userId, agentKind, sessionIdArg, cwd);
  const display = deps.readDisplay(sessionIdArg, cwd, {
    agentKind,
    maxEvents: AUTO_RESUME_MAX_EVENTS,
  });
  const actions = deps.buildActions({
    isActive: display.isActive,
    activeRunRunId: display.activeRunRunId,
    cwd,
    // 宿主侧仍有 turn 在跑时压缩必然被拒（DSH commands/execute 仅空闲可执行）。
    compact:
      !display.hostRunning && deps.canCompact(agentKind, cwd)
        ? { sessionId: sessionIdArg, agentKind }
        : undefined,
    // 宿主 turn 没有本地 runId，按钮携带 sessionId 走 session/cancel；
    // 本地 activeRun 存在时由 isActive 的 stop 覆盖。
    hostStop:
      !display.isActive && display.hostRunning
        ? { sessionId: sessionIdArg, agentKind, cwd }
        : undefined,
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
        title: `${display.isActive || display.hostRunning ? '⏳ 恢复会话（完成中）' : '🔁 恢复会话'} · ${agentDisplayName(agentKind)}`,
        usageResult: 'success',
        emptyPlaceholder: '_该会话暂无新消息可显示（最后一条为用户输入）_',
        stillRunning: display.hostRunning,
        actions,
      },
    ),
  };
}

function resumeById(
  ctx: CommandContext,
  deps: ResumeCommandDeps,
  agentKind: AgentKind,
  sessionIdArg: string,
  cwd: string,
): CommandResult {
  const reader = readerForAgent(deps, agentKind);
  const rejected = verifyResumeTarget(reader, deps, agentKind, sessionIdArg, cwd);
  if (rejected) return rejected;
  return resumeSessionCard(ctx, deps, agentKind, sessionIdArg, cwd);
}

/** 一次列表读取 + offset 页对齐；异常交给调用方转文案。 */
function loadResumePage(
  reader: AgentSessionReader,
  cwd: string,
  pageSize: number,
  offset: number,
): ResumePage {
  let pageOffset = offset;
  let pageResult = reader.listSessions(cwd, { limit: pageSize, offset: pageOffset });
  const maxOffset = Math.max(0, Math.ceil(pageResult.total / pageSize) - 1) * pageSize;
  if (pageOffset < 0 || pageOffset > maxOffset) {
    pageOffset = clampInt(pageOffset, 0, maxOffset);
    pageResult = reader.listSessions(cwd, { limit: pageSize, offset: pageOffset });
  }
  return { pageOffset, sessions: pageResult.sessions, total: pageResult.total };
}

/** 行级预览字段缺失时才预取，且只预取前 5 条。 */
function prefetchResumeMeta(
  reader: AgentSessionReader,
  allSessions: AgentSession[],
  cwd: string,
): ResumeMetaMap {
  const sessionMeta: ResumeMetaMap = new Map();
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
  return sessionMeta;
}

function formatRelativeTime(mtimeMs: number, now: number): string {
  const diffSec = Math.floor((now - mtimeMs) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} 天前`;
  return new Date(mtimeMs).toLocaleDateString('zh-CN');
}

function resumeTitleParts(
  session: AgentSession,
  meta: ResumeSessionMeta | undefined,
): { titleText: string; titleLabel: string } {
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
  return { titleText, titleLabel };
}

function resumeInfoSections(
  session: AgentSession,
  meta: ResumeSessionMeta | undefined,
  titleText: string,
  titleLabel: string,
): string[] {
  const sections: string[] = [];
  if (titleText) {
    sections.push(
      `🏷️ **${titleLabel}**\n${titleText.slice(0, 80)}${titleText.length > 80 ? '...' : ''}`,
    );
  }
  if (meta?.recap) {
    sections.push(`📝 **Recap**\n${meta.recap.slice(0, 60)}${meta.recap.length > 60 ? '...' : ''}`);
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
  return sections;
}

function resumeRowElements(session: AgentSession, opts: RowOptions): object[] {
  const isCurrent = opts.agentKind === opts.defaultAgent && session.sessionId === opts.currentId;
  const meta = opts.meta.get(session.sessionId);
  const { titleText, titleLabel } = resumeTitleParts(session, meta);
  const sections = resumeInfoSections(session, meta, titleText, titleLabel);
  const infoStr = sections.length > 0 ? '\n' + sections.join('\n──\n') : '';
  return [
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${session.sessionId}**${infoStr}\n⏱ ${formatRelativeTime(session.mtime, opts.now)}${isCurrent ? '  •' : ''}`,
      },
    },
    {
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            cardButton(
              isCurrent ? '✓ 当前会话' : '恢复此会话',
              { cmd: 'resume.use', sessionId: session.sessionId, agent: opts.agentKind },
              { type: isCurrent ? 'default' : 'primary', disabled: isCurrent },
            ),
          ],
        },
      ],
    },
  ];
}

function resumeListElements(
  allSessions: AgentSession[],
  cwd: string,
  total: number,
  pageSize: number,
  pageOffset: number,
  opts: RowOptions,
): object[] {
  const elements: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `📂 当前工作目录：\`${cwd}\`` } },
  ];
  for (const session of allSessions) {
    elements.push(...resumeRowElements(session, opts));
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
        extra: { agent: opts.agentKind, pageSize },
        label: `第 ${currentPage}/${totalPages} 页 · 共 ${total} 个会话`,
      }),
    );
  }
  return elements;
}

function resumeList(
  deps: ResumeCommandDeps,
  entry: ResumeSessionEntry,
  agentKind: AgentKind,
  limit: number | undefined,
  offset: number,
  cwd: string,
): CommandResult {
  const pageSize = clampInt(limit ?? RESUME_PAGE_SIZE, 1, RESUME_PAGE_SIZE);
  const reader = agentKind === deps.defaultAgent ? deps.defaultReader() : deps.readerFor(agentKind);

  let page: ResumePage;
  try {
    page = loadResumePage(reader, cwd, pageSize, offset);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `读取 ${agentDisplayName(agentKind)} session 列表失败: ${msg}` };
  }
  const { sessions: allSessions, total, pageOffset } = page;
  if (allSessions.length === 0) {
    const hint =
      agentKind === deps.defaultAgent
        ? `\n提示：可使用 /resume <agent> 切换查看其他 Agent 的 session`
        : '';
    return {
      text: `当前目录没有 ${agentDisplayName(agentKind)} session 记录\n${cwd}${hint}`,
    };
  }

  const meta = prefetchResumeMeta(reader, allSessions, cwd);
  const elements = resumeListElements(allSessions, cwd, total, pageSize, pageOffset, {
    agentKind,
    defaultAgent: deps.defaultAgent,
    currentId: entry.sessions.get(agentKind) ?? '',
    meta,
    now: Date.now(),
  });

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

export function buildResumeCommand(
  args: string[],
  ctx: CommandContext,
  offset: number,
  deps: ResumeCommandDeps,
): CommandResult {
  const entry = deps.getSessionEntry(ctx.userId);
  const cwd = entry?.cwd;
  const { agentKind, limit, sessionIdArg } = parseResumeArgs(args, deps.defaultAgent);
  if (sessionIdArg) {
    if (!entry || !cwd) return { text: '请先 /cd 设置工作目录' };
    return resumeById(ctx, deps, agentKind, sessionIdArg, cwd);
  }
  if (!cwd) return { text: '请先 /cd 设置工作目录' };
  return resumeList(deps, entry, agentKind, limit, offset, cwd);
}
