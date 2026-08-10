import { AgentRegistry, type AgentKind } from '../runner/index.js';

interface TruncateOptions {
  suffix?: string; // default '…' (1 char)
  normalizeWhitespace?: boolean; // default false
}

/**
 * Display name for an agent kind in the run card header.
 *
 * Reads from the global `AgentRegistry` (set up in `index.ts` at startup)
 * when available. Falls back to a hardcoded map for callers that don't
 * wire up the registry (notably unit tests of pure render helpers).
 */
export function agentDisplayName(kind: string): string {
  const globalReg = AgentRegistry.getGlobalInstance();
  if (globalReg) {
    return globalReg.getDisplayName(kind as AgentKind);
  }
  // Fallback: hardcoded default mapping for unit tests that exercise
  // render helpers without booting the full AgentRegistry.
  if (kind === 'claude') return 'Claude';
  if (kind === 'codex') return 'Codex';
  if (kind === 'opencode') return 'Opencode';
  if (kind === 'pi') return 'Pi';
  if (kind === 'kimi') return 'Kimi';
  return kind;
}

export function truncate(str: string, max: number, options?: TruncateOptions): string {
  const suffix = options?.suffix ?? '…';
  const normalize = options?.normalizeWhitespace ?? false;

  let s = str;
  if (normalize) s = s.replace(/\s+/g, ' ').trim();

  if (s.length <= max) return s;

  const suffixLen = suffix.length;
  const budget = max - suffixLen;
  if (budget <= 0) return suffix;
  let end = 0;
  for (const ch of s) {
    if (end + ch.length > budget) break;
    end += ch.length;
  }
  return s.slice(0, end) + suffix;
}

interface TerminalLabelOptions {
  prefix?: string;
}

const TERMINAL_LABELS: Record<string, string> = {
  done: '已完成',
  error: '出错',
  interrupted: '已终止',
  idle_timeout: '已超时',
  running: '运行中',
  finalizing: '完成中',
};

export function terminalToLabel(terminal: string, options?: TerminalLabelOptions): string {
  const label = TERMINAL_LABELS[terminal] ?? '运行中';
  const prefix = options?.prefix ?? '';
  return prefix + label;
}

export function terminalToColor(terminal: string): string {
  if (terminal === 'done') return 'green';
  if (terminal === 'error') return 'red';
  if (terminal === 'interrupted') return 'grey';
  if (terminal === 'idle_timeout') return 'orange';
  if (terminal === 'finalizing') return 'orange';
  if (terminal === 'running') return 'blue';
  return 'red';
}

/**
 * Create a CardKit 2.0 stop button with behaviors callback.
 */
export function stopButton(runId: string): object {
  return {
    tag: 'button',
    text: { content: '⏹ 停止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { cmd: 'stop', runId } }],
  };
}

/**
 * Create a CardKit 2.0 "new session" button with behaviors callback.
 * Standardized: ✨ 新会话 + primary type
 */
export function newSessionButton(): object {
  return {
    tag: 'button',
    text: { content: '✨ 新会话' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'new-session' } }],
  };
}

/**
 * Create a CardKit 2.0 "resume session" button with behaviors callback.
 * Carries both sessionId and agent so the handler routes to the correct
 * agent's session reader (P2 fix: completion cards from non-default agents
 * must carry agent to avoid wrong-reader fallback).
 */
export function resumeUseButton(sessionId: string, agent: AgentKind): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '🔁 切换到此会话' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'resume.use', sessionId, agent } }],
  };
}
