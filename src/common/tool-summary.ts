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

const HEADER_SUMMARY_MAX = 80;

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
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
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
        return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
      }
      if (item && typeof item === 'object') {
        const path = (item as Record<string, unknown>).path;
        if (typeof path === 'string' && path.trim()) return path;
      }
    }
    return '';
  };
  switch (name) {
    case 'Bash':
    case 'bash':
    case 'pwsh':
      return pick('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'read':
    case 'edit':
    case 'write':
    case 'read_image':
      return pick('file_path') || pick('path');
    case 'Grep':
    case 'grep': {
      const pat = pick('pattern', 40);
      const p = pick('path', 30);
      return p ? `${pat} in ${p}` : pat;
    }
    case 'Glob':
    case 'glob':
    case 'find':
      return pick('pattern');
    case 'ls':
      return pick('path');
    case 'WebFetch':
    case 'web_fetch':
      return pick('url');
    case 'WebSearch':
    case 'web_search':
      return pickFirst('queries', 60) || pick('query', 60);
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
