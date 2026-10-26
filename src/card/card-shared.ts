import { AGENT_DISPLAY_NAMES, type AgentKind } from '../runner/types.js';

/**
 * Display name for an agent kind in the run card header.
 *
 * Display names are static UI labels, so the constant is the single source.
 * Keeping a second mutable registry here made render helpers depend on startup
 * order and forced tests to reset global state.
 */
export function agentDisplayName(kind: string): string {
  return AGENT_DISPLAY_NAMES[kind as AgentKind] ?? kind;
}

const TERMINAL_LABELS: Record<string, string> = {
  done: '已完成',
  error: '出错',
  interrupted: '已终止',
  idle_timeout: '已超时',
  running: '运行中',
  finalizing: '完成中',
  // 本轮结束、goal 仍 active：任务没结束，标签不能说"完成"。
  goal_continuing: '目标继续',
};

export function terminalToLabel(terminal: string): string {
  return TERMINAL_LABELS[terminal] ?? '运行中';
}

export function terminalToColor(terminal: string): string {
  if (terminal === 'done') return 'green';
  if (terminal === 'error') return 'red';
  if (terminal === 'interrupted') return 'grey';
  if (terminal === 'idle_timeout') return 'orange';
  if (terminal === 'finalizing') return 'orange';
  if (terminal === 'goal_continuing') return 'orange';
  if (terminal === 'running') return 'blue';
  return 'red';
}

/**
 * CardKit 2.0 静态卡骨架：schema/config/header + 给定 body elements。
 * 队列状态卡、预算兜底卡等"只有 header 文案 + 少量 div"的卡共用。
 */
export function cardWithHeader(opts: {
  template: string;
  title: string;
  elements: object[];
}): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: opts.template,
      title: { tag: 'plain_text', content: opts.title },
    },
    body: { elements: opts.elements },
  };
}

/**
 * Create a CardKit 2.0 button with a callback behavior. Shared constructor
 * for every callback button in the card module (stop/new-session/compact/
 * approval decisions/question options/…) — previously each render site
 * hand-rolled the `{tag, text, type, behaviors}` object and they had drifted
 * (plain_text tag sometimes present, sometimes omitted).
 */
export function cardButton(
  text: string,
  value: Record<string, unknown>,
  opts: {
    type?: 'primary' | 'default' | 'danger';
    size?: 'small' | 'medium' | 'large';
    /** Fixed width, e.g. '100px' (keeps option-row buttons left-aligned). */
    width?: string;
    /** 置灰（当前项 / 不可执行），仍保留回调 payload。 */
    disabled?: boolean;
  } = {},
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    behaviors: [{ type: 'callback', value }],
  };
}

/**
 * Create a CardKit 2.0 stop button with behaviors callback.
 */
export function stopButton(runId: string): object {
  return cardButton('⏹ 停止', { cmd: 'stop', runId }, { type: 'danger' });
}

/**
 * Create a CardKit 2.0 "new session" button with behaviors callback.
 * Standardized: ✨ 新会话 + primary type
 */
export function newSessionButton(): object {
  return cardButton('✨ 新会话', { cmd: 'new-session' }, { type: 'primary' });
}

/**
 * Create a CardKit 2.0 Compact button for any runCompact-capable runner
 * (codex/kimi/opencode/pi/claude，鸭子类型 `'runCompact' in runner` 探测）。
 * Triggers the compact flow via the compact callback（handler 按
 * runId 解析 agentKind，claude 走 stream-json 内建 /compact）。
 */
export function compactButton(runId: string): object {
  return cardButton('🗜 Compact', { cmd: 'compact', runId }, { type: 'primary' });
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
  return cardButton('🗜 Compact', { cmd: 'resume.compact', sessionId, agent }, { type: 'primary' });
}

export function resumeUseButton(sessionId: string, agent: AgentKind): object {
  return cardButton(
    '🔁 切换到此会话',
    { cmd: 'resume.use', sessionId, agent },
    { type: 'primary' },
  );
}
