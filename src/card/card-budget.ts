import {
  truncateUtf8,
  truncateMarkdownTables,
  countMarkdownTables,
  FEISHU_MAX_TABLES,
  CARD_BUDGET_BYTES,
} from './text-truncate.js';

/**
 * 静态卡片体积保护
 *
 * 用于：auto-resume, /active, completion notification 等静态卡片
 * 不适用于：run-renderer 的流式卡片（已有独立保护）
 *
 * Docs: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukz/feishu-cards/card-components/containers/collapsible-panel
 */

interface CardBudgetOptions {
  /** 最大事件面板数量（保留最新的） */
  maxEventPanels?: number;
  /** 单个面板内容最大字节数 */
  maxPanelContentBytes?: number;
  /** 截断提示文本 */
  truncationHint?: string;
}

/**
 * CardKit 2.0 卡片 JSON 的最小结构（仅本模块裁剪关心的字段）。
 *
 * 用结构化类型替代 `any`，让 count/truncate 两套遍历共享同一棵树的形状。
 */
interface CardText {
  tag?: string;
  content?: string;
}

interface CardElementNode {
  tag?: string;
  text?: CardText;
  elements?: CardElementNode[];
  columns?: { elements?: CardElementNode[] }[];
}

interface CardNode {
  body?: { elements?: CardElementNode[] };
}

/**
 * 静态卡片体积保护
 *
 * @param card - 原始卡片 JSON
 * @param opts - 裁剪选项
 * @returns 裁剪后的卡片 + 是否发生了裁剪 + 原因 + 截断前后字节数
 */
export function enforceCardBudget(
  card: object,
  opts: CardBudgetOptions = {},
): {
  card: object;
  wasTruncated: boolean;
  reason?: string;
  bytesBefore: number;
  bytesAfter: number;
} {
  // ========== 阶段0：table 数量保护（独立于字节预算） ==========
  // 飞书 11310 限制：单卡 markdown table >5 就报错。此维度与字节数正交——
  // 小体积可以含很多 table，大体积可以没有 table。必须在字节检查之前独立判断。
  const cardStr = JSON.stringify(card);
  const bytesBefore = Buffer.byteLength(cardStr, 'utf8');
  const totalTables = countCardTables(JSON.parse(cardStr));
  if (totalTables > FEISHU_MAX_TABLES) {
    // 深拷贝后对每个 lark_md 文本做 truncateMarkdownTables
    const fixed = JSON.parse(cardStr) as CardNode;
    truncateCardMarkdownTables(fixed);
    const fixedStr = JSON.stringify(fixed);
    // table 截断后可能仍超字节预算，继续走后续阶段
    if (Buffer.byteLength(fixedStr, 'utf8') <= CARD_BUDGET_BYTES) {
      return {
        card: fixed,
        wasTruncated: true,
        reason: 'table_count_limited',
        bytesBefore,
        bytesAfter: Buffer.byteLength(fixedStr, 'utf8'),
      };
    }
    // table 修好了但字节仍超，用 fixed 作为后续处理的起点
    return enforceByteBudget(fixed, opts, bytesBefore);
  }

  if (bytesBefore <= CARD_BUDGET_BYTES) {
    return { card, wasTruncated: false, bytesBefore, bytesAfter: bytesBefore };
  }

  // 字节超限但 table 不超限
  return enforceByteBudget(JSON.parse(cardStr) as CardNode, opts, bytesBefore);
}

type BudgetResult = {
  card: object;
  wasTruncated: boolean;
  reason?: string;
  bytesBefore: number;
  bytesAfter: number;
};

/**
 * Byte-budget enforcement, extracted so table-limit fix can delegate to it
 * when table truncation alone doesn't bring the card under the byte limit.
 *
 * 裁剪判定是**结构化**的：所有 collapsible_panel 都是待裁剪对象，不看面板
 * 标题文本。历史教训（2026-08-08）：旧实现用
 * emoji 标题模式（🤖👤💭🔧🟢🔴）识别「会话事件面板」，但真实
 * sessionEventPanel 产出的标题是裸英文 type 名（emoji 在事件正文而非标题），
 * 导致裁剪阶段对真实 resume 卡零命中，任何 >28KB 的卡片无裁剪直通极端降级，
 * 整卡被替换成一句话。
 *
 * 渐进式降级（每级仍超限才进入下一级）：
 *   阶段1 逐面板截断内容（maxPanelContentBytes）
 *   阶段2 限制面板数量（删除最老，maxEventPanels）
 *   阶段3 丢弃全部面板，保留骨架（header/usage/按钮）+ 省略提示
 *   阶段4 截断剩余顶层 div 文本
 *   阶段5 最终兜底 minimal card（骨架本身已超限的病理场景）
 */
function enforceByteBudget(
  truncated: CardNode,
  opts: CardBudgetOptions = {},
  bytesBefore?: number,
): BudgetResult {
  const {
    maxEventPanels = 5,
    maxPanelContentBytes = 2000,
    truncationHint = '📜 还有 {count} 个事件未显示',
  } = opts;

  const reasons: string[] = [];

  const elements: CardElementNode[] = truncated.body?.elements ?? [];
  const size = () => Buffer.byteLength(JSON.stringify(truncated), 'utf8');
  const done = (wasTruncated: boolean): BudgetResult => ({
    card: truncated,
    wasTruncated,
    reason: reasons.join('+') || undefined,
    bytesBefore: bytesBefore ?? size(),
    bytesAfter: size(),
  });

  // ========== 阶段1：裁剪所有面板的内容 ==========
  let modifications = 0;
  for (const el of elements) {
    if (el.tag !== 'collapsible_panel') continue;
    for (const inner of el.elements ?? []) {
      if (inner.tag === 'div' && inner.text?.content) {
        const content = inner.text.content;
        if (Buffer.byteLength(content, 'utf8') > maxPanelContentBytes) {
          inner.text.content = truncateUtf8(content, maxPanelContentBytes);
          modifications++;
        }
      }
    }
  }
  if (modifications > 0) {
    reasons.push('panel_content_truncated');
  }

  // ========== 阶段2：限制面板数量（删除最老） ==========
  let omitted = 0;
  const dropOldestPanels = (count: number): void => {
    const indices = getPanelIndices(elements)
      .slice(0, count)
      .sort((a, b) => b - a);
    for (const idx of indices) {
      elements.splice(idx, 1);
      omitted++;
    }
  };

  const panelCount = getPanelIndices(elements).length;
  if (panelCount > maxEventPanels) {
    dropOldestPanels(panelCount - maxEventPanels);
    reasons.push('event_count_limited');
  }

  if (size() <= CARD_BUDGET_BYTES) {
    insertOmittedHint(elements, omitted, truncationHint);
    return done(modifications > 0 || omitted > 0);
  }

  // ========== 阶段3：丢弃全部面板，保留卡片骨架 ==========
  // header（cwd/sessionId/标题）、usage、操作按钮等信息量高、体积小的元素
  // 必须保留——整卡替换为一句话是信息损失最大的降级方式。
  dropOldestPanels(getPanelIndices(elements).length);
  if (omitted > 0) {
    reasons.push('panels_dropped');
  }

  if (size() <= CARD_BUDGET_BYTES) {
    insertOmittedHint(elements, omitted, truncationHint);
    return done(true);
  }

  // ========== 阶段4：截断剩余顶层 div 文本 ==========
  // 骨架元素（header/usage 等）自身超限的情况（如超大 displayTitle）。
  insertOmittedHint(elements, omitted, truncationHint);
  let textTruncations = 0;
  for (const el of elements) {
    if (el.tag === 'div' && el.text?.content) {
      const content = el.text.content;
      if (Buffer.byteLength(content, 'utf8') > maxPanelContentBytes) {
        el.text.content = truncateUtf8(content, maxPanelContentBytes);
        textTruncations++;
      }
    }
  }
  if (textTruncations > 0) {
    reasons.push('text_truncated');
  }

  if (size() <= CARD_BUDGET_BYTES) {
    return done(true);
  }

  // ========== 阶段5：最终兜底（原 extreme_fallback） ==========
  const minimalCard = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '⚠️ 内容已截断' },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '会话内容过大，已自动截断。\n\n请使用 `/active` 查看完整列表。',
          },
        },
      ],
    },
  };

  return {
    card: minimalCard,
    wasTruncated: true,
    reason: 'extreme_fallback',
    bytesBefore: bytesBefore ?? size(),
    bytesAfter: Buffer.byteLength(JSON.stringify(minimalCard), 'utf8'),
  };
}

/**
 * 在卡片头部插入「N 个事件未显示」提示（仅在有面板被移除时）。
 */
function insertOmittedHint(
  elements: CardElementNode[],
  omitted: number,
  truncationHint: string,
): void {
  if (omitted <= 0) return;
  elements.unshift({
    tag: 'div',
    text: { tag: 'lark_md', content: truncationHint.replace('{count}', String(omitted)) },
  });
}

/**
 * 获取所有 collapsible_panel 的索引（结构化判定，不看标题文本）。
 */
function getPanelIndices(elements: CardElementNode[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < elements.length; i++) {
    if (elements[i].tag === 'collapsible_panel') {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * 遍历卡片元素树（含 collapsible_panel.elements 与 column_set.columns[].elements）。
 *
 * count 与 truncate 两条路径共用同一遍历，避免两套递归漂移（G5 Duplication）。
 */
function walkCardElements(elements: CardElementNode[], visit: (el: CardElementNode) => void): void {
  for (const el of elements) {
    visit(el);
    if (Array.isArray(el.elements)) walkCardElements(el.elements, visit);
    if (Array.isArray(el.columns)) {
      for (const col of el.columns) {
        if (Array.isArray(col.elements)) walkCardElements(col.elements, visit);
      }
    }
  }
}

/**
 * Count all markdown tables across every lark_md text field in a card JSON.
 */
function countCardTables(card: CardNode): number {
  let total = 0;
  walkCardElements(card?.body?.elements ?? [], (el) => {
    if (el.text?.tag === 'lark_md' && typeof el.text.content === 'string') {
      total += countMarkdownTables(el.text.content);
    }
  });
  return total;
}

/**
 * In-place truncate markdown tables in every lark_md text field of a card,
 * keeping at most FEISHU_MAX_TABLES per field.
 */
function truncateCardMarkdownTables(card: CardNode): void {
  walkCardElements(card?.body?.elements ?? [], (el) => {
    if (el.text?.tag === 'lark_md' && typeof el.text.content === 'string') {
      const truncated = truncateMarkdownTables(el.text.content);
      if (truncated !== el.text.content) {
        el.text.content = truncated;
      }
    }
  });
}
