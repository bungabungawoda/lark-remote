import type { RunCardRenderOptions } from './run-renderer.js';
import { terminalToColor, terminalToLabel, stopButton } from './card-shared.js';
import { markdownDiv } from './collapsible.js';
import { truncateUtf8 } from './text-truncate.js';

/**
 * 飞书卡片大小限制（安全阈值，与 run-renderer 一致）。
 * 本地定义，不从 card-budget.ts 导入（避免流式/静态耦合）。
 */
const CARD_BUDGET_BYTES = 28_000;

/**
 * 单个输出字段的默认最大字节数（保守值，用于正常路径）。
 * 飞书卡片限制约 28KB，留余量给卡片其他部分（header、status row、footer）
 * output + stderr 各自截断，组合后不超过限制（约 28KB - 2KB = 26KB）
 * 每个字段上限 12KB 可确保组合不超限。
 */
const OUTPUT_MAX_BYTES = 12_000;

/**
 * Degraded 路径：output/stderr 各自更保守的上限。
 * 高转义字符 JSON.stringify 膨胀约 1.8x，4KB 原始 → ~7.2KB JSON，
 * 两字段合计 ~14.4KB，加 header/status/footer 余量充足。
 */
const DEGRADED_OUTPUT_BYTES = 4_000;

/**
 * Truncate long commands for display.
 */
function truncateCommand(cmd: string, maxLen = 40): string {
  if (cmd.length <= maxLen) return cmd;
  return cmd.slice(0, maxLen - 3) + '...';
}

export interface BashRenderOptions extends RunCardRenderOptions {}

/**
 * Minimal card state for bash command output.
 */
export interface BashState {
  runId: string;
  terminal: 'running' | 'done' | 'error' | 'interrupted';
  output: string;
  stderr: string;
  exitCode: number | null;
  command: string;
}

/**
 * Build the status row (status tag + command) element.
 */
function buildStatusRow(state: BashState): object {
  const { terminal, exitCode, command } = state;
  const statusLabel = bashStatusTagLabel(terminal, exitCode);
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [{ tag: 'div', text: { content: statusLabel, tag: 'lark_md' } }],
      },
      {
        tag: 'column',
        width: 'grow',
        elements: [
          { tag: 'div', text: { content: `⏱ ${truncateCommand(command, 40)}`, tag: 'lark_md' } },
        ],
      },
    ],
  };
}

/**
 * Build the exit code footer elements (terminal states only).
 */
function buildExitFooter(state: BashState): object[] {
  if (state.terminal === 'running') return [];
  const statusText =
    state.exitCode !== null
      ? `退出码: ${state.exitCode}`
      : state.terminal === 'interrupted'
        ? '已手动终止'
        : '已完成';
  return [{ tag: 'hr' }, markdownDiv(statusText)];
}

/**
 * Assemble the card JSON from elements.
 */
function assembleCard(state: BashState, elements: object[]): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: bashHeaderTemplate2(state.terminal),
      title: { content: bashHeaderTitle2(state.terminal), tag: 'plain_text' },
    },
    body: { elements },
  };
}

/**
 * Build elements for the normal path: full output/stderr (each ≤ OUTPUT_MAX_BYTES).
 */
function buildNormalElements(state: BashState): object[] {
  const { terminal, runId, output, stderr } = state;
  const elements: object[] = [buildStatusRow(state)];

  const truncatedOutput = output
    ? truncateUtf8(output, OUTPUT_MAX_BYTES, true, '…（输出已截断，共 ' + output.length + ' 字符）')
    : '';
  const truncatedStderr = stderr
    ? truncateUtf8(
        stderr,
        OUTPUT_MAX_BYTES,
        true,
        '…（诊断输出已截断，共 ' + stderr.length + ' 字符）',
      )
    : '';

  if (truncatedOutput) elements.push(markdownDiv(`\`\`\`\n${truncatedOutput}\n\`\`\``));
  if (truncatedStderr)
    elements.push(markdownDiv(`📋 诊断输出:\n\`\`\`\n${truncatedStderr}\n\`\`\``));

  if (terminal === 'running') {
    elements.push({ tag: 'div', text: { content: '‎', tag: 'lark_md' } }, stopButton(runId));
  }

  elements.push(...buildExitFooter(state));
  return elements;
}

/**
 * Build elements for the degraded path: output/stderr truncated to a smaller
 * budget. Preserves command (status row) and exitCode (footer).
 */
function buildDegradedElements(state: BashState): object[] {
  const { terminal, runId, output, stderr } = state;
  const elements: object[] = [buildStatusRow(state)];

  const truncatedOutput = output
    ? truncateUtf8(
        output,
        DEGRADED_OUTPUT_BYTES,
        true,
        '…（输出已截断，共 ' + output.length + ' 字符）',
      )
    : '';
  const truncatedStderr = stderr
    ? truncateUtf8(
        stderr,
        DEGRADED_OUTPUT_BYTES,
        true,
        '…（诊断输出已截断，共 ' + stderr.length + ' 字符）',
      )
    : '';

  if (truncatedOutput) elements.push(markdownDiv(`\`\`\`\n${truncatedOutput}\n\`\`\``));
  if (truncatedStderr)
    elements.push(markdownDiv(`📋 诊断输出:\n\`\`\`\n${truncatedStderr}\n\`\`\``));

  if (terminal === 'running') {
    elements.push({ tag: 'div', text: { content: '‎', tag: 'lark_md' } }, stopButton(runId));
  }

  elements.push(...buildExitFooter(state));
  return elements;
}

/**
 * Build elements for the extreme fallback: no output/stderr body, only
 * status row (command) + exit footer + "output too large" hint.
 * Guarantees a minimal card that still preserves command and exitCode.
 */
function buildExtremeFallbackElements(state: BashState): object[] {
  const { terminal, runId } = state;
  const elements: object[] = [buildStatusRow(state)];

  elements.push(markdownDiv('_⚠️ 输出过大已省略_'));

  if (terminal === 'running') {
    elements.push({ tag: 'div', text: { content: '‎', tag: 'lark_md' } }, stopButton(runId));
  }

  elements.push(...buildExitFooter(state));
  return elements;
}

/**
 * Render a bash command output card (CardKit 2.0).
 *
 * 自带 stringify 级预算保护（与 renderRunCard 对称）：
 * - 正常路径：output/stderr 各 ≤ OUTPUT_MAX_BYTES，组装后检查总卡字节
 * - 超限 → degraded：output/stderr 各截到 DEGRADED_OUTPUT_BYTES 重新组装
 * - 仍超限 → extreme：省略 output/stderr，保留 command + exitCode + 提示
 * 所有返回路径保证 ≤ CARD_BUDGET_BYTES 且保留 command 与 exitCode（终态）。
 */
export function renderBashCard(state: BashState, _options: BashRenderOptions = {}): object {
  // Normal path
  const card = assembleCard(state, buildNormalElements(state));
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') <= CARD_BUDGET_BYTES) return card;

  // Degraded: shrink output/stderr budgets
  const degradedCard = assembleCard(state, buildDegradedElements(state));
  if (Buffer.byteLength(JSON.stringify(degradedCard), 'utf8') <= CARD_BUDGET_BYTES) {
    return degradedCard;
  }

  // Extreme fallback: drop output/stderr, keep command + exitCode + hint
  return assembleCard(state, buildExtremeFallbackElements(state));
}

/** Bash status tag label */
function bashStatusTagLabel(terminal: BashState['terminal'], exitCode: number | null): string {
  if (terminal === 'running' || terminal === 'interrupted') return terminalToLabel(terminal);
  if (exitCode === 0) return '成功';
  if (exitCode !== null) return '失败';
  return '出错';
}

/** CardKit 2.0 header title */
function bashHeaderTitle2(terminal: BashState['terminal']): string {
  if (terminal === 'running') return '💻 执行命令...';
  if (terminal === 'error') return '❌ 命令执行失败';
  if (terminal === 'interrupted') return '⏹ 已终止';
  return '✅ 命令执行完成';
}

/** CardKit 2.0 header template */
function bashHeaderTemplate2(terminal: BashState['terminal']): string {
  return terminalToColor(terminal);
}
