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

export function summarizeToolInput(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return '';
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    // 码点安全截断：裸 slice 切在代理对中间会留下孤立代理项进卡片
    // （同族修复见 tool-render.ts 的 toolHeaderText）。
    return truncate(oneLine, max);
  };
  /** First non-empty of several keys（DSH 同名工具跨版本改过参数名）。 */
  const pickAny = (keys: string[], max = HEADER_SUMMARY_MAX): string => {
    for (const key of keys) {
      const v = pick(key, max);
      if (v) return v;
    }
    return '';
  };
  /** 数组参数的第一个字符串项（DSH web_search 的 queries、present 的 files）。 */
  const pickFirst = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v === 'string') return pick(key, max);
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
  };
  switch (toolKindOf(name)) {
    case 'shell':
      return pick('command');
    case 'file':
      return pick('file_path') || pick('path');
    case 'grep': {
      const pat = pick('pattern', 40);
      const p = pick('path', 30);
      return p ? `${pat} in ${p}` : pat;
    }
    case 'glob':
      return pick('pattern');
    case 'ls':
      return pick('path');
    case 'webfetch':
      return pick('url');
    case 'websearch':
    case 'websearch_queries':
      return pickFirst('queries', 60) || pick('query', 60);
    default:
      break;
  }
  switch (name) {
    case 'Agent':
    case 'Task':
    case 'subagent':
    case 'workflow':
      return pick('description') || pick('subagent_type');
    case 'todo_write':
      return summarizeTodos(rec);
    case 'job_output':
    case 'job_kill':
      return pick('job_id');
    case 'job_list':
      return '（列出任务）';
    case 'present':
      return pickFirst('files');
    case 'skill':
      return pick('name');
    case 'run_code':
      return pick('description') || pick('language');
    case 'terminal_send':
      return pick('text');
    case 'ask_user_question': {
      const questions = rec.questions;
      return Array.isArray(questions) ? `${questions.length} 个问题` : '';
    }
    case 'send_message':
    case 'interrupt_agent':
      return pick('description') || pick('agent_id');
    default:
      return pickAny(['command', 'file_path', 'path', 'query', 'url']);
  }
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
