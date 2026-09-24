import { describe, it, expect } from 'vitest';
import { enforceCardBudget } from './card-budget.js';
import { CARD_BUDGET_BYTES, FEISHU_MAX_TABLES } from './text-truncate.js';
import { sessionEventPanel } from '../router/card-helpers.js';
import { markdownDiv } from './collapsible.js';
import type { AgentSessionContentEvent } from '../runner/index.js';
import type { CardView } from '../../tests/lib/card-view.js';

// ========== 测试辅助函数 ==========

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
  const elements = (card as CardView).body?.elements ?? [];
  return elements.filter((el) => el.tag === 'collapsible_panel').length;
}

/** 获取第一个面板的内容文本 */
function getFirstPanelContent(card: object): string {
  const elements = (card as CardView).body?.elements ?? [];
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
    const header = (resultCard as CardView).header?.title?.content;
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
    expect(result.reason).toContain('text_truncated');
    expect(resultStr).toContain('small text'); // 小 div 不受影响
  });

  // ========== 阶段5：最终兜底 minimal card ==========

  it('should return minimal card only when skeleton itself is pathological', () => {
    // 病理场景：整个卡片就是超大文本，没有任何面板可裁剪
    const hugeContent = syntheticPayload(50_000, 'PATHOLOGICAL');
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: hugeContent }, template: 'blue' },
      body: { elements: [] },
    };

    const result = enforceCardBudget(card);
    // 走哪一级降级都可接受，唯一不可接受的是把 50KB 原样发出去
    expect(result.wasTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.card), 'utf8')).toBeLessThanOrEqual(
      CARD_BUDGET_BYTES,
    );
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  });

  // ========== bytesBefore/bytesAfter 可观测性 ==========

  it('should report bytesBefore and bytesAfter', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card);

    expect(result.bytesBefore).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeGreaterThan(0);
    expect(result.wasTruncated).toBe(true);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
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

    // 守卫式 `if (result.wasTruncated)` 让这条用例在没触发裁剪时空跑；
    // 50KB 输入必然超限，先把它断死，再验面板上限。
    expect(result.wasTruncated).toBe(true);
    expect(result.bytesBefore).toBeGreaterThan(CARD_BUDGET_BYTES);
    expect(countAllPanels(result.card)).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(JSON.stringify(result.card), 'utf8')).toBeLessThanOrEqual(
      CARD_BUDGET_BYTES,
    );
  });

  it('should respect custom maxPanelContentBytes', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 5000 });
    const result = enforceCardBudget(card, { maxPanelContentBytes: 1000 });

    expect(result.wasTruncated).toBe(true);
    expect(result.reason).toContain('panel_content_truncated');
    const content = getFirstPanelContent(result.card);
    expect(content).not.toBe('');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1100);
  });

  it('should respect custom truncationHint', () => {
    const card = buildTestCard({ eventCount: 10, contentLength: 3000 });
    const result = enforceCardBudget(card, {
      maxEventPanels: 5,
      truncationHint: '⚠️ {count} events hidden',
    });

    expect(result.wasTruncated).toBe(true);
    expect(result.reason).toMatch(/event_count_limited|panels_dropped/);
    expect(JSON.stringify(result.card)).toContain('events hidden');
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

// ========== 阶段0：table 预算是**整卡**口径（11310） ==========

/**
 * 11310 按整张卡片数 table，不是按字段。表分散在多个 lark_md 字段时（每字段
 * 一张、共 6 张），逐字段各限 5 张的裁剪一次都不会命中，守卫却照样上报
 * 「已处理」——卡片原样发出，飞书整卡报废。
 */
describe('enforceCardBudget 阶段0：整卡 table 预算', () => {
  /** 一张表，单元格带唯一标记，便于断言哪张被删。 */
  function tableMd(field: number, table: number): string {
    return `| F${field}T${table} | col |\n|---|-----|\n| ${field}-${table} | val |`;
  }

  /** 构造卡片：`tablesPerField[i]` = 第 i 个 lark_md 字段里的 table 数（文档顺序）。 */
  function cardWithTableFields(tablesPerField: number[]): object {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '📊 表格卡' } },
      body: {
        elements: tablesPerField.map((n, f) =>
          markdownDiv(Array.from({ length: n }, (_, t) => tableMd(f, t)).join('\n\n')),
        ),
      },
    };
  }

  /**
   * 独立 oracle：递归遍历整张卡 JSON 的**所有**字符串值，数 markdown 分隔行。
   *
   * 不复用生产的表格遍历——生产里计数与裁剪同走一条递归，递归若漏掉某类容器，
   * 裁剪与断言会一起瞎（自证循环）。飞书 11310 的口径是「这张卡里有几张表」，
   * 与表格落在哪个字段/容器无关，所以这里按整卡独立数一遍。
   */
  function tablesInCard(card: unknown): number {
    let n = 0;
    const visit = (v: unknown): void => {
      if (typeof v === 'string') {
        for (const line of v.split('\n')) if (/^\|[-: |]+$/.test(line.trim())) n++;
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
        return;
      }
      if (v && typeof v === 'object') for (const inner of Object.values(v)) visit(inner);
    };
    visit(card);
    return n;
  }

  it('test_anchor_card_table_budget_spans_fields', () => {
    // 6 个字段各 1 张表：整卡 6 > 5，字段级 1 ≤ 5
    const card = cardWithTableFields([1, 1, 1, 1, 1, 1]);
    expect(tablesInCard(card)).toBe(6);

    const result = enforceCardBudget(card);

    expect(result.reason).toContain('table_count_limited');
    expect(result.wasTruncated).toBe(true);
    expect(tablesInCard(result.card)).toBeLessThanOrEqual(FEISHU_MAX_TABLES);
  });

  it('跨字段预算删最旧、留最新，并留下省略提示', () => {
    const result = enforceCardBudget(cardWithTableFields([1, 1, 1, 1, 1, 1]));
    const str = JSON.stringify(result.card);

    expect(tablesInCard(result.card)).toBe(FEISHU_MAX_TABLES);
    expect(str).toContain('F5T0'); // 最新一张保住
    expect(str).not.toContain('F0T0'); // 文档顺序最旧的一张被删
    expect(str).toContain('表格已省略');
  });

  it('单个字段装不下时按字段内最旧优先继续删', () => {
    // 3+3+3 = 9 张 → 删最旧 4 张：F0 全部 + F1 的第一张
    const result = enforceCardBudget(cardWithTableFields([3, 3, 3]));
    const str = JSON.stringify(result.card);

    expect(tablesInCard(result.card)).toBe(FEISHU_MAX_TABLES);
    expect(str).not.toContain('F0T0');
    expect(str).not.toContain('F0T2');
    expect(str).not.toContain('F1T0');
    expect(str).toContain('F1T1');
    expect(str).toContain('F2T2');
  });

  it('整卡不超限时不动原文', () => {
    const card = cardWithTableFields([1, 1, 1, 1, 1]);
    const result = enforceCardBudget(card);

    expect(result.wasTruncated).toBe(false);
    expect(result.card).toEqual(card);
  });
});

// ========== 边界值：产物「正好等于」预算/上限时，必须停在当前阶段 ==========
//
// 变异消融在本模块翻了 12 个比较符（`<=`→`<`、`>`→`>=`）全部存活：原有用例的输入
// 都离边界很远，等号写错一档没人察觉。这里逐个把**检查点尺寸**卡在恰好相等上——翻转
// 一档要么多降一级（reason / 面板数变了），要么少降一级。
//
// 注意「检查点尺寸」不等于返回的 bytesAfter：阶段2/3 是先比 size() 再插「N 个事件未
// 显示」提示，产物比检查点多出提示那一截；所以这几例对齐的是**裁剪后的卡片形状**本身。

describe('enforceCardBudget 边界值（恰好等于预算/上限）', () => {
  /** 纯 ASCII 填充：1 字符 = 1 字节，用来精确对齐卡片字节数。 */
  const filler = (n: number): string => 'x'.repeat(n);
  const byteLen = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

  /** 内容恰好为 content 的可折叠面板（阶段1 的裁剪对象）。 */
  function panelWithContent(content: string): object {
    return {
      tag: 'collapsible_panel',
      elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
    };
  }

  function cardWithElements(elements: object[]): object {
    return cardWithHeader('', elements);
  }

  /** 标题填了 pad 字节的卡片：header 不参与任何阶段的裁剪，用来顶住骨架体积。 */
  function cardWithHeader(pad: string, elements: object[]): object {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `🔁 恢复会话${pad}` } },
      body: { elements },
    };
  }

  /**
   * 解出填充长度，使**裁剪后**的卡片形状恰好等于预算。
   *
   * 调用方给出该档位裁剪完剩下的形状（只用本文件的构造器，不重复生产的裁剪逻辑），
   * 字节数对 pad 线性（ASCII 1 字符 = 1 字节），一次反算即对齐；自检确保真的踩在等号上。
   */
  function padLandingOnBudget(landed: (pad: number) => object): number {
    const pad = CARD_BUDGET_BYTES - byteLen(landed(0));
    expect(pad).toBeGreaterThan(0);
    expect(byteLen(landed(pad))).toBe(CARD_BUDGET_BYTES);
    return pad;
  }

  it('字节数正好等于预算 → 原对象直接返回，不进裁剪', () => {
    const base = byteLen(cardWithElements([markdownDiv('')]));
    const card = cardWithElements([markdownDiv(filler(CARD_BUDGET_BYTES - base))]);
    expect(byteLen(card)).toBe(CARD_BUDGET_BYTES);

    const result = enforceCardBudget(card);

    // `<=`→`<` 翻转会进裁剪流水线并返回克隆对象——身份断言即红。
    expect(result.wasTruncated).toBe(false);
    expect(result.bytesBefore).toBe(CARD_BUDGET_BYTES);
    expect(result.card).toBe(card);
  });

  it('删表后正好等于预算 → 停在阶段0，不进字节裁剪', () => {
    const oneTable = (i: number): string => `| h${i} | x |\n|---|---|\n| ${i} | y |`;
    const build = (pad: number): object =>
      cardWithElements([
        markdownDiv(Array.from({ length: 6 }, (_, i) => oneTable(i)).join('\n\n')),
        markdownDiv(filler(pad)),
      ]);
    // 阶段0 不插提示，报出来的 bytesAfter 就是它的检查点尺寸，可以直接反算。
    const probe = enforceCardBudget(build(4000));
    const card = build(4000 + (CARD_BUDGET_BYTES - probe.bytesAfter));

    const result = enforceCardBudget(card);

    expect(result.reason).toBe('table_count_limited');
    expect(result.bytesAfter).toBe(CARD_BUDGET_BYTES);
  });

  it('面板内容正好等于 maxPanelContentBytes → 不算内容截断', () => {
    const cap = 1000;
    const card = cardWithElements(Array.from({ length: 30 }, () => panelWithContent(filler(cap))));
    expect(byteLen(card)).toBeGreaterThan(CARD_BUDGET_BYTES);

    const result = enforceCardBudget(card, { maxPanelContentBytes: cap, maxEventPanels: 30 });

    // `>`→`>=`（阶段1 判据）或 `modifications > 0` 翻转都会多出
    // panel_content_truncated，而这里一个字都没该截。
    expect(result.reason).toBe('panels_dropped');
    expect(countAllPanels(result.card)).toBe(0);
  });

  it('面板数正好等于 maxEventPanels → 一个面板都不删', () => {
    const card = cardWithElements(Array.from({ length: 4 }, () => panelWithContent(filler(9000))));

    const result = enforceCardBudget(card, { maxEventPanels: 4, maxPanelContentBytes: 2000 });

    expect(result.reason).toBe('panel_content_truncated');
    expect(countAllPanels(result.card)).toBe(4);
  });

  it('没有面板被移除时不写「N 个事件未显示」提示', () => {
    const card = cardWithElements([
      panelWithContent(filler(20_000)),
      panelWithContent(filler(20_000)),
    ]);

    const result = enforceCardBudget(card, { maxEventPanels: 5, maxPanelContentBytes: 2000 });

    // `omitted <= 0`→`<` 翻转会在卡头插入「还有 0 个事件未显示」——凭空噪声。
    expect(result.reason).toBe('panel_content_truncated');
    expect(countAllPanels(result.card)).toBe(2);
    expect(JSON.stringify(result.card)).not.toContain('未显示');
  });

  it('阶段2 后正好等于预算 → 停在这里，不再丢面板', () => {
    const cap = 1000;
    const opts = { maxEventPanels: 4, maxPanelContentBytes: cap };
    // 阶段2 的比较发生在插提示之前，所以踩在等号上的是「删完最旧面板剩下的形状」。
    const pad = padLandingOnBudget((p) =>
      cardWithElements([
        ...Array.from({ length: 4 }, () => panelWithContent(filler(cap))),
        markdownDiv(filler(p)),
      ]),
    );
    const card = cardWithElements([
      ...Array.from({ length: 8 }, () => panelWithContent(filler(cap))),
      markdownDiv(filler(pad)),
    ]);
    expect(byteLen(card)).toBeGreaterThan(CARD_BUDGET_BYTES);

    const result = enforceCardBudget(card, opts);

    // `<=`→`<` 翻转会再进阶段3 把剩下 4 个面板也丢光，reason 多出 panels_dropped。
    expect(result.reason).toBe('event_count_limited');
    expect(countAllPanels(result.card)).toBe(4);
  });

  it('阶段3 丢完面板后正好等于预算 → 停在这里，不截骨架文本', () => {
    // 阶段3 的比较同样发生在插提示之前：踩等号的是「只剩骨架」那一版卡片。
    const pad = padLandingOnBudget((p) => cardWithElements([markdownDiv(filler(p))]));
    const card = cardWithElements([
      panelWithContent(filler(9000)),
      panelWithContent(filler(9000)),
      markdownDiv(filler(pad)),
    ]);
    expect(byteLen(card)).toBeGreaterThan(CARD_BUDGET_BYTES);

    const result = enforceCardBudget(card);

    // `<=`→`<` 翻转会进阶段4，把骨架 div 截掉一截（reason 多出 text_truncated）。
    expect(result.reason).toBe('panel_content_truncated+panels_dropped');
    expect(countAllPanels(result.card)).toBe(0);
    expect(result.bytesAfter).toBeGreaterThan(CARD_BUDGET_BYTES);
  });

  it('阶段4 截完骨架文本正好等于预算 → 不进极端兜底', () => {
    // header 不归任何阶段管，用它顶住体积；能被阶段4 裁的只剩顶层 div。
    // 阶段4 的检查点在插提示之后（提示这里不会插：没有面板被移除），所以
    // 「产物恰好等于预算」与「检查点恰好等于预算」是同一件事。
    const pad = padLandingOnBudget((p) => cardWithHeader(filler(p), [markdownDiv(filler(2000))]));
    const card = cardWithHeader(filler(pad), [markdownDiv(filler(20_000))]);

    const result = enforceCardBudget(card);

    // `<=`→`<` 翻转会整卡换成「⚠️ 内容已截断」，骨架和 usage 全丢。
    expect(result.reason).toBe('text_truncated');
    expect(result.bytesAfter).toBe(CARD_BUDGET_BYTES);
    expect(JSON.stringify(result.card)).toContain('恢复会话');
  });
});
