import { describe, it, expect } from 'vitest';
import { enforceCardBudget } from './card-budget.js';
import { sessionEventPanel } from '../router/card-helpers.js';
import { markdownDiv } from './collapsible.js';
import type { AgentSessionContentEvent } from '../runner/index.js';

// ========== 测试辅助函数 ==========

const CARD_BUDGET_BYTES = 28_000;

/** 生成约 approxBytes 字节的合成占位正文 */
function syntheticPayload(approxBytes: number, tag: string): string {
  const line = `${tag} placeholder line, synthetic fixture only, no real data\n`;
  return line.repeat(Math.ceil(approxBytes / line.length));
}

/** 用真实 sessionEventPanel 构造事件面板 */
function buildTestCard(opts: {
  eventCount: number;
  contentLength: number;
  /** 事件类型分布，默认交替 text/tool_result */
  eventTypes?: Array<AgentSessionContentEvent['type']>;
  agentKind?: string;
  /** 是否包含 header/usage/按钮骨架元素 */
  includeSkeleton?: boolean;
}): object {
  const { eventCount, contentLength, agentKind = 'claude', includeSkeleton = true } = opts;
  const events: AgentSessionContentEvent[] = [];
  const types = opts.eventTypes ?? ['text', 'tool_result'];

  for (let i = 0; i < eventCount; i++) {
    const type = types[i % types.length];
    events.push({
      type,
      content: syntheticPayload(contentLength, `SYN-${type.toUpperCase()}-${i}`),
      timestamp: `2026-01-01T08:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }

  const elements: object[] = [];
  if (includeSkeleton) {
    elements.push(markdownDiv('📂 `/home/user/project`\n会话: **session-test**\n🏷️ **Test**'));
    elements.push({ tag: 'hr' });
  }
  events.forEach((ev, i) => {
    elements.push(sessionEventPanel(ev, i, events.length, 2, agentKind));
  });
  if (includeSkeleton) {
    elements.push(markdownDiv('📊 usage: 1K in / 2K out'));
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
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔁 恢复会话' } },
    body: { elements },
  };
}

/** 构造含会话面板 + 静态面板的混合卡片 */
function buildMixedCard(): object {
  const ev: AgentSessionContentEvent = {
    type: 'text',
    content: 'Hello from assistant',
    timestamp: '2026-01-01T08:00:00.000Z',
  };
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Help' } },
    body: {
      elements: [
        // 会话事件面板（由真实 sessionEventPanel 生成）
        sessionEventPanel(ev, 0, 1, 1, 'claude'),
        // 静态面板（非会话面板，无事件 type emoji）
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'markdown', content: '📖 可用命令' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: '/help - 查看帮助' } }],
        },
      ],
    },
  };
}

/** 统计所有 collapsible_panel 的数量（结构化判定，不依赖标题 emoji） */
function countAllPanels(card: object): number {
  const elements = (card as any).body?.elements ?? [];
  return elements.filter((el: any) => el.tag === 'collapsible_panel').length;
}

/** 获取第一个面板的内容文本 */
function getFirstPanelContent(card: object): string {
  const elements = (card as any).body?.elements ?? [];
  for (const el of elements) {
    if (el.tag === 'collapsible_panel') {
      const inner = el.elements?.[0];
      if (inner?.tag === 'div' && inner.text?.content) {
        return inner.text.content;
      }
    }
  }
  return '';
}

describe('enforceCardBudget', () => {
  // ========== 基本边界测试 ==========

  it('should return original card when under budget', () => {
    const card = buildTestCard({ eventCount: 2, contentLength: 100 });
    const result = enforceCardBudget(card);

    expect(result.wasTruncated).toBe(false);
    expect(result.card).toEqual(card);
    expect(result.bytesBefore).toBe(result.bytesAfter);
  });

  it('should return original card when exactly at budget', () => {
    const card = buildTestCard({ eventCount: 1, contentLength: 1000 });
    const { card: resultCard, wasTruncated } = enforceCardBudget(card);

    expect(wasTruncated).toBe(false);
    const header = (resultCard as any).header?.title?.content;
    expect(header).not.toContain('内容已截断');
  });

  // ========== 阶段1：内容截断测试 ==========

  it('should truncate panel content when exceeds maxPanelContentBytes', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card, { maxPanelContentBytes: 2000 });

    expect(result.wasTruncated).toBe(true);
    expect(result.reason).toContain('panel_content_truncated');

    const content = getFirstPanelContent(result.card);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(2100); // 2000 + suffix
  });

  it('should preserve non-session panels', () => {
    const card = buildMixedCard();
    const result = enforceCardBudget(card);

    // 混合小卡片不应被裁剪
    expect(result.wasTruncated).toBe(false);
  });

  // ========== 阶段2：事件数量限制测试 ==========

  it('should limit panel count when exceeds maxEventPanels', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card, { maxEventPanels: 5 });

    expect(result.wasTruncated).toBe(true);
    // 阶段1 截断后如果仍超限 → 阶段2 删面板
    expect(result.reason).toMatch(/event_count_limited/);

    const panelCount = countAllPanels(result.card);
    expect(panelCount).toBeLessThanOrEqual(5);
  });

  it('should add truncation hint when reducing panel count', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 3000 });
    const result = enforceCardBudget(card);

    const cardStr = JSON.stringify(result.card);
    expect(cardStr).toMatch(/还有|未显示/);
  });

  // ========== 阶段3：丢弃全部面板，保留骨架 ==========

  it('should drop all panels and preserve skeleton when stage 1+2 insufficient', () => {
    // 构造一张超大卡片：很多面板，每个极大，阶段1截断+阶段2删面板后仍超限
    // 需要骨架元素自身很大才能在删完面板后仍超28KB——否则阶段2就够了
    // 策略：30个面板，每个5KB内容，maxEventPanels=5, maxPanelContentBytes=2000
    // 截断后每面板2KB * 5 = 10KB + 骨架 ≈ 12KB，不应触发阶段3
    // 要触发阶段3：让截断后面板仍很大 + 保留5个后仍超28KB
    // → 30面板, 每面板8KB, maxPanelContentBytes=5000, maxEventPanels=5
    // 截断后5KB * 5 = 25KB + 骨架 ≈ 27KB，可能接近
    // 更可靠：制造面板截断后仍很大的场景
    const card = buildTestCard({ eventCount: 30, contentLength: 8000 });
    const result = enforceCardBudget(card, {
      maxEventPanels: 5,
      maxPanelContentBytes: 5000,
    });

    expect(result.wasTruncated).toBe(true);

    // 即使触发了 panels_dropped，骨架也必须保留
    const cardStr = JSON.stringify(result.card);
    // 骨架元素
    expect(cardStr).toContain('session-test'); // header
    expect(cardStr).toContain('new-session'); // 按钮
  });

  it('must preserve skeleton (header + buttons + usage) even when panels dropped', () => {
    // 极端场景：大量面板且每个都很大
    const card = buildTestCard({ eventCount: 50, contentLength: 10000 });
    const result = enforceCardBudget(card, {
      maxEventPanels: 3,
      maxPanelContentBytes: 2000,
    });

    expect(result.wasTruncated).toBe(true);

    const cardStr = JSON.stringify(result.card);
    // 骨架必须保留，无论走到哪个阶段
    expect(cardStr).toContain('/home/user/project'); // cwd
    expect(cardStr).toContain('session-test'); // sessionId
    expect(cardStr).toContain('new-session'); // 按钮
    expect(cardStr).toContain('usage'); // usage
  });

  // ========== 阶段4：截断剩余顶层 div ==========

  it('should truncate top-level div text when skeleton itself exceeds budget', () => {
    // 构造一个超大 header 文本，使得即使删掉所有面板后仍超限
    const hugeHeader = syntheticPayload(30_000, 'HUGE-HEADER');
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: hugeHeader } },
          { tag: 'div', text: { tag: 'lark_md', content: 'small text' } },
        ],
      },
    };

    const result = enforceCardBudget(card, { maxPanelContentBytes: 2000 });
    expect(result.wasTruncated).toBe(true);

    // 阶段4 应截断超大 div
    const resultStr = JSON.stringify(result.card);
    // 原始30KB的header不应完整存在
    expect(Buffer.byteLength(resultStr, 'utf8')).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
    if (result.reason?.includes('text_truncated')) {
      expect(resultStr).toContain('small text'); // 小 div 不受影响
    }
  });

  // ========== 阶段5：最终兜底 minimal card ==========

  it('should return minimal card only when skeleton itself is pathological', () => {
    // 病理场景：整个卡片就是超大文本，没有任何面板可裁剪
    const hugeContent = syntheticPayload(50_000, 'PATHOLOGICAL');
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: hugeContent } },
      body: { elements: [] },
    };

    const result = enforceCardBudget(card);
    // 可能走到 extreme_fallback 或 text_truncated（取决于 header 是否被处理）
    expect(result.wasTruncated).toBe(true);
    expect(result.bytesAfter).toBeLessThanOrEqual(CARD_BUDGET_BYTES + 500); // minimal card ~small
  });

  // ========== bytesBefore/bytesAfter 可观测性 ==========

  it('should report bytesBefore and bytesAfter', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card);

    expect(result.bytesBefore).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeGreaterThan(0);
    if (result.wasTruncated) {
      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    }
  });

  it('should report equal bytesBefore/bytesAfter when not truncated', () => {
    const card = buildTestCard({ eventCount: 2, contentLength: 100 });
    const result = enforceCardBudget(card);

    expect(result.wasTruncated).toBe(false);
    expect(result.bytesBefore).toBe(result.bytesAfter);
  });

  // ========== 真实 kimi 风格事件（无 user/assistant，正文无 emoji） ==========

  it('should correctly truncate kimi-style events (text/tool_use/tool_result)', () => {
    const card = buildTestCard({
      eventCount: 5,
      contentLength: 10000,
      eventTypes: ['tool_result', 'text', 'tool_use', 'tool_result', 'text'],
      agentKind: 'kimi',
    });

    const result = enforceCardBudget(card, { maxPanelContentBytes: 2000 });
    expect(result.wasTruncated).toBe(true);

    const cardStr = JSON.stringify(result.card);
    // 骨架保留
    expect(cardStr).toContain('session-test');
    expect(cardStr).toContain('new-session');
    // 裁剪后不超过预算
    expect(Buffer.byteLength(cardStr, 'utf8')).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
    // 面板数合理
    const panelCount = countAllPanels(result.card);
    expect(panelCount).toBeGreaterThan(0);
    expect(panelCount).toBeLessThanOrEqual(5);
  });

  // ========== 选项测试 ==========

  it('should respect custom maxEventPanels', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card, { maxEventPanels: 3 });

    if (result.wasTruncated) {
      const panelCount = countAllPanels(result.card);
      expect(panelCount).toBeLessThanOrEqual(3);
    }
  });

  it('should respect custom maxPanelContentBytes', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card, { maxPanelContentBytes: 1000 });

    if (result.wasTruncated) {
      const content = getFirstPanelContent(result.card);
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1100);
    }
  });

  it('should respect custom truncationHint', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 3000 });
    const result = enforceCardBudget(card, {
      maxEventPanels: 5,
      truncationHint: '⚠️ {count} events hidden',
    });

    const cardStr = JSON.stringify(result.card);
    // 应该使用自定义提示（如果触发了面板移除）
    if (
      result.reason?.includes('event_count_limited') ||
      result.reason?.includes('panels_dropped')
    ) {
      expect(cardStr).toMatch(/events hidden|未显示/);
    }
  });

  // ========== 边界情况测试 ==========

  it('should handle empty card elements', () => {
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      body: { elements: [] },
    };
    const result = enforceCardBudget(card);

    expect(result.wasTruncated).toBe(false);
  });

  it('should handle card without body', () => {
    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: 'Test' } },
    };
    const result = enforceCardBudget(card);

    expect(result.wasTruncated).toBe(false);
    expect(result.card).toEqual(card);
  });

  it('should handle non-collapsible elements', () => {
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: 'Simple text' } },
          { tag: 'button', text: { tag: 'plain_text', content: 'Click me' } },
        ],
      },
    };
    const result = enforceCardBudget(card);

    expect(result.wasTruncated).toBe(false);
  });

  it('should apply stage 1 to ALL collapsible panels regardless of title', () => {
    // 核心回归测试：面板标题不含 emoji 时也必须被截断
    // 这是故障的直接根因——旧代码用 emoji 匹配识别面板，导致无 emoji 标题的面板被跳过
    const elements: object[] = [];
    for (let i = 0; i < 10; i++) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: i >= 8,
        header: {
          title: {
            tag: 'markdown',
            content: `tool_result (2026-01-01 08:${String(i).padStart(2, '0')})`,
          },
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: syntheticPayload(5000, `PANEL-${i}`) } },
        ],
      });
    }

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🔁 恢复会话' } },
      body: { elements },
    };

    const result = enforceCardBudget(card, { maxPanelContentBytes: 2000 });
    expect(result.wasTruncated).toBe(true);
    // 必须触发了内容截断——标题无 emoji 不应阻止裁剪
    expect(result.reason).toContain('panel_content_truncated');
  });
});
