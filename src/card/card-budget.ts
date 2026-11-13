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
 * **补充判据（2026-11-08 实测）**：`elements` 数组成员数只是近似——它漏算了
 * 文本、列、按钮、select 选项等同样带 `tag` 的节点。真实边界是**整卡所有带
 * `tag` 的节点 ≤ 200**（见 `FEISHU_MAX_CARD_COMPONENTS`）。对纯 div 卡片两者
 * 恰好等价（每个 div 带 1 个文本节点），但对 `column_set` / `select` 密集的
 * 卡片，`elements` 会明显低估：15 行模型列表 + 24 个 select 选项的配置卡
 * `elements` 只有 78（低于 90），`tagged` 已达 201，仍被 11310 拒绝。
 *
 * `MAX_CARD_ELEMENTS` 取 90（相对实测 99 留 10% 余量），用于渲染前的保守裁剪。
 */
export const MAX_CARD_ELEMENTS = 90;

/**
 * 飞书单卡「组件」总量上限（实测，含）。
 *
 * 判据是**整卡所有带 `tag` 字段的节点**：div / column_set / column / button /
 * input / select / plain_text / lark_md / select 的每个选项文本 / header 标题。
 * 2026-11-08 真实 API 探测的通过/失败点（`tagged` 为整卡计数）：
 *
 * | 形状 | tagged | 结果 |
 * | --- | --- | --- |
 * | 配置卡 15 行模型 + 23 个选项 | 200 | ✅ |
 * | 配置卡 15 行模型 + 24 个选项 | 201 | ❌ 11310 |
 * | 顶层平铺 99 / 100 个 div | 199 / 201 | ✅ / ❌ |
 * | 单 column_set 内嵌 98 / 99 个 div | 199 / 201 | ✅ / ❌ |
 * | 单个 column_set 66 / 67 列 | 200 / 203 | ✅ / ❌ |
 * | 79 elements 的 select 密集卡（27 个选项） | 187 | ✅ |
 *
 * 边界正好落在 200：`tagged <= 200` 通过，`>= 201` 报 `11310 element exceeds
 * the limit`。字节数不是判据（同形状 30KB 文本通过，13KB 的配置卡被拒）。
 */
const FEISHU_MAX_CARD_COMPONENTS = 200;

/**
 * 渲染前的保守组件预算（相对实测 200 留 5% 余量）。
 *
 * 必须高于「纯 div 卡片按 `MAX_CARD_ELEMENTS` 裁到 90」时的组件数（90 个 div +
 * 90 个文本 + header 标题 = 181），否则元素预算与组件预算会互相打架。
 */
export const MAX_CARD_COMPONENTS = FEISHU_MAX_CARD_COMPONENTS - 10; // 实测 200 留 5% 余量

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

/**
 * 卡片递归的「带 tag 节点」总数——与飞书 11310 的真实边界对齐。
 *
 * 包含 `elements` 成员、`columns`、以及它们的文本/占位/选项等全部子节点，
 * 也就是渲染树上每个组件节点。用于补上 `countCardElements` 对 `column_set`
 * 与 `select` 密集卡片的低估（见 `FEISHU_MAX_CARD_COMPONENTS` 的实测表）。
 */
export function countCardComponents(card: unknown): number {
  let total = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof (value as { tag?: unknown }).tag === 'string') total++;
    for (const child of Object.values(value as Record<string, unknown>)) walk(child);
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
  /** select_static 的可选项：每项带一个 `plain_text`，是组件预算的大户。 */
  options?: CardSelectOption[];
  /** 当前选中项（value）；裁剪时必须保留，否则下拉显示成占位符。 */
  initial_option?: string;
}

interface CardSelectOption {
  text?: CardText;
  value?: string;
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
  const componentsBefore = countCardComponents(parsed);
  const droppedTables = capCardMarkdownTables(parsed, FEISHU_MAX_TABLES);
  if (droppedTables > 0) {
    const fixedStr = JSON.stringify(parsed);
    // table 截断后可能仍超预算（字节、元素总数或组件总数），继续走后续阶段
    if (
      fitsBudget(
        Buffer.byteLength(fixedStr, 'utf8'),
        countCardElements(parsed),
        countCardComponents(parsed),
      )
    ) {
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

  if (fitsBudget(bytesBefore, elementsBefore, componentsBefore)) {
    return { card, wasTruncated: false, bytesBefore, bytesAfter: bytesBefore };
  }

  // 元素总数或组件总数超限：table 与字节可能都正常，必须先按数量裁剪。
  if (
    bytesBefore <= CARD_BUDGET_BYTES &&
    (elementsBefore > MAX_CARD_ELEMENTS || componentsBefore > MAX_CARD_COMPONENTS)
  ) {
    return enforceElementBudget(parsed, opts, bytesBefore);
  }

  // 字节超限但 table 不超限
  return enforceByteBudget(JSON.parse(cardStr) as CardNode, opts, bytesBefore);
}

/** 同时满足字节、元素总数、组件总数三个预算。 */
function fitsBudget(bytes: number, elements: number, components: number): boolean {
  return (
    bytes <= CARD_BUDGET_BYTES && elements <= MAX_CARD_ELEMENTS && components <= MAX_CARD_COMPONENTS
  );
}

/** 元素总数或组件总数是否超预算。 */
function cardQuantityExceeded(card: CardNode): boolean {
  return (
    countCardElements(card) > MAX_CARD_ELEMENTS || countCardComponents(card) > MAX_CARD_COMPONENTS
  );
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
    while (cardQuantityExceeded(card) && getPanelIndices(elements).length > 0) {
      dropped += dropPanels(1);
    }
    if (dropped > 0) reasons.push('element_budget_panels_dropped');
  }
  if (!cardQuantityExceeded(card) && size() <= CARD_BUDGET_BYTES) {
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
 * 标题文本。历史教训：旧实现用
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
 *   阶段5 裁下拉选项（最长的先裁，保留选中项与全部控件行）
 *   阶段6 兜底：丢弃最旧的顶层元素（配置卡以外的行式卡片）
 *   阶段7 最终兜底 minimal card（骨架本身已超限的病理场景）
 */
/**
 * 字节预算降级各阶段共享的可变状态。
 *
 * 原实现把这些状态（reasons / omitted / modifications / ...）连同 size /
 * done / dropOldestPanels / elementsWithinBudgetWithHint 四个箭头闭包一起塞在
 * `enforceByteBudget` 内部——crapper 把闭包里的决策点也算进外层函数（CC 37）。
 * 现在状态显式装进 ctx，闭包全部抽成模块顶层命名函数，外层只做线性编排。
 */
interface ByteBudgetContext {
  truncated: CardNode;
  elements: CardElementNode[];
  reasons: string[];
  /** 被整块丢弃的面板 / 顶层元素数（会渲染成「还有 N 个事件未显示」）。 */
  omitted: number;
  /** 被裁掉的下拉选项数（控件行保留，只收缩可选项）。 */
  optionsTrimmed: number;
  modifications: number;
  textTruncations: number;
  maxEventPanels: number;
  maxPanelContentBytes: number;
  truncationHint: string;
  bytesBefore?: number;
}

function makeByteBudgetContext(
  truncated: CardNode,
  opts: CardBudgetOptions,
  bytesBefore: number | undefined,
): ByteBudgetContext {
  const {
    maxEventPanels = 5,
    maxPanelContentBytes = 2000,
    truncationHint = '📜 还有 {count} 个事件未显示',
  } = opts;
  return {
    truncated,
    elements: truncated.body?.elements ?? [],
    reasons: [],
    omitted: 0,
    optionsTrimmed: 0,
    modifications: 0,
    textTruncations: 0,
    maxEventPanels,
    maxPanelContentBytes,
    truncationHint,
    bytesBefore,
  };
}

/** 原 size 闭包：当前卡片序列化字节数。 */
function byteBudgetSize(ctx: ByteBudgetContext): number {
  return Buffer.byteLength(JSON.stringify(ctx.truncated), 'utf8');
}

/** 原 done 闭包：构造结果对象（reason 由各阶段累积）。 */
function byteBudgetDone(ctx: ByteBudgetContext, wasTruncated: boolean): BudgetResult {
  return {
    card: ctx.truncated,
    wasTruncated,
    reason: ctx.reasons.join('+') || undefined,
    bytesBefore: ctx.bytesBefore ?? byteBudgetSize(ctx),
    bytesAfter: byteBudgetSize(ctx),
  };
}

/** 原 elementsWithinBudgetWithHint 闭包（含 hint 预留位）。 */
function byteBudgetElementsWithin(ctx: ByteBudgetContext): boolean {
  return !elementBudgetExceeded(ctx);
}

/**
 * 元素总数或组件总数是否超预算——把「裁剪后要补的省略提示」算进去。
 *
 * 提示本身占 1 个元素 / 2 个组件（div + 文本）；只按裸数量裁到恰好 MAX，
 * 补提示后就会越界，所有裁剪/判定共用这一个口径。提示对「删了面板/元素」与
 * 「裁了下拉选项」两种情况都要预留（任一来源非空都会写提示）。
 */
function elementBudgetExceeded(ctx: ByteBudgetContext): boolean {
  const hasHint = ctx.omitted > 0 || ctx.optionsTrimmed > 0;
  const hintElements = hasHint ? 1 : 0;
  const hintComponents = hasHint ? 2 : 0;
  return (
    countCardElements(ctx.truncated) + hintElements > MAX_CARD_ELEMENTS ||
    countCardComponents(ctx.truncated) + hintComponents > MAX_CARD_COMPONENTS
  );
}

/** 原 `size() <= ... && elementsWithinBudgetWithHint()` 达标判定。 */
function byteBudgetFits(ctx: ByteBudgetContext): boolean {
  return byteBudgetSize(ctx) <= CARD_BUDGET_BYTES && byteBudgetElementsWithin(ctx);
}

function comparePanelIndexDesc(a: number, b: number): number {
  return b - a;
}

/** 原 dropOldestPanels 闭包：按文档顺序删最旧的 count 个面板。 */
function dropOldestPanels(ctx: ByteBudgetContext, count: number): void {
  const indices = getPanelIndices(ctx.elements).slice(0, count).sort(comparePanelIndexDesc);
  for (const idx of indices) {
    ctx.elements.splice(idx, 1);
    ctx.omitted++;
  }
}

/** 达标则插入 hint 并返回结果；未达标返回 undefined，交给下一阶段继续降级。 */
function byteBudgetTryFinish(
  ctx: ByteBudgetContext,
  wasTruncated: boolean,
): BudgetResult | undefined {
  if (!byteBudgetFits(ctx)) return undefined;
  insertOmittedHint(ctx);
  return byteBudgetDone(ctx, wasTruncated);
}

// ========== 阶段1：裁剪所有面板的内容 ==========
function truncatePanelContents(ctx: ByteBudgetContext): void {
  for (const el of ctx.elements) {
    if (el.tag !== 'collapsible_panel') continue;
    for (const inner of el.elements ?? []) {
      if (inner.tag === 'div' && inner.text?.content) {
        const content = inner.text.content;
        if (Buffer.byteLength(content, 'utf8') > ctx.maxPanelContentBytes) {
          inner.text.content = truncateUtf8(content, ctx.maxPanelContentBytes);
          ctx.modifications++;
        }
      }
    }
  }
  if (ctx.modifications > 0) {
    ctx.reasons.push('panel_content_truncated');
  }
}

// ========== 阶段2：限制面板数量（删除最老） ==========
function limitPanelCount(ctx: ByteBudgetContext): void {
  const panelCount = getPanelIndices(ctx.elements).length;
  if (panelCount > ctx.maxEventPanels) {
    dropOldestPanels(ctx, panelCount - ctx.maxEventPanels);
    ctx.reasons.push('event_count_limited');
  }
}

// ========== 阶段3：丢弃全部面板，保留卡片骨架 ==========
// header（cwd/sessionId/标题）、usage、操作按钮等信息量高、体积小的元素
// 必须保留——整卡替换为一句话是信息损失最大的降级方式。
function dropAllPanels(ctx: ByteBudgetContext): void {
  dropOldestPanels(ctx, getPanelIndices(ctx.elements).length);
  if (ctx.omitted > 0) {
    ctx.reasons.push('panels_dropped');
  }
}

// ========== 阶段4：截断剩余顶层 div 文本 ==========
// 骨架元素（header/usage 等）自身超限的情况（如超大 displayTitle）。
function truncateTopLevelDivs(ctx: ByteBudgetContext): void {
  for (const el of ctx.elements) {
    if (el.tag === 'div' && el.text?.content) {
      const content = el.text.content;
      if (Buffer.byteLength(content, 'utf8') > ctx.maxPanelContentBytes) {
        el.text.content = truncateUtf8(content, ctx.maxPanelContentBytes);
        ctx.textTruncations++;
      }
    }
  }
  if (ctx.textTruncations > 0) {
    ctx.reasons.push('text_truncated');
  }
}

// ========== 阶段5：裁下拉选项（最长列表先裁） ==========
// 配置卡的组件数几乎全在 select 的选项上：`pi --list-models` 单个 provider 就能
// 列出上百个模型，每个选项占 1 个 `plain_text` 节点。整行丢弃会把控件一起删掉
// （默认 Agent 选择器曾因此从卡片上消失，只留一句「还有 N 个事件未显示」）；
// 裁选项只收缩可选项，行结构、标签与回调全部保留。
function trimSelectOptions(ctx: ByteBudgetContext): void {
  const selects = collectSelectNodes(ctx.truncated).sort(
    (a, b) => (b.options?.length ?? 0) - (a.options?.length ?? 0),
  );
  for (const sel of selects) {
    while (elementBudgetExceeded(ctx) && dropOneSelectOption(sel)) ctx.optionsTrimmed++;
  }
  if (ctx.optionsTrimmed > 0) ctx.reasons.push('select_options_trimmed');
}

/** 收集整卡的下拉（含 column_set 内嵌），按选项数降序裁。 */
function collectSelectNodes(card: CardNode): CardElementNode[] {
  const found: CardElementNode[] = [];
  walkCardElements(card.body?.elements ?? [], (el) => {
    if (el.tag === 'select_static' && Array.isArray(el.options) && el.options.length > 0) {
      found.push(el);
    }
  });
  return found;
}

/**
 * 删一个选项：从尾部删，但绝不删选中项（选中项在尾部时改删它前一个）。
 *
 * 保留原顺序而不是把选中项提到队首：选项顺序（provider 分组/字母序）本身是
 * 信息，裁剪不该顺手重排。
 */
function dropOneSelectOption(sel: CardElementNode): boolean {
  const options = sel.options;
  if (!options || options.length <= 1) return false;
  const lastIndex = options.length - 1;
  if (options[lastIndex].value === sel.initial_option && lastIndex > 0) {
    options.splice(lastIndex - 1, 1);
  } else {
    options.pop();
  }
  return true;
}

// ========== 阶段6：元素数兜底（无面板可删的元素超限） ==========
// 阶段1-5 只会裁内容/删面板/收缩下拉；元素超限且这些手段都不够时，在此按序
// 丢弃最旧的顶层元素直到达标（与 table/panel 的「删最旧、留最新」口径一致，
// 尾部操作按钮保留）。留 ≥3 个元素兜底，仍不达标则交给阶段7 的最小卡。
//
// 达标判定必须用 `elementBudgetExceeded`（含省略提示预留位）：只按裸元素
// 数裁到恰好 MAX 时，补提示后变成 MAX+1，判定不达标且本阶段不再重试，
// 整卡被换成最小卡（元素数刚超限的配置卡曾整卡变成「⚠️ 内容已截断」）。
function dropExcessElements(ctx: ByteBudgetContext): BudgetResult | undefined {
  if (elementBudgetExceeded(ctx)) {
    while (elementBudgetExceeded(ctx) && ctx.elements.length > 3) {
      ctx.elements.shift();
      ctx.omitted++;
    }
    ctx.reasons.push('element_budget_elements_dropped');
    return byteBudgetTryFinish(ctx, true);
  }
  return undefined;
}

// ========== 阶段7：最终兜底（原 extreme_fallback） ==========
function byteBudgetMinimalCard(ctx: ByteBudgetContext): BudgetResult {
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
    bytesBefore: ctx.bytesBefore ?? byteBudgetSize(ctx),
    bytesAfter: Buffer.byteLength(JSON.stringify(minimalCard), 'utf8'),
  };
}

function enforceByteBudget(
  truncated: CardNode,
  opts: CardBudgetOptions = {},
  bytesBefore?: number,
): BudgetResult {
  const ctx = makeByteBudgetContext(truncated, opts, bytesBefore);

  truncatePanelContents(ctx);
  limitPanelCount(ctx);
  let result = byteBudgetTryFinish(ctx, ctx.modifications > 0 || ctx.omitted > 0);
  if (result) return result;

  dropAllPanels(ctx);
  result = byteBudgetTryFinish(ctx, true);
  if (result) return result;

  truncateTopLevelDivs(ctx);
  result = byteBudgetTryFinish(ctx, true);
  if (result) return result;

  trimSelectOptions(ctx);
  result = byteBudgetTryFinish(ctx, true);
  if (result) return result;

  result = dropExcessElements(ctx);
  if (result) return result;

  return byteBudgetMinimalCard(ctx);
}

/**
 * 在卡片头部插入一条「省略了什么」的提示；没有任何省略时什么都不插。
 *
 * 事件口径（面板/元素被整块丢弃）与选项口径（下拉列表被收缩）分开命名：
 * 配置卡上没有「事件」，把裁掉的选项写成「事件未显示」会让人以为会话丢内容。
 */
function insertOmittedHint(ctx: ByteBudgetContext): void {
  const content = omittedHintContent(ctx);
  if (!content) return;
  ctx.elements.unshift({ tag: 'div', text: { tag: 'lark_md', content } });
}

function omittedHintContent(ctx: ByteBudgetContext): string | undefined {
  const optionNote = ctx.optionsTrimmed > 0 ? `${ctx.optionsTrimmed} 个选项` : '';
  if (ctx.omitted <= 0) return optionNote ? `📜 还有 ${optionNote}未显示` : undefined;
  const base = ctx.truncationHint.replace('{count}', String(ctx.omitted));
  return optionNote ? `${base}（另有 ${optionNote}未显示）` : base;
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
