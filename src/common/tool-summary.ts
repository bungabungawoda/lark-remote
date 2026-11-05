/**
 * 工具调用参数 → 一行人话摘要（`bash — npm test`、`read — src/a.ts`）。
 *
 * 为什么要抽到 common：run 卡的面板标题（`src/card/tool-render.ts`）和
 * resume 卡的「🔧 工具调用」标题（`src/session/<agent>/sessions.ts`）都要同一套口径；
 * 各写一份必然漂移（同一个 `glob` 在一处显示 pattern、另一处显示目录）。
 *
 * 只做"取哪个字段"，不做 agent 分支：工具名与参数名的对应表就是这张 switch。
 */

import { truncate } from './truncate.js';

/** 工具标题/摘要共用的单行宽度上限。 */
export const HEADER_SUMMARY_MAX = 80;

/**
 * 工具别名 → 渲染类别。run 卡面板（`card/tool-render.ts`）与摘要
 * （本文件）共用这一张表，新增别名只改这里，避免两处 switch 漂移。
 */
export type ToolKind =
  'shell' | 'file' | 'grep' | 'glob' | 'ls' | 'webfetch' | 'websearch' | 'websearch_queries';

const TOOL_KIND_BY_NAME: Record<string, ToolKind> = {
  Bash: 'shell',
  bash: 'shell',
  pwsh: 'shell',
  Read: 'file',
  Edit: 'file',
  Write: 'file',
  NotebookEdit: 'file',
  read: 'file',
  edit: 'file',
  write: 'file',
  read_image: 'file',
  Grep: 'grep',
  grep: 'grep',
  Glob: 'glob',
  glob: 'glob',
  find: 'glob',
  ls: 'ls',
  WebFetch: 'webfetch',
  web_fetch: 'webfetch',
  WebSearch: 'websearch',
  web_search: 'websearch_queries',
};

export function toolKindOf(name: string): ToolKind | undefined {
  return TOOL_KIND_BY_NAME[name];
}

export function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === 'object') return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

// --- 字段选取原语 ---
// 模块级纯函数：调用方（`summarizeToolInput`）只负责选路，字段口径各自独立。

function pickField(
  rec: Record<string, unknown>,
  key: string,
  max: number = HEADER_SUMMARY_MAX,
): string {
  const v = rec[key];
  if (typeof v !== 'string') return '';
  const oneLine = v.replace(/\s+/g, ' ').trim();
  // 码点安全截断：裸 slice 切在代理对中间会留下孤立代理项进卡片
  // （同族修复见 tool-render.ts 的 toolHeaderText）。
  return truncate(oneLine, max);
}

/** First non-empty of several keys（DSH 同名工具跨版本改过参数名）。 */
function pickAnyField(
  rec: Record<string, unknown>,
  keys: string[],
  max: number = HEADER_SUMMARY_MAX,
): string {
  for (const key of keys) {
    const v = pickField(rec, key, max);
    if (v) return v;
  }
  return '';
}

/** 数组参数的第一个字符串项（DSH web_search 的 queries、present 的 files）。 */
function pickFirstField(
  rec: Record<string, unknown>,
  key: string,
  max: number = HEADER_SUMMARY_MAX,
): string {
  const v = rec[key];
  if (typeof v === 'string') return pickField(rec, key, max);
  if (!Array.isArray(v)) return '';
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) {
      const oneLine = item.replace(/\s+/g, ' ').trim();
      return truncate(oneLine, max);
    }
    if (item && typeof item === 'object') {
      const path = (item as Record<string, unknown>).path;
      if (typeof path === 'string' && path.trim()) return path;
    }
  }
  return '';
}

// --- 按类别 / 按名字的摘要器 ---

type SummaryPicker = (rec: Record<string, unknown>) => string;

function shellSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'command');
}

function fileSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'file_path') || pickField(rec, 'path');
}

function grepSummary(rec: Record<string, unknown>): string {
  const pat = pickField(rec, 'pattern', 40);
  const p = pickField(rec, 'path', 30);
  return p ? `${pat} in ${p}` : pat;
}

function patternSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'pattern');
}

function pathSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'path');
}

function urlSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'url');
}

function queriesSummary(rec: Record<string, unknown>): string {
  return pickFirstField(rec, 'queries', 60) || pickField(rec, 'query', 60);
}

function subagentSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'description') || pickField(rec, 'subagent_type');
}

function messageSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'description') || pickField(rec, 'agent_id');
}

function jobIdSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'job_id');
}

function jobListSummary(): string {
  return '（列出任务）';
}

function filesSummary(rec: Record<string, unknown>): string {
  return pickFirstField(rec, 'files');
}

function nameSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'name');
}

function runCodeSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'description') || pickField(rec, 'language');
}

function textSummary(rec: Record<string, unknown>): string {
  return pickField(rec, 'text');
}

function questionCountSummary(rec: Record<string, unknown>): string {
  const questions = rec.questions;
  return Array.isArray(questions) ? `${questions.length} 个问题` : '';
}

function todoSummary(rec: Record<string, unknown>): string {
  return summarizeTodos(rec);
}

const FALLBACK_FIELDS = ['command', 'file_path', 'path', 'query', 'url'];

/** 类别 → 摘要器。ToolKind 的每个成员都必须有条目。 */
const KIND_SUMMARY = new Map<ToolKind, SummaryPicker>([
  ['shell', shellSummary],
  ['file', fileSummary],
  ['grep', grepSummary],
  ['glob', patternSummary],
  ['ls', pathSummary],
  ['webfetch', urlSummary],
  ['websearch', queriesSummary],
  ['websearch_queries', queriesSummary],
]);

/**
 * 工具名 → 摘要器。用 Map 而非对象字面量：`constructor` / `toString` 这类
 * 工具名会命中 Object.prototype，查表会拿到非函数值。
 */
const NAME_SUMMARY = new Map<string, SummaryPicker>([
  ['Agent', subagentSummary],
  ['Task', subagentSummary],
  ['subagent', subagentSummary],
  ['workflow', subagentSummary],
  ['todo_write', todoSummary],
  ['job_output', jobIdSummary],
  ['job_kill', jobIdSummary],
  ['job_list', jobListSummary],
  ['present', filesSummary],
  ['skill', nameSummary],
  ['run_code', runCodeSummary],
  ['terminal_send', textSummary],
  ['ask_user_question', questionCountSummary],
  ['send_message', messageSummary],
  ['interrupt_agent', messageSummary],
]);

export function summarizeToolInput(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return '';
  const kind = toolKindOf(name);
  const byKind = kind === undefined ? undefined : KIND_SUMMARY.get(kind);
  if (byKind) return byKind(rec);
  const byName = NAME_SUMMARY.get(name);
  return byName ? byName(rec) : pickAnyField(rec, FALLBACK_FIELDS);
}

/** todo_write 摘要：完成进度 + 当前 in_progress 项主题。 */
function summarizeTodos(rec: Record<string, unknown>): string {
  const todos = rec.todos;
  if (!Array.isArray(todos)) return '';
  let done = 0;
  let active = '';
  for (const item of todos) {
    if (!item || typeof item !== 'object') continue;
    const todo = item as Record<string, unknown>;
    if (todo.status === 'completed') done += 1;
    if (!active && todo.status === 'in_progress' && typeof todo.content === 'string') {
      active = todo.content.replace(/\s+/g, ' ').trim();
    }
  }
  const progress = `${done}/${todos.length}`;
  if (!active) return `已完成 ${progress}`;
  return truncate(`已完成 ${progress} · ${active}`, HEADER_SUMMARY_MAX, { suffix: '…' });
}
