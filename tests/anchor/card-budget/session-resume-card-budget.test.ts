/**
 * ANCHOR (RED) — resume 卡片体积裁剪必须作用于真实 sessionEventPanel 结构，
 * 极端降级不得丢弃卡片骨架。
 *
 * 根因：card-budget 的 isLikelySessionPanel 用 emoji 标题模式（🤖👤💭🔧🟢🔴）
 * 识别会话事件面板，但真实 sessionEventPanel 产出的标题是
 * `tool_result (2026-01-01 08:00:00)` 这类裸英文 type 名——emoji 在事件正文
 * 里而不在标题里。阶段1/2 因此对真实卡片零命中，任何 >28KB 的 resume 卡
 * 都会无裁剪直通极端降级。
 *
 * 本测试用「真实生产者 + 全合成数据」锁定目标契约：
 *   ① 面板由真实 sessionEventPanel 构造（非手写 emoji 标题 fixture）；
 *   ② 事件形状复刻 kimi reader 输出（text/tool_use/tool_result，正文无 emoji）；
 *   ③ 体积分布复刻故障现场（1 条 ~51KB tool_result + 1 条 ~23KB tool_use）；
 *   ④ 断言裁剪后 ≤28KB、骨架（header/按钮）与事件面板保留、超大正文被截断。
 *
 * 数据脱敏声明：以下所有内容均为合成占位符。sessionId 用 AABB 假 UUID，
 * cwd 用 /home/user/project，事件正文为规律重复的占位行，无任何真实路径、
 * 真实会话内容或真实工具输出。
 */
import { describe, expect, it } from 'vitest';
import { enforceCardBudget } from '../../../src/card/card-budget.js';
import { CARD_BUDGET_BYTES } from '../../../src/card/text-truncate.js';
import { markdownDiv } from '../../../src/card/collapsible.js';
import { sessionEventPanel } from '../../../src/router/card-helpers.js';
import type { AgentSessionContentEvent } from '../../../src/runner/index.js';

/** 生成 size 字节级别的合成占位正文（规律假值，无真实信息） */
function syntheticPayload(approxBytes: number, tag: string): string {
  const line = `${tag} placeholder payload line, synthetic fixture only, no real data\n`;
  return line.repeat(Math.ceil(approxBytes / line.length));
}

/**
 * 复刻故障现场的 kimi 风格事件流（kimi reader 只产出 text/tool_use/tool_result
 * 三种类型，正文无 emoji 前缀）：
 *   tool_result ~51KB / text 66B / tool_use ~23KB / tool_result 53B / text 1.7KB
 */
function buildSyntheticKimiEvents(): AgentSessionContentEvent[] {
  const ts = (min: number) => `2026-01-01T08:${String(min).padStart(2, '0')}:00.000Z`;
  return [
    {
      type: 'tool_result',
      content: syntheticPayload(51_000, 'SYNTHETIC-TOOL-RESULT-A'),
      timestamp: ts(0),
    },
    { type: 'text', content: 'synthetic short assistant acknowledgement.', timestamp: ts(1) },
    {
      type: 'tool_use',
      content: `SyntheticTool(${JSON.stringify({ input: syntheticPayload(23_000, 'SYNTHETIC-TOOL-ARGS-B') })})`,
      timestamp: ts(2),
    },
    { type: 'tool_result', content: 'synthetic tiny tool output', timestamp: ts(3) },
    {
      type: 'text',
      content: syntheticPayload(1_700, 'SYNTHETIC-FINAL-TEXT-C'),
      timestamp: ts(4),
    },
  ];
}

/** 复刻 cmdResume/buildAutoResumeCard 的组卡方式（header + 面板 + usage + 按钮） */
function buildResumeStyleCard(): object {
  const header = [
    '📂 `/home/user/project`',
    '会话: **session_aaaaaaaa-1111-2222-3333-444444444444**',
    '🏷️ **最近输入**\nsynthetic placeholder user prompt',
  ].join('\n');

  const events = buildSyntheticKimiEvents();
  const elements: object[] = [markdownDiv(header), { tag: 'hr' }];
  events.forEach((ev, i) => {
    elements.push(sessionEventPanel(ev, i, events.length, 2, 'kimi'));
  });
  elements.push(markdownDiv('📊 synthetic usage: 1.0K in / 2.0K out'));
  elements.push({
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✨ 新会话' },
            type: 'primary',
            behaviors: [{ type: 'callback', value: { cmd: 'new-session' } }],
          },
        ],
      },
    ],
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔁 恢复会话 · Kimi' } },
    body: { elements },
  };
}

describe('resume 卡片体积裁剪（真实 sessionEventPanel 结构）', () => {
  it('>28KB 的 resume 卡必须逐面板截断并保留骨架，禁止整卡极端降级', () => {
    const card = buildResumeStyleCard();

    // 前置条件：合成卡确实超预算（复现故障输入规模）
    const beforeBytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
    expect(beforeBytes).toBeGreaterThan(CARD_BUDGET_BYTES);

    const { card: safe, wasTruncated, reason } = enforceCardBudget(card);
    const serialized = JSON.stringify(safe);

    // ① 裁剪后必须 ≤ 28KB
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
    expect(wasTruncated).toBe(true);

    // ② 禁止整卡极端降级：骨架必须保留
    expect(reason).not.toBe('extreme_fallback');
    expect(serialized).toContain('session_aaaaaaaa-1111-2222-3333-444444444444'); // header sessionId
    expect(serialized).toContain('/home/user/project'); // header cwd
    expect(serialized).toContain('synthetic usage'); // usage 块
    expect(serialized).toContain('new-session'); // 操作按钮

    // ③ 事件面板必须保留（至少最近的若干条），不能全丢
    const panels = JSON.stringify(
      (safe as { body: { elements: { tag?: string }[] } }).body.elements.filter(
        (el) => el.tag === 'collapsible_panel',
      ),
    );
    expect(panels.length).toBeGreaterThan(2); // 至少有真实面板存在（'[]' 之外）

    // ④ 超大正文必须被截断：51KB / 23KB 的合成 payload 不得完整存活
    expect(serialized).not.toContain(syntheticPayload(51_000, 'SYNTHETIC-TOOL-RESULT-A'));
    expect(serialized).not.toContain(syntheticPayload(23_000, 'SYNTHETIC-TOOL-ARGS-B'));
  });
});
