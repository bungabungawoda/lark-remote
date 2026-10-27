import type { CommandContext, CommandResult } from '../../bridge/index.js';
import type { WorkspaceEntry } from '../../workspace/index.js';
import { cardButton } from '../../card/card-shared.js';
import { paginationBar, searchBar } from '../../card/card-helpers.js';
import { pageSlice } from '../paging.js';
import { resolveDirectory } from '../path-validation.js';

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

export function buildWsCommand(
  args: string[],
  ctx: CommandContext,
  offset: number,
  q: string | undefined,
  deps: WsCommandDeps,
): CommandResult {
  const sub = args[0]?.toLowerCase();

  switch (sub) {
    case 'save': {
      const name = args[1];
      if (!name) return { text: '用法: /ws save <name>' };
      const cwd = deps.getCwd(ctx.userId);
      if (!cwd) return { text: '请先 /cd 设置工作目录' };
      deps.saveWorkspace(name, cwd);
      return { text: `已保存 workspace "${name}" -> ${cwd}` };
    }
    case 'use': {
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
    case 'remove': {
      const name = args[1];
      if (!name) return { text: '用法: /ws remove <name>' };
      if (!deps.hasWorkspace(name)) return { text: `workspace "${name}" 不存在` };
      deps.removeWorkspace(name);
      return { text: `已删除 workspace "${name}"` };
    }
    case 'list':
    default: {
      const filter = q?.trim() || undefined;
      const entries = deps.listWorkspaces();
      const currentCwd = deps.getCwd(ctx.userId);
      const sortMode = deps.getSortMode(ctx.userId);

      if (sortMode === 'recent') {
        entries.sort((a, b) => {
          if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
          return a.name.localeCompare(b.name);
        });
      } else {
        entries.sort((a, b) => a.name.localeCompare(b.name));
      }

      const ql = filter?.toLowerCase();
      const visible = ql
        ? entries.filter(
            (entry) =>
              entry.name.toLowerCase().includes(ql) || entry.path.toLowerCase().includes(ql),
          )
        : entries;
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
        const currentLabel = sortMode === 'recent' ? '🕐 最近使用' : '🔤 字母顺序';
        const switchLabel = sortMode === 'recent' ? '🔤 字母顺序' : '🕐 最近使用';
        bodyElements.push(
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
                  cardButton(
                    `切换为 ${switchLabel}`,
                    { cmd: 'ws.sort', ...(filter ? { q: filter } : {}) },
                    { type: 'default', size: 'small' },
                  ),
                ],
              },
            ],
          },
          { tag: 'hr' },
        );

        for (const entry of pageEntries) {
          bodyElements.push(
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
                      {
                        cmd: 'ws.use',
                        name: entry.name,
                        offset: safeOffset,
                        ...(filter ? { q: filter } : {}),
                      },
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
                      {
                        cmd: 'ws.remove',
                        name: entry.name,
                        offset: safeOffset,
                        ...(filter ? { q: filter } : {}),
                      },
                      { type: 'danger', size: 'small' },
                    ),
                  ],
                },
              ],
            },
            { tag: 'hr' },
          );
        }
        bodyElements.pop();

        if (hasPagination) {
          bodyElements.push(
            { tag: 'hr' },
            ...paginationBar({
              cmd: 'ws.page',
              offset: safeOffset,
              pageSize: WS_PAGE_SIZE,
              total: totalCount,
              extra: filter ? { q: filter } : {},
              label: `**${currentPage}/${totalPages}**（${totalCount}）`,
              prevText: '⬅',
              nextText: '➡',
            }),
          );
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
  }
}
