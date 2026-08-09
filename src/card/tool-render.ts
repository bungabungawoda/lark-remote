/**
 * Structured tool rendering for collapsible panels.
 *
 * Adapted to lark-remote's `ToolEntry` type (which uses `status: 'running' | 'ok' | 'error'`
 * and stores `input` as an already-stringified value in some paths).
 *
 * Why this exists: the old renderer dumped `JSON.stringify(input, null, 2)`
 * which is verbose and buries the useful signal (command, file path, pattern)
 * under formatting noise. `toolHeaderText` produces a compact one-liner header
 * like `✅ **Bash** — pwd` so collapsed panels stay informative.
 */

import type { ToolEntry } from './run-state.js';

const HEADER_SUMMARY_MAX = 80;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
/**
 * Cumulative cap on a tool's full body markdown (input + output + code fences
 * + headers). Even with per-field caps, pathological tools (many input fields
 * + maxed-out output) can stack to multi-KB bodies which, multiplied across
 * panels, push the card past Feishu's per-element size limit. This is the last
 * belt across the whole rendered body string.
 */
const BODY_TOTAL_MAX = 2500;

/**
 * One-line header for a tool call:
 *   `⏳ **Bash** — pwd`
 *   `✅ **Read** — /repo/a.ts`
 *   `❌ **Grep** — pattern in path`
 */
export function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'ok' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  // P3-6: use the cached parsed record when available (avoids per-render parse).
  const input = tool.parsedInput !== undefined ? tool.parsedInput : tool.input;
  const summary = summarizeInput(tool.name, input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

/**
 * Structured body markdown for a tool call. Renders input fields by tool name
 * (Bash → command, Read/Edit/Write → file_path, etc.) and output in a code
 * block. Falls back to a raw JSON dump for unknown tools.
 */
export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（body 已截断，完整内容查日志）_`;
}

function summarizeInput(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return '';
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };
  switch (name) {
    case 'Bash':
    case 'bash':
      return pick('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'read':
    case 'edit':
    case 'write':
      return pick('file_path') || pick('path');
    case 'Grep':
    case 'grep': {
      const pat = pick('pattern', 40);
      const p = pick('path', 30);
      return p ? `${pat} in ${p}` : pat;
    }
    case 'Glob':
    case 'find':
      return pick('pattern');
    case 'ls':
      return pick('path');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query', 60);
    case 'Agent':
    case 'Task':
      return pick('description') || pick('subagent_type');
    default:
      return pick('command') || pick('file_path') || pick('path') || pick('query');
  }
}

function renderInput(tool: ToolEntry): string {
  // P3-6: use the cached parsed record when available (avoids per-render parse).
  const input = tool.parsedInput !== undefined ? tool.parsedInput : tool.input;
  const rec = asRecord(input);
  if (!rec) return '';
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '');

  switch (tool.name) {
    case 'Bash':
    case 'bash': {
      const cmd = str('command');
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'read':
    case 'edit':
    case 'write': {
      const fp = str('file_path') || str('path');
      return fp ? `**File** \`${fp}\`` : '';
    }
    case 'Grep':
    case 'grep': {
      const lines: string[] = [];
      if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``);
      if (str('path')) lines.push(`**Path** \`${str('path')}\``);
      return lines.join('\n');
    }
    case 'Glob':
    case 'find': {
      const p = str('pattern');
      return p ? `**Pattern** \`${truncate(p, BODY_FIELD_MAX)}\`` : '';
    }
    case 'ls': {
      const p = str('path');
      return p ? `**Path** \`${p}\`` : '';
    }
    case 'WebFetch':
      return str('url') ? `**URL** ${str('url')}` : '';
    case 'WebSearch':
      return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    default:
      return '';
  }
}

function asRecord(input: unknown): Record<string, unknown> | null {
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
