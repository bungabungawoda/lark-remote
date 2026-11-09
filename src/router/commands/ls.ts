import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext, CommandResult } from '../../bridge/index.js';
import { cardButton } from '../../card/card-shared.js';
import { paginationBar, searchBar } from '../../card/card-helpers.js';
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

// ── 模块级命名原语 ─────────────────────────────────────────────────────────
// crapper 把函数内部定义的箭头函数/闭包的决策点也算进外层函数：比较器、过滤
// 谓词、按钮构造器、column 包装一律抽成模块顶层命名函数，显式传参。

interface LsItem {
  name: string;
  isDir: boolean;
  size?: number;
}

/** `...(filter ? { q: filter } : {})` 单源：q 恒为最后一个字段。
 *  ls / ws 两个命令共用（ws.ts 从本模块 import），避免同形实现两处维护。 */
export function withQuery(
  value: Record<string, unknown>,
  filter: string | undefined,
): Record<string, unknown> {
  return filter ? { ...value, q: filter } : { ...value };
}

function lsCompareNames(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * readdirSync 分类，返回已排序的 dirs / 文件名。
 *
 * 分类只信 Dirent（isDirectory/isFile），仅对两者都为 false 的条目（符号链接、
 * d_type 未知的文件系统）statPath 兜底——主流文件系统零 stat。文件大小不在这里
 * 取：分页只展示 30 条，size 由 lsCard 在分页后只对当前页文件补 stat，万级
 * 目录不再每次交互付出全量 statSync。
 */
function lsScanEntries(targetDir: string): { dirs: string[]; files: string[] } {
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      // Dirent 类型未知（符号链接 / DT_UNKNOWN）：stat 定 real kind，与旧口径一致。
      const resolution = statPath(path.join(targetDir, entry.name));
      if (resolution.ok) {
        isDir = resolution.stat.isDirectory();
        isFile = !isDir;
      }
      // stat 失败（竞态删除等）：按旧行为归入 files（渲染时 size 缺省）。
    }
    if (isDir) dirs.push(entry.name);
    else files.push(entry.name);
  }
  dirs.sort(lsCompareNames);
  files.sort(lsCompareNames);
  return { dirs, files };
}

function lsBuildItems(dirs: string[], fileNames: string[]): LsItem[] {
  const allItems: LsItem[] = [];
  for (const name of dirs) allItems.push({ name, isDir: true });
  for (const name of fileNames) allItems.push({ name, isDir: false });
  return allItems;
}

/** 只对当前页的文件补 stat 拿 size（按钮标签展示用）；失败保持 undefined。 */
function lsFillPageFileSizes(pageFiles: LsItem[], targetDir: string): void {
  for (const item of pageFiles) {
    const resolution = statPath(path.join(targetDir, item.name));
    if (resolution.ok && !resolution.stat.isDirectory()) {
      item.size = resolution.stat.size;
    }
  }
}

function lsFilterItems(allItems: LsItem[], ql: string | undefined): LsItem[] {
  if (!ql) return allItems;
  const visible: LsItem[] = [];
  for (const item of allItems) {
    if (item.name.toLowerCase().includes(ql)) visible.push(item);
  }
  return visible;
}

function lsCountDirs(items: LsItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.isDir) count += 1;
  }
  return count;
}

function lsPartitionPage(pageItems: LsItem[]): { pageDirs: LsItem[]; pageFiles: LsItem[] } {
  const pageDirs: LsItem[] = [];
  const pageFiles: LsItem[] = [];
  for (const item of pageItems) {
    if (item.isDir) pageDirs.push(item);
    else pageFiles.push(item);
  }
  return { pageDirs, pageFiles };
}

function lsColumns(elements: object[]): object[] {
  const columns: object[] = [];
  for (const element of elements) {
    columns.push({ tag: 'column', width: 'auto', elements: [element] });
  }
  return columns;
}

function lsDirButton(name: string, targetDir: string, browseRoot: string): object {
  return cardButton(
    `📁 ${name}`,
    { cmd: 'ls.browse', path: path.join(targetDir, name), root: browseRoot },
    { type: 'default' },
  );
}

function lsFileButton(name: string, size: number | undefined, targetDir: string): object {
  return cardButton(
    `📄 ${name}${size !== undefined ? ` (${formatBytes(size)})` : ''}`,
    { cmd: 'ls.file', path: path.join(targetDir, name) },
    { type: 'default', size: 'small' },
  );
}

function lsHeaderButtons(
  targetDir: string,
  cwd: string,
  browseRoot: string,
  safeOffset: number,
  filter: string | undefined,
): object[] {
  const headerElements: object[] = [];
  const parentDir = path.dirname(targetDir);
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
      withQuery(
        { cmd: 'ls.refresh', path: targetDir, offset: safeOffset, root: browseRoot },
        filter,
      ),
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
  return headerElements;
}

function lsDirSection(
  pageDirs: LsItem[],
  visibleDirCount: number,
  currentPage: number,
  targetDir: string,
  browseRoot: string,
): object[] {
  const section: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**📂 目录 (${visibleDirCount})**` } },
  ];
  if (pageDirs.length > 0) {
    for (const dir of pageDirs) {
      section.push({
        tag: 'column_set',
        flex_mode: 'none',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [lsDirButton(dir.name, targetDir, browseRoot)],
          },
        ],
      });
    }
  } else if (visibleDirCount === 0) {
    section.push({ tag: 'div', text: { tag: 'lark_md', content: '无子目录' } });
  } else {
    section.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `（第 ${currentPage} 页无目录）` },
    });
  }
  return section;
}

function lsFileSection(
  pageFiles: LsItem[],
  visibleFileCount: number,
  currentPage: number,
  targetDir: string,
): object[] {
  const section: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**📄 文件 (${visibleFileCount})**` } },
  ];
  if (pageFiles.length > 0) {
    for (const file of pageFiles) {
      section.push({
        tag: 'column_set',
        flex_mode: 'none',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [lsFileButton(file.name, file.size, targetDir)],
          },
        ],
      });
    }
  } else if (visibleFileCount === 0) {
    section.push({ tag: 'div', text: { tag: 'lark_md', content: '无文件' } });
  } else {
    section.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `（第 ${currentPage} 页无文件）` },
    });
  }
  return section;
}

function lsPagination(
  totalCount: number,
  totalPages: number,
  safeOffset: number,
  currentPage: number,
  targetDir: string,
  browseRoot: string,
  filter: string | undefined,
): object[] {
  return [
    { tag: 'hr' },
    ...paginationBar({
      cmd: 'ls.page',
      offset: safeOffset,
      pageSize: LS_PAGE_SIZE,
      total: totalCount,
      extra: withQuery({ path: targetDir, root: browseRoot }, filter),
      label: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 项）`,
    }),
  ];
}

/** 目录卡片构造（原 buildLsCommand 的 try 块）。 */
function lsCard(opts: {
  targetDir: string;
  cwd: string;
  browseRoot: string;
  offset: number;
  filter: string | undefined;
}): CommandResult {
  const { targetDir, cwd, browseRoot, offset, filter } = opts;
  const { dirs, files } = lsScanEntries(targetDir);
  const allItems = lsBuildItems(dirs, files);
  const ql = filter?.toLowerCase();
  const visibleItems = lsFilterItems(allItems, ql);
  const visibleDirCount = lsCountDirs(visibleItems);
  const visibleFileCount = visibleItems.length - visibleDirCount;
  const { totalCount, totalPages, safeOffset, currentPage, pageItems, hasPagination } = pageSlice(
    visibleItems,
    offset,
    LS_PAGE_SIZE,
  );
  const { pageDirs, pageFiles } = lsPartitionPage(pageItems);
  lsFillPageFileSizes(pageFiles, targetDir);

  const headerElements = lsHeaderButtons(targetDir, cwd, browseRoot, safeOffset, filter);
  const elements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `\`${targetDir}\`\n共 ${visibleDirCount} 目录, ${visibleFileCount} 文件`,
      },
    },
    { tag: 'column_set', columns: lsColumns(headerElements) },
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

  if (filter && visibleItems.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `🔍 无匹配条目（关键词："${filter}"）` },
    });
  } else {
    elements.push(...lsDirSection(pageDirs, visibleDirCount, currentPage, targetDir, browseRoot));
    elements.push({ tag: 'hr' });
    elements.push(...lsFileSection(pageFiles, visibleFileCount, currentPage, targetDir));
  }

  if (hasPagination) {
    elements.push(
      ...lsPagination(
        totalCount,
        totalPages,
        safeOffset,
        currentPage,
        targetDir,
        browseRoot,
        filter,
      ),
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
}

/** 解析 /ls 的第一个参数（~ 展开、存在性、文件卡）。 */
function lsResolveTarget(
  args: string[],
  cwd: string,
): { targetDir: string } | { result: CommandResult } {
  // 路径可含空格：参数按空白切分后拼回整段（同 /cd、/download）。
  const raw = args.join(' ').trim();
  if (!raw) return { targetDir: cwd };
  const arg = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const potentialDir = path.resolve(cwd, arg);
  const kind = inspectPath(potentialDir);
  if (kind === 'missing' || kind === 'unreadable') {
    return { result: { text: `ls: ${raw}: No such file or directory` } };
  }
  if (kind === 'file') return { result: buildFileCard(potentialDir) };
  return { targetDir: potentialDir };
}

export function buildLsCommand(
  args: string[],
  _ctx: CommandContext,
  options: LsCommandOptions,
): CommandResult {
  const { cwd, offset = 0, rootDir } = options;
  if (!cwd) return { text: '请先使用 /cd <path> 设置工作目录' };

  const filter = options.q?.trim() || undefined;
  const resolved = lsResolveTarget(args, cwd);
  if ('result' in resolved) return resolved.result;
  const targetDir = resolved.targetDir;
  const browseRoot = rootDir ? path.resolve(cwd, rootDir) : targetDir;

  try {
    return lsCard({ targetDir, cwd, browseRoot, offset, filter });
  } catch (err) {
    return { text: `读取目录失败: ${(err as Error).message}` };
  }
}
