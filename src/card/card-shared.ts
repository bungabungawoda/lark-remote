import { AgentRegistry, type AgentKind } from '../runner/index.js';

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

export { truncate } from '../common/truncate.js';

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
 * Create a CardKit 2.0 Compact button for any runCompact-capable runner
 * (codex/kimi/opencode/pi/claude，鸭子类型 `'runCompact' in runner` 探测）。
 * Triggers the compact flow via the codex.compact callback（handler 按
 * runId 解析 agentKind，claude 走 stream-json 内建 /compact）。
 */
export function compactButton(runId: string): object {
  return {
    tag: 'button',
    text: { content: '🗜 Compact' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'codex.compact', runId } }],
  };
}

/**
 * Create a CardKit 2.0 Compact button for resume cards (auto-resume / `/resume <id>`).
 * Unlike compactButton (which targets a finished run's runId), this targets a
 * sessionId directly: the bridge resolves the session and calls the runner's
 * runCompact() without a runId. Carries agent so the handler routes
 * to the correct session reader + runner when the card was rendered for a
 * non-default agent.
 */
export function resumeCompactButton(sessionId: string, agent: string): object {
  return {
    tag: 'button',
    text: { content: '🗜 Compact' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'resume.compact', sessionId, agent } }],
  };
}

export function resumeUseButton(sessionId: string, agent: AgentKind): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '🔁 切换到此会话' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'resume.use', sessionId, agent } }],
  };
}
