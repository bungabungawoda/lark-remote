import type { CommandContext, CommandResult } from '../../bridge/index.js';
import type { WorkspaceEntry } from '../../workspace/index.js';
import { cardButton } from '../../card/card-shared.js';
import { paginationBar, searchBar } from '../../card/card-helpers.js';
import { pageSlice } from '../paging.js';
import { resolveDirectory } from '../path-validation.js';
import { withQuery } from './ls.js';

export const WS_PAGE_SIZE = 5;

export interface WsCommandDeps {
  getCwd(userId: string): string | undefined;
  saveWorkspace(name: string, cwd: string): void;
  getWorkspace(name: string): string | undefined;
  hasWorkspace(name: string): boolean;
  removeWorkspace(name: string): void;
  touchWorkspace(name: string): void;
  listWorkspaces(): WorkspaceEntry[];
  getSortMode(userId: string): 'recent' | 'alpha';
  switchCwd(userId: string, cwd: string, ctx: CommandContext): CommandResult;
}

// ── 模块级命名原语 ─────────────────────────────────────────────────────────
// crapper 把函数内部定义的箭头函数/闭包的决策点也算进外层函数：比较器、过滤
// 谓词、payload 三元一律抽成模块顶层命名函数，显式传参（见 common/tool-summary.ts）。

// `withQuery`（q 恒为最后一个字段，钉住卡片 payload 顺序）从 ls.ts 复用，
// ls / ws 共用同一实现，避免跨文件同形函数。

/** 筛选命中：名称或路径（大小写不敏感子串）。 */
function wsMatchesQuery(entry: WorkspaceEntry, ql: string): boolean {
  return entry.name.toLowerCase().includes(ql) || entry.path.toLowerCase().includes(ql);
}

function wsFilterEntries(entries: WorkspaceEntry[], ql: string): WorkspaceEntry[] {
  const visible: WorkspaceEntry[] = [];
  for (const entry of entries) {
    if (wsMatchesQuery(entry, ql)) visible.push(entry);
  }
  return visible;
}

function wsCompareRecent(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
  return a.name.localeCompare(b.name);
}

function wsCompareName(a: WorkspaceEntry, b: WorkspaceEntry): number {
  return a.name.localeCompare(b.name);
}

function wsSortLabels(sortMode: 'recent' | 'alpha'): {
  currentLabel: string;
  switchLabel: string;
} {
  return sortMode === 'recent'
    ? { currentLabel: '🕐 最近使用', switchLabel: '🔤 字母顺序' }
    : { currentLabel: '🔤 字母顺序', switchLabel: '🕐 最近使用' };
}

/** 单个 workspace 行的 3 个元素（div + column_set + hr）。 */
function wsEntryElements(
  entry: WorkspaceEntry,
  safeOffset: number,
  filter: string | undefined,
): object[] {
  return [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${entry.name}** → \`${entry.path}\`` },
    },
    {
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            cardButton(
              '切换',
              withQuery({ cmd: 'ws.use', name: entry.name, offset: safeOffset }, filter),
              { type: 'primary', size: 'small' },
            ),
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            cardButton(
              '删除',
              withQuery({ cmd: 'ws.remove', name: entry.name, offset: safeOffset }, filter),
              { type: 'danger', size: 'small' },
            ),
          ],
        },
      ],
    },
    { tag: 'hr' },
  ];
}

/** 排序栏 + 所有行；末尾多余 hr 由调用方 pop（与原实现完全一致）。 */
function wsListRows(
  pageEntries: WorkspaceEntry[],
  sortMode: 'recent' | 'alpha',
  safeOffset: number,
  filter: string | undefined,
): object[] {
  const { currentLabel, switchLabel } = wsSortLabels(sortMode);
  const rows: object[] = [
    { tag: 'hr' },
    {
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: `排序：${currentLabel}` },
            },
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            cardButton(`切换为 ${switchLabel}`, withQuery({ cmd: 'ws.sort' }, filter), {
              type: 'default',
              size: 'small',
            }),
          ],
        },
      ],
    },
    { tag: 'hr' },
  ];
  for (const entry of pageEntries) rows.push(...wsEntryElements(entry, safeOffset, filter));
  return rows;
}

function wsPagination(
  totalCount: number,
  totalPages: number,
  safeOffset: number,
  currentPage: number,
  filter: string | undefined,
): object[] {
  return [
    { tag: 'hr' },
    ...paginationBar({
      cmd: 'ws.page',
      offset: safeOffset,
      pageSize: WS_PAGE_SIZE,
      total: totalCount,
      extra: withQuery({}, filter),
      label: `**${currentPage}/${totalPages}**（${totalCount}）`,
      prevText: '⬅',
      nextText: '➡',
    }),
  ];
}

// ── 子命令 handler（模块顶层命名函数，显式传参）────────────────────────────

type WsSubHandler = (
  args: string[],
  ctx: CommandContext,
  offset: number,
  q: string | undefined,
  deps: WsCommandDeps,
) => CommandResult;

function wsSave(
  args: string[],
  ctx: CommandContext,
  _offset: number,
  _q: string | undefined,
  deps: WsCommandDeps,
): CommandResult {
  const name = args[1];
  if (!name) return { text: '用法: /ws save <name>' };
  const cwd = deps.getCwd(ctx.userId);
  if (!cwd) return { text: '请先 /cd 设置工作目录' };
  deps.saveWorkspace(name, cwd);
  return { text: `已保存 workspace "${name}" -> ${cwd}` };
}

function wsUse(
  args: string[],
  ctx: CommandContext,
  _offset: number,
  _q: string | undefined,
  deps: WsCommandDeps,
): CommandResult {
  const name = args[1];
  if (!name) return { text: '用法: /ws use <name>' };
  const wsPath = deps.getWorkspace(name);
  if (!wsPath) return { text: `workspace "${name}" 不存在` };
  const resolution = resolveDirectory(wsPath);
  if (!resolution.ok) {
    if (resolution.reason === 'missing') return { text: `路径不存在: ${wsPath}` };
    if (resolution.reason === 'not_directory') return { text: `不是目录: ${wsPath}` };
    return { text: `路径无效: ${wsPath}` };
  }
  deps.touchWorkspace(name);
  return deps.switchCwd(ctx.userId, resolution.canonical, ctx);
}

function wsRemove(
  args: string[],
  _ctx: CommandContext,
  _offset: number,
  _q: string | undefined,
  deps: WsCommandDeps,
): CommandResult {
  const name = args[1];
  if (!name) return { text: '用法: /ws remove <name>' };
  if (!deps.hasWorkspace(name)) return { text: `workspace "${name}" 不存在` };
  deps.removeWorkspace(name);
  return { text: `已删除 workspace "${name}"` };
}

function wsList(
  _args: string[],
  ctx: CommandContext,
  offset: number,
  q: string | undefined,
  deps: WsCommandDeps,
): CommandResult {
  const filter = q?.trim() || undefined;
  const entries = deps.listWorkspaces();
  const currentCwd = deps.getCwd(ctx.userId);
  const sortMode = deps.getSortMode(ctx.userId);

  if (sortMode === 'recent') {
    entries.sort(wsCompareRecent);
  } else {
    entries.sort(wsCompareName);
  }

  const ql = filter?.toLowerCase();
  const visible = ql ? wsFilterEntries(entries, ql) : entries;
  const {
    totalCount,
    totalPages,
    safeOffset,
    currentPage,
    pageItems: pageEntries,
    hasPagination,
  } = pageSlice(visible, offset, WS_PAGE_SIZE);

  const bodyElements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `📂 当前工作目录：\`${currentCwd ?? '(未设置)'}\``,
      },
    },
    { tag: 'hr' },
    searchBar({
      cmd: 'ws.filter',
      placeholder: '搜索名称或路径，输完回车',
      currentQuery: filter,
    }),
  ];
  if (filter) {
    bodyElements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `🔍 筛选："${filter}" · 命中 ${totalCount} 个 workspace（点「清除筛选」取消）`,
      },
    });
  }

  if (entries.length === 0 && !filter) {
    bodyElements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '没有保存的 workspace' },
    });
  } else if (filter && visible.length === 0) {
    bodyElements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `🔍 无匹配条目（关键词："${filter}"）` },
    });
  } else {
    bodyElements.push(...wsListRows(pageEntries, sortMode, safeOffset, filter));
    bodyElements.pop();

    if (hasPagination) {
      bodyElements.push(...wsPagination(totalCount, totalPages, safeOffset, currentPage, filter));
    }
  }

  return {
    card: {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: 'Workspaces' } },
      body: { elements: bodyElements },
    },
  };
}

/** 子命令 → handler。用 Map 而非对象字面量：`constructor`/`toString` 这类键会命中 Object.prototype。 */
const WS_SUB_HANDLERS = new Map<string, WsSubHandler>([
  ['save', wsSave],
  ['use', wsUse],
  ['remove', wsRemove],
  ['list', wsList],
]);

export function buildWsCommand(
  args: string[],
  ctx: CommandContext,
  offset: number,
  q: string | undefined,
  deps: WsCommandDeps,
): CommandResult {
  const sub = args[0]?.toLowerCase();
  const handler = sub === undefined ? undefined : WS_SUB_HANDLERS.get(sub);
  return handler ? handler(args, ctx, offset, q, deps) : wsList(args, ctx, offset, q, deps);
}
