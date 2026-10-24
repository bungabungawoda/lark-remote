import {
  dropOldestMarkdownTables,
  countMarkdownTables,
  FEISHU_MAX_TABLES,
  CARD_BUDGET_BYTES,
} from './text-truncate.js';
import { truncateUtf8 } from '../common/truncate.js';
import { cardWithHeader } from './card-shared.js';

/**
 * 静态卡片体积保护
 *
 * 用于：auto-resume, /active, completion notification 等静态卡片
 * 不适用于：run-renderer 的流式卡片（已有独立保护）
 *
 * Docs: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukz/feishu-cards/card-components/containers/collapsible-panel
 */

/**
 * 飞书单卡「元素」总量上限（实测）。
 *
 * 2026-10-19 用真实 API 在测试会话探测（`tests/feishu-live/feishu-card-element-total-limit.test.ts`
 * 与 `feishu-workspace-card-limit` / `feishu-order-active-card-limit`）：
 *
 * | 形状 | 结果 | elements 计数 |
 * | --- | --- | --- |
 * | 顶层平铺 99 个 div | ✅ | 99 |
 * | 顶层平铺 100 个 div | ❌ 11310 | 100 |
 * | 单列 column_set 内嵌 98 个 div | ✅ | 99 |
 * | 单列 column_set 内嵌 99 个 div | ❌ | 100 |
 * | `/order` 旧结构 20 行 | ❌ | 103 |
 * | `/ws` 旧结构 20 行 | ❌ | 101 |
 * | `/ws` 分页 15 行（整卡 227 个 JSON 对象） | ✅ | 80 |
 *
 * 判据是**递归统计 `elements` 数组成员**（不含 `columns`）**≤ 99**：所有实测的
 * 成功/失败点都被它分开，而"整卡 JSON 对象数"分不开（`/ws` 分页卡 227 个对象
 * 能发出去，平铺 100 个 div 只有 205 个对象却失败）。
 *
 * 另一个独立维度：单个 `column_set` 的列数（实测 66 列通过、67 列失败）。本仓库
 * 所有卡片的列数都在 3 以内，用不到这个上限，仅在此记录以免再次误判。
 *
 * **旧结论勘误**：仓库曾把 `230025` 记为「elements 过多」。本次探测中它一次都
 * 没有出现；元素超限统一是 `230099 / ErrCode: 11310 element exceeds the limit`。
 *
 * `MAX_CARD_ELEMENTS` 取 90（相对实测 99 留 10% 余量），用于渲染前的保守裁剪。
 */
export const MAX_CARD_ELEMENTS = 90;

/**
 * 卡片递归的 `elements` 数组成员数（`columns` 不计数）——与飞书实测边界对齐。
 *
 * 注意与"JSON 对象总数"不同：`column_set` 的 `column` 对象不计入，button 的
 * `behaviors`/`value` 也不计入。用它做预算才既不误伤能发出去的卡片，也不放过
 * 真正超限的卡片。
 */
export function countCardElements(card: unknown): number {
  let total = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const rec = value as { elements?: unknown; columns?: unknown };
    if (Array.isArray(rec.elements)) {
      total += rec.elements.length;
      walk(rec.elements);
    }
    if (Array.isArray(rec.columns)) {
      walk(rec.columns);
    }
    // 继续下潜其余字段（`body`、`header` 等）：卡片根对象本身没有 elements，
    // 不遍历字段就永远数到 0（曾因此让整条元素预算静默失效）。
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'elements' || key === 'columns') continue;
      walk(child);
    }
  };
  walk(card);
  return total;
}

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
  const parsed = JSON.parse(cardStr) as CardNode;
  const elementsBefore = countCardElements(parsed);
  const droppedTables = capCardMarkdownTables(parsed, FEISHU_MAX_TABLES);
  if (droppedTables > 0) {
    const fixedStr = JSON.stringify(parsed);
    // table 截断后可能仍超预算（字节或元素总数），继续走后续阶段
    if (fitsBudget(Buffer.byteLength(fixedStr, 'utf8'), countCardElements(parsed))) {
      return {
        card: parsed,
        wasTruncated: true,
        reason: 'table_count_limited',
        bytesBefore,
        bytesAfter: Buffer.byteLength(fixedStr, 'utf8'),
      };
    }
    return enforceElementBudget(parsed, opts, bytesBefore);
  }

  if (fitsBudget(bytesBefore, elementsBefore)) {
    return { card, wasTruncated: false, bytesBefore, bytesAfter: bytesBefore };
  }

  // 元素总数超限：table 与字节可能都正常，必须先按元素数裁剪。
  if (bytesBefore <= CARD_BUDGET_BYTES && elementsBefore > MAX_CARD_ELEMENTS) {
    return enforceElementBudget(parsed, opts, bytesBefore);
  }

  // 字节超限但 table 不超限
  return enforceByteBudget(JSON.parse(cardStr) as CardNode, opts, bytesBefore);
}

/** 同时满足字节与元素总数两个预算。 */
function fitsBudget(bytes: number, elements: number): boolean {
  return bytes <= CARD_BUDGET_BYTES && elements <= MAX_CARD_ELEMENTS;
}

/**
 * 元素总数超限时的裁剪：先丢最老的面板，再交给字节路径继续降级。
 *
 * 与字节路径分开是因为成因正交：字节超限来自内容长度（截断内容即可），元素
 * 超限来自元素个数（只能删元素）。两条路径共用 `getPanelIndices`。
 */
function enforceElementBudget(
  card: CardNode,
  opts: CardBudgetOptions = {},
  bytesBefore?: number,
): BudgetResult {
  const reasons: string[] = [];
  const elements: CardElementNode[] = card.body?.elements ?? [];
  const size = () => Buffer.byteLength(JSON.stringify(card), 'utf8');
  const done = (wasTruncated: boolean): BudgetResult => ({
    card,
    wasTruncated,
    reason: reasons.join('+') || undefined,
    bytesBefore: bytesBefore ?? size(),
    bytesAfter: size(),
  });

  const dropPanels = (count: number): number => {
    const indices = getPanelIndices(elements)
      .slice(0, count)
      .sort((a, b) => b - a);
    for (const idx of indices) elements.splice(idx, 1);
    return indices.length;
  };

  // 阶段1：面板按数量砍（面板是节点大户：一个面板外壳 + 内容）
  const panelCount = getPanelIndices(elements).length;
  if (panelCount > 0) {
    let dropped = 0;
    while (countCardElements(card) > MAX_CARD_ELEMENTS && getPanelIndices(elements).length > 0) {
      dropped += dropPanels(1);
    }
    if (dropped > 0) reasons.push('element_budget_panels_dropped');
  }
  if (countCardElements(card) <= MAX_CARD_ELEMENTS && size() <= CARD_BUDGET_BYTES) {
    return done(true);
  }

  // 阶段2：仍超限（既不是面板、或字节同时超）→ 交给字节路径继续降级，
  // 它最终会落到最小卡（节点数固定很小）。
  return enforceByteBudget(card, opts, bytesBefore);
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

  // 元素数预算必须与字节预算同查（含 hint 预留位）：字节路径的返回条件此前
  // 只看字节——元素超限但卡内无 collapsible_panel 时（如 95 个小 div），
  // 阶段1-4 全是空操作，超限卡原样直通（实测 wasTruncated:false、95 元素
  // > 90 → 飞书 11310 整卡报废，正是文件头注释记载的 /ws、/order 故障形态）。
  const elementsWithinBudgetWithHint = (): boolean =>
    countCardElements(truncated) + (omitted > 0 ? 1 : 0) <= MAX_CARD_ELEMENTS;

  if (size() <= CARD_BUDGET_BYTES && elementsWithinBudgetWithHint()) {
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

  if (size() <= CARD_BUDGET_BYTES && elementsWithinBudgetWithHint()) {
    insertOmittedHint(elements, omitted, truncationHint);
    return done(true);
  }

  // ========== 阶段4：截断剩余顶层 div 文本 ==========
  // 骨架元素（header/usage 等）自身超限的情况（如超大 displayTitle）。
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

  if (size() <= CARD_BUDGET_BYTES && elementsWithinBudgetWithHint()) {
    insertOmittedHint(elements, omitted, truncationHint);
    return done(true);
  }

  // ========== 阶段4.5：元素数兜底（无面板可删的元素超限） ==========
  // 阶段1-4 只会裁内容/删面板；元素超限且无面板时在此按序丢弃最旧的顶层
  // 元素直到达标（与 table/panel 的「删最旧、留最新」口径一致，尾部操作
  // 按钮保留）。留 ≥3 个元素兜底，仍不达标则交给阶段5 的最小卡。
  if (countCardElements(truncated) > MAX_CARD_ELEMENTS) {
    while (countCardElements(truncated) > MAX_CARD_ELEMENTS && elements.length > 3) {
      elements.shift();
      omitted++;
    }
    reasons.push('element_budget_elements_dropped');
    if (size() <= CARD_BUDGET_BYTES && elementsWithinBudgetWithHint()) {
      insertOmittedHint(elements, omitted, truncationHint);
      return done(true);
    }
  }

  // ========== 阶段5：最终兜底（原 extreme_fallback） ==========
  const minimalCard = cardWithHeader({
    template: 'orange',
    title: '⚠️ 内容已截断',
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '会话内容过大，已自动截断。\n\n请使用 `/active` 查看完整列表。',
        },
      },
    ],
  });

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
 * 计数与裁剪两条路径共用同一遍历，避免两套递归漂移（G5 Duplication）。
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
 * 卡片里含 markdown table 的 lark_md 字段，按**文档顺序**（计数与裁剪共用同一
 * 份遍历，避免两套递归漂移）。
 */
function tableFields(card: object): Array<{ el: CardElementNode; tables: number }> {
  const fields: Array<{ el: CardElementNode; tables: number }> = [];
  walkCardElements((card as CardNode)?.body?.elements ?? [], (el) => {
    if (el.text?.tag === 'lark_md' && typeof el.text.content === 'string') {
      const tables = countMarkdownTables(el.text.content);
      if (tables > 0) fields.push({ el, tables });
    }
  });
  return fields;
}

/**
 * 按**整卡**预算删除 markdown table：`maxTables` 是整张卡的上限，不是每个字段的。
 *
 * 逐字段各限 5 张是空操作（11310 红线失效）：table 分散在多个字段时，每个字段
 * 都「没超限」，一张都不会被删，而守卫照样上报 `table_count_limited`。
 * 这里按文档顺序累计，超出预算的**最旧** table 整块删除、保留最新 `maxTables`
 * 张——与 `truncateMarkdownTables()` 的「删最旧、留最新」口径一致。
 *
 * @returns 实际删除的 table 数（0 = 无需处理，未改动 card）
 */
function capCardMarkdownTables(card: CardNode, maxTables: number): number {
  const fields = tableFields(card);
  const total = fields.reduce((sum, f) => sum + f.tables, 0);

  let dropped = 0;
  for (const { el, tables } of fields) {
    // 每轮按「还差几张」重算：某字段的分隔行数可能多于可删块（畸形表），
    // 只按声明数删会漏。
    const toDrop = total - dropped - maxTables;
    if (toDrop <= 0) break;
    const content = el.text!.content!;
    el.text!.content = dropOldestMarkdownTables(content, Math.min(toDrop, tables));
    dropped += tables - countMarkdownTables(el.text!.content!);
  }
  return dropped;
}
