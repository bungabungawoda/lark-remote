import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext, CommandResult } from '../../bridge/index.js';
import { cardButton } from '../../card/card-shared.js';
import { paginationBar, searchBar } from '../card-helpers.js';
import { inspectPath, statPath } from '../path-validation.js';
import { pageSlice } from '../paging.js';

export const LS_PAGE_SIZE = 30;

export interface LsCommandOptions {
  cwd?: string;
  offset?: number;
  rootDir?: string;
  q?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function buildFileCard(filePath: string): CommandResult {
  const resolution = statPath(filePath);
  const stat = resolution.ok ? resolution.stat : undefined;
  const sizeText = stat ? formatBytes(stat.size) : '未知';
  const mtimeText = stat ? stat.mtime.toLocaleString('zh-CN', { hour12: false }) : '未知';

  const parentDir = path.dirname(filePath);
  const buttons: object[] = [
    cardButton('📎 下载', { cmd: 'ls.file', path: filePath }, { type: 'primary', size: 'small' }),
  ];
  if (parentDir !== filePath) {
    buttons.push(
      cardButton(
        '上级',
        { cmd: 'ls.browse', path: parentDir, root: parentDir },
        { type: 'default', size: 'small' },
      ),
    );
  }

  return {
    card: {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: `📄 ${path.basename(filePath)}` },
        template: 'blue',
      },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: `\`${filePath}\`\n${sizeText}` } },
          { tag: 'div', text: { tag: 'lark_md', content: `修改时间: ${mtimeText}` } },
          {
            tag: 'column_set',
            columns: buttons.map((button) => ({
              tag: 'column',
              width: 'auto',
              elements: [button],
            })),
          },
        ],
      },
    },
  };
}

export function buildLsCommand(
  args: string[],
  _ctx: CommandContext,
  options: LsCommandOptions,
): CommandResult {
  const { cwd, offset = 0, rootDir } = options;
  if (!cwd) return { text: '请先使用 /cd <path> 设置工作目录' };

  const filter = options.q?.trim() || undefined;
  let targetDir = cwd;

  if (args[0]) {
    const arg = args[0].startsWith('~') ? path.join(os.homedir(), args[0].slice(1)) : args[0];
    const potentialDir = path.resolve(cwd, arg);
    const kind = inspectPath(potentialDir);
    if (kind === 'missing' || kind === 'unreadable') {
      return { text: `ls: ${args[0]}: No such file or directory` };
    }
    if (kind === 'file') return buildFileCard(potentialDir);
    targetDir = potentialDir;
  }

  const browseRoot = rootDir ? path.resolve(cwd, rootDir) : targetDir;

  try {
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const dirs: string[] = [];
    const files: Array<{ name: string; size?: number }> = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      let size: number | undefined;
      if (!isDir) {
        const resolution = statPath(path.join(targetDir, entry.name));
        if (resolution.ok) {
          isDir = resolution.stat.isDirectory();
          if (!isDir) size = resolution.stat.size;
        }
      }
      if (isDir) dirs.push(entry.name);
      else files.push({ name: entry.name, size });
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const allItems: Array<{ name: string; isDir: boolean; size?: number }> = [
      ...dirs.map((name) => ({ name, isDir: true })),
      ...files.map((file) => ({ name: file.name, isDir: false, size: file.size })),
    ];
    const ql = filter?.toLowerCase();
    const visibleItems = ql
      ? allItems.filter((item) => item.name.toLowerCase().includes(ql))
      : allItems;
    const visibleDirCount = visibleItems.reduce((count, item) => count + (item.isDir ? 1 : 0), 0);
    const visibleFileCount = visibleItems.length - visibleDirCount;
    const { totalCount, totalPages, safeOffset, currentPage, pageItems, hasPagination } = pageSlice(
      visibleItems,
      offset,
      LS_PAGE_SIZE,
    );

    const parentDir = path.dirname(targetDir);
    const headerElements: object[] = [];
    if (parentDir !== targetDir) {
      headerElements.push(
        cardButton(
          '上级',
          { cmd: 'ls.browse', path: parentDir, root: browseRoot },
          { type: 'default', size: 'small' },
        ),
      );
    }
    if (targetDir !== browseRoot) {
      headerElements.push(
        cardButton(
          '返回',
          { cmd: 'ls.browse', path: browseRoot, root: browseRoot },
          { type: 'default', size: 'small' },
        ),
      );
    }
    headerElements.push(
      cardButton(
        '刷新',
        {
          cmd: 'ls.refresh',
          path: targetDir,
          offset: safeOffset,
          root: browseRoot,
          ...(filter ? { q: filter } : {}),
        },
        { type: 'default', size: 'small' },
      ),
    );
    if (targetDir !== cwd) {
      headerElements.push(
        cardButton(
          '切换',
          { cmd: 'ls.switch', path: targetDir, root: browseRoot },
          { type: 'primary', size: 'small' },
        ),
      );
    }

    const dirButton = (name: string): object =>
      cardButton(
        `📁 ${name}`,
        { cmd: 'ls.browse', path: path.join(targetDir, name), root: browseRoot },
        { type: 'default' },
      );
    const fileButton = (name: string, size?: number): object =>
      cardButton(
        `📄 ${name}${size !== undefined ? ` (${formatBytes(size)})` : ''}`,
        { cmd: 'ls.file', path: path.join(targetDir, name) },
        { type: 'default', size: 'small' },
      );

    const elements: object[] = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `\`${targetDir}\`\n共 ${visibleDirCount} 目录, ${visibleFileCount} 文件`,
        },
      },
      {
        tag: 'column_set',
        columns: headerElements.map((element) => ({
          tag: 'column',
          width: 'auto',
          elements: [element],
        })),
      },
      { tag: 'hr' },
      searchBar({
        cmd: 'ls.filter',
        placeholder: '搜索本层目录/文件名，输完回车',
        currentQuery: filter,
        extra: { path: targetDir, root: browseRoot },
      }),
    ];
    if (filter) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `🔍 筛选："${filter}" · 命中 ${totalCount} 项（点「清除筛选」取消）`,
        },
      });
    }

    const pageDirs = pageItems.filter((item) => item.isDir);
    const pageFiles = pageItems.filter((item) => !item.isDir);
    if (filter && visibleItems.length === 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `🔍 无匹配条目（关键词："${filter}"）` },
      });
    } else {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**📂 目录 (${visibleDirCount})**` },
      });
      if (pageDirs.length > 0) {
        for (const dir of pageDirs) {
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            columns: [{ tag: 'column', width: 'auto', elements: [dirButton(dir.name)] }],
          });
        }
      } else if (visibleDirCount === 0) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: '无子目录' } });
      } else {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `（第 ${currentPage} 页无目录）` },
        });
      }
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**📄 文件 (${visibleFileCount})**` },
      });
      if (pageFiles.length > 0) {
        for (const file of pageFiles) {
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              { tag: 'column', width: 'auto', elements: [fileButton(file.name, file.size)] },
            ],
          });
        }
      } else if (visibleFileCount === 0) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: '无文件' } });
      } else {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `（第 ${currentPage} 页无文件）` },
        });
      }
    }

    if (hasPagination) {
      elements.push({ tag: 'hr' });
      elements.push(
        ...paginationBar({
          cmd: 'ls.page',
          offset: safeOffset,
          pageSize: LS_PAGE_SIZE,
          total: totalCount,
          extra: { path: targetDir, root: browseRoot, ...(filter ? { q: filter } : {}) },
          label: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 项）`,
        }),
      );
    }

    return {
      card: {
        schema: '2.0',
        config: { wide_screen_mode: true, update_multi: true },
        header: {
          title: { tag: 'plain_text', content: `📁 ${path.basename(targetDir)}` },
          template: 'blue',
        },
        body: { elements },
      },
    };
  } catch (err) {
    return { text: `读取目录失败: ${(err as Error).message}` };
  }
}
