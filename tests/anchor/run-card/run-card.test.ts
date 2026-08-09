/**
 * Merged anchor tests for RunCardSession + renderRunCard budget behavior
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - run-card-budget-estimate-cjk.test.ts
 *   - run-card-budget-estimate-degrades-large-state.test.ts
 *   - run-card-extreme-fallback-budget-invariant.test.ts
 *   - run-card-push-coalesce.test.ts
 *   - run-card-settle-start-skip-budget.test.ts
 *   - run-card-skip-budget.test.ts
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from '../../../src/card/run-card-session.js';
import * as cardBudget from '../../../src/card/card-budget.js';
import { renderRunCard, estimateCardBytes } from '../../../src/card/run-renderer.js';
import type { RunState } from '../../../src/card/run-state.js';

// ---------------------------------------------------------------------------
// RunCardSession budget skip (push path)
// ---------------------------------------------------------------------------

/**
 * Anchor: RunCardSession 流式更新必须绕过静态预算裁剪层 enforceCardBudget
 *
 * 验证行为：RunCardSession.push(event) 触发的 updateCard() 不应调用
 * enforceCardBudget。因为 renderRunCard 自带 3 层 degraded/extreme fallback
 * 预算保护（src/card/run-renderer.ts buildDegradedElements/
 * buildExtremeFallbackElements），已保证返回卡 ≤28KB，静态裁剪层
 * enforceCardBudget 对 run 卡是冗余的。
 *
 * 缺失/错误后果：每个 agent 事件多一次全卡 JSON.stringify（enforceCardBudget
 * 内部第 51 行 `JSON.stringify(card)` 即使未超预算也要全量序列化），流式
 * CPU -20~33% 浪费（§P1-1 测得），且与
 * card-budget.ts:3-8 文件头注释"不适用于 run-renderer 的流式卡片"矛盾。
 *
 * 依据：§P1-1 + src/card/card-budget.ts:3-8 注释。
 */
describe('RunCardSession budget skip', () => {
  it('test_anchor_run_card_skips_enforce_card_budget', async () => {
    // Spy 追踪 enforceCardBudget 导出函数的调用（合规：不替换内部实现）
    const spy = vi.spyOn(cardBudget, 'enforceCardBudget');

    const capture = { updates: [] as object[] };
    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async (card) => {
        capture.updates.push(typeof card === 'function' ? card({}) : card);
      },
    };
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-1';
      },
      updateCard: async () => {},
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-1',
    });

    await session.start();
    // 最小 assistant text 事件，renderRunCard 正常路径返回远小于 28KB 的卡
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });

    // 核心不变量：run 卡流式更新绕过静态预算裁剪层
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RunCardSession start/settle budget skip
// ---------------------------------------------------------------------------

/**
 * ANCHOR (P3) — RunCardSession start()/settle() 也跳过 enforceCardBudget。
 *
 * 意图（必须完整保留）：
 * ① 补齐测试覆盖对称性：run-card-skip-budget 已验证 updateCard（push）
 *    路径跳过 enforceCardBudget，但 start() producer 初始卡和 settle() fallback
 *    路径无对应 anchor。RunCardSession.hasOwnBudgetProtection=true，三条路径
 *    都经 safeRenderCard 统一跳过 enforceCardBudget，应一并验证。
 * ② 缺失后果：若有人误改 safeRenderCard 或 start/settle 绕过它，run 卡将
 *    重新经冗余的 enforceCardBudget（静态裁剪层对 run 卡是 misfit），浪费
 *    CPU 且可能误裁剪 run 卡的 thinking/tool panels。
 *
 * 依据：§P1-1 + renderRunCard 3 层 degraded/extreme
 * fallback 自带预算保护。
 */
describe('RunCardSession start/settle budget skip (anchor)', () => {
  it('test_anchor_run_card_start_skips_enforce_budget', async () => {
    const spy = vi.spyOn(cardBudget, 'enforceCardBudget');

    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async () => {},
    };
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-1';
      },
      updateCard: async () => {},
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-start-1',
    });

    await session.start();

    // 核心断言：start producer 初始 controller.update 经 safeRenderCard 跳过
    // enforceCardBudget（renderRunCard 自带 3 层 degraded/extreme fallback）。
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('test_anchor_run_card_settle_skips_enforce_budget', async () => {
    const spy = vi.spyOn(cardBudget, 'enforceCardBudget');

    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async () => {},
    };
    const updated: Array<{ messageId: string; card: object }> = [];
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        // producer 完成后 throw，使 streamOutcome reject → settle 走 fallback
        throw new Error('complete failed');
      },
      updateCard: async (messageId: string, card: object) => {
        updated.push({ messageId, card });
      },
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-settle-1',
    });

    await session.start();
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    await session.finish('done');
    spy.mockClear();

    const result = await session.settle();

    // 守护：走了 settle fallback，仍产出卡片
    expect(result).toBe('updated');
    expect(updated).toHaveLength(1);

    // 核心断言：settle fallback 经 safeRenderCard 跳过 enforceCardBudget。
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// P1-3: RunCardSession push coalescing
// ---------------------------------------------------------------------------

/**
 * ANCHOR (P1-3 push 合批核心契约) — RunCardSession.push 当前每事件一次
 * render + controller.update（run-card-session.ts:54-57）。text 流式 50 事件/秒
 * = 50 次 render+patch/秒，是流式 CPU 主要来源（§P1-3）。
 *
 * 目标行为（必须完整保留）：
 * push 加 50–100ms coalescer —— 窗口内连续多个事件只触发一次 render +
 * controller.update。state 仍每事件 reduce（始终最新），但 updateCard 延迟到
 * 窗口末尾，窗口内多次 push 复用同一延迟调度。
 *
 * 意图：连续 N 个 text delta push 后，controller.update 调用次数应明显少于 N
 * （合批生效），且窗口 flush 后的最终 update 必须含全部累积文本（state 正确，
 * 不因延迟丢内容）。
 *
 * 缺失会导致什么：
 * - 若不合批：update 调用次数 == push 次数（每事件一次 render，CPU 无收益）。
 * - 若合批但丢内容：最终 update 缺少部分 text delta（延迟 flush 漏 reduce 的 state）。
 * - 若合批但永不 flush：终态前内容停留在第一帧（窗口未到期）。
 *
 * 依据：§P1-3「更短路径：在 push 加 50–100ms coalescer：
 * 一个 tick/microtask 内多个事件只触发一次 renderCard + controller.update」。
 * 约束：finish() 必须立即 flush（R2）；最后 push 后残留窗口必须 flush（R3）。
 */
describe('RunCardSession push coalescing (P1-3)', () => {
  let updates: object[];
  let controller: CardStreamController;

  beforeEach(() => {
    vi.useFakeTimers();
    updates = [];
    controller = {
      messageId: 'card-coal',
      current: {},
      update: async (card) => {
        updates.push(typeof card === 'function' ? (card as (cur: object) => object)({}) : card);
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_anchor_push_coalesces_multiple_text_deltas_into_fewer_updates', async () => {
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-coal';
      },
      updateCard: async () => {},
    };
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-coal',
    });
    await session.start();

    // 记录 start 后的初始 update 次数（start 自带一次 initial controller.update）
    const updatesAfterStart = updates.length;

    // 连续 10 个 text delta push，模拟 text 流式（每事件几字符）
    for (let i = 0; i < 10; i++) {
      await session.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `chunk-${i} ` }] },
      });
    }

    // 合批契约：窗口未到期 + fake timer 不推进，这 10 次 push 全部延迟，burst
    // 期间 controller.update 调用次数应为 0（全部落进同一延迟调度）。若 == 10
    // 则无合批（每事件一次 render）。
    const updatesDuringBurst = updates.length - updatesAfterStart;
    expect(
      updatesDuringBurst,
      `10 text deltas triggered ${updatesDuringBurst} updates during burst (no coalescing)`,
    ).toBe(0);

    // 推进窗口让残留 flush
    await vi.advanceTimersByTimeAsync(120);

    // 窗口 flush 后，最终 update 必须含全部累积文本（state 正确，不丢内容）
    const lastUpdate = JSON.stringify(updates.at(-1));
    for (let i = 0; i < 10; i++) {
      expect(lastUpdate, `chunk-${i} missing after flush`).toContain(`chunk-${i}`);
    }

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  /**
   * ANCHOR (P2-1 in-flight flush 期间到达的事件必须重新调度) — scheduleFlush
   * 用 `if (this.flushTimer || this.flushInFlight) return` 守卫。生产 SDK 的
   * controller.update 走 throttle + setTimeout 异步 resolve（非微任务，§9.20），
   * 当一次 flush 正在 await update 期间（flushInFlight=true）有新 push 到达：
   * 事件已 reduce 进 state，但 scheduleFlush 因 flushInFlight 早退不调度新 timer，
   * 且 in-flight flush 的 finally 不重新检查 → 该事件留在 state 无 render，直到
   * 下一个事件或 finish。终态帧正确（finish 渲染含该事件的 state），但中间帧
   * 瞬态缺失（用户看到 stale 帧）。
   *
   * 此锚点模拟生产 SDK：让 e1 的 flush update 返回一个可控 pending promise，
   * flush 进入 in-flight；在 in-flight 期间 push e2；resolve e1 的 update 后，
   * e2 必须被一次 follow-up render 捕获（不能停留在 e1）。
   */
  it('test_anchor_event_pushed_during_in_flight_flush_is_re_rendered', async () => {
    let resolveUpdate: () => void = () => {};
    let updateCallCount = 0;
    const pendingUpdate = () =>
      new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });

    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-inflight';
      },
      updateCard: async () => {},
    };
    const _inflightController: CardStreamController = {
      messageId: 'card-inflight',
      current: {},
      update: async (card) => {
        updateCallCount++;
        updates.push(typeof card === 'function' ? (card as (cur: object) => object)({}) : card);
        // 第 1 次：start() 初始卡，立即完成。
        // 第 2 次：e1 的 flush，挂起模拟 SDK throttle detach。
        if (updateCallCount === 2) {
          await pendingUpdate();
        }
      },
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-inflight',
    });
    await session.start();
    const updatesAfterStart = updates.length;

    // e1：触发合批窗口
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'e1-text' }] },
    });
    // 推进窗口 → flush 启动，第 2 次 update 挂起（in-flight）
    await vi.advanceTimersByTimeAsync(120);
    expect(updates.length - updatesAfterStart, 'e1 flush should have rendered').toBe(1);

    // 在 in-flight 期间 push e2（flushInFlight=true）
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'e2-text' }] },
    });

    // resolve e1 的 in-flight flush
    resolveUpdate();
    // 让 microtask 跑完 + follow-up 调度窗口到期（post-fix: pendingReschedule
    // 触发 scheduleFlush → 新 timer → coalesceMs 后 flush 渲染 e2）
    await vi.advanceTimersByTimeAsync(120);

    // 关键断言：e2 必须被一次 follow-up render 捕获。
    // pre-fix：in-flight resolve 后无 follow-up，最后一次 update 只含 e1。
    // post-fix：pendingReschedule 触发 follow-up flush，e2 被渲染。
    const lastUpdate = JSON.stringify(updates.at(-1));
    expect(
      lastUpdate,
      'e2 pushed during in-flight flush was not re-rendered (stale intermediate frame)',
    ).toContain('e2-text');

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });
});

// ---------------------------------------------------------------------------
// renderRunCard budget estimate = shadow measurement (CJK)
// ---------------------------------------------------------------------------

/**
 * ANCHOR (影子测量：估算 = 测量将要渲染的内容) — `estimateCardBytes` 必须精确
 * 复刻 normal 路径的产物字节，而不是近似。
 *
 * 意图（必须完整保留）：
 * P1-2 第二轮（2026-07-31）把估算从「字符数/字节数 × 转义因子 + 拍脑袋常数」改为
 * **影子测量**：骨架（schema/header/statusRow/summary/按钮）小对象实测，块内容经
 * 与渲染完全相同的变换（truncateUtf8 截断 + markdownDiv 的 escapeMarkdown +
 * JSON.stringify）精确测量。CJK（3 字节/字符无转义）与 ASCII 高转义（\n/" 反斜杠
 * 膨胀）双向精确，无需任何因子。
 *
 * 三类断言：
 * ① **精度不变量**：对各类状态（ASCII/CJK/高转义/tool/plan/file_change/空），
 *    `estimateCardBytes(state)` 与实际渲染卡 stringify 字节数差 ≤ 200 字节
 *    （实测 1~2 字节）。若有人回退到字符数（CJK 低估 2.5×）或 ×1.2 因子（CJK
 *    高估 20%），差值达数千字节 → 本 anchor 变 RED。
 * ② **CJK 卡实际放得下 → 正常路径全量渲染**：估算 ≈ 20.9KB < 阈值，thinking
 *    全部保留（旧 ×1.2 估算 ~32KB ≥ 阈值会误降级丢 thinking——修复该 UX 缺口）。
 * ③ **巨量 CJK → 产物仍 ≤28KB**：正确性底线（字符串化兜底 + 降级链）。
 *
 * 缺失会导致什么：
 * - 估算失真 → CJK 长会话每次事件多付「建完整卡 + stringify + 丢弃」（低估），
 *   或本可完整展示的卡被误降级丢早期 thinking/tool（高估）。
 *
 * 依据：P1-2 第一性原理分析（2026-07-31）——「不要为 CJK 特设逻辑，让估算与
 * 测量对齐，CJK 自然正确」。
 */
type AnyBlock = Record<string, unknown>;

function makeState(blocks: AnyBlock[]): RunState {
  return {
    runId: 'run-shadow-measure',
    terminal: 'done',
    footer: null,
    blocks: blocks as RunState['blocks'],
    sessionId: 's-shadow',
    resultSubtype: 'success',
  };
}

function jsonBytes(o: unknown): number {
  return Buffer.byteLength(JSON.stringify(o), 'utf8');
}

describe('renderRunCard budget estimate = shadow measurement', () => {
  it('test_anchor_estimate_matches_rendered_bytes_within_tolerance', () => {
    const ts = '2026-07-31T10:00:00.000Z';
    const cases: Array<[string, AnyBlock[]]> = [
      ['ascii-text', [{ kind: 'text', content: 'y'.repeat(5000), timestamp: ts }]],
      ['cjk-text', [{ kind: 'text', content: '丙'.repeat(2500), timestamp: ts }]],
      [
        'cjk-mixed',
        [
          {
            kind: 'thinking',
            content: 'HEAD-THINK-1-' + '戊'.repeat(900),
            active: false,
            timestamp: ts,
          },
          {
            kind: 'thinking',
            content: 'HEAD-THINK-2-' + '戊'.repeat(900),
            active: false,
            timestamp: ts,
          },
          {
            kind: 'thinking',
            content: 'HEAD-THINK-3-' + '戊'.repeat(900),
            active: false,
            timestamp: ts,
          },
          { kind: 'text', content: 'HEAD-TEXT-1-' + '丙'.repeat(2500), timestamp: ts },
          { kind: 'text', content: 'HEAD-TEXT-2-' + '丙'.repeat(2500), timestamp: ts },
        ],
      ],
      ['high-escape', [{ kind: 'text', content: '\\'.repeat(3000), timestamp: ts }]],
      [
        'tool',
        [
          {
            kind: 'tool',
            tool: {
              id: 't1',
              name: 'Bash',
              input: { command: 'echo hi' },
              output: 'o'.repeat(1200),
              status: 'ok',
              startedAt: ts,
              completedAt: ts,
            },
          },
        ],
      ],
      ['plan', [{ kind: 'plan', content: '计划内容'.repeat(200), active: false, timestamp: ts }]],
      [
        'file_change',
        [
          {
            kind: 'file_change',
            path: '/a/b.ts',
            operation: 'edit',
            diff: 'diff'.repeat(500),
            timestamp: ts,
          },
        ],
      ],
      ['empty', []],
    ];

    for (const [name, blocks] of cases) {
      const state = makeState(blocks);
      const estimate = estimateCardBytes(state);
      // 该状态估算 < 阈值 → renderRunCard 走正常路径返回完整卡，actual = 正常卡字节
      const actual = jsonBytes(renderRunCard(state));
      expect(Math.abs(estimate - actual), name).toBeLessThanOrEqual(200);
    }
  });

  it('test_anchor_cjk_fits_renders_full_not_overdegraded', () => {
    // 估算 ≈ 20.9KB < 24000 → 正常路径：thinking1/2/3 全量保留，无 omission hint
    const state = makeState([
      {
        kind: 'thinking',
        content: 'HEAD-THINK-1-' + '戊'.repeat(900),
        active: false,
        timestamp: '2026-07-31T09:01:00.000Z',
      },
      {
        kind: 'thinking',
        content: 'HEAD-THINK-2-' + '戊'.repeat(900),
        active: false,
        timestamp: '2026-07-31T09:02:00.000Z',
      },
      {
        kind: 'thinking',
        content: 'HEAD-THINK-3-' + '戊'.repeat(900),
        active: false,
        timestamp: '2026-07-31T09:03:00.000Z',
      },
      {
        kind: 'text',
        content: 'HEAD-TEXT-1-' + '丙'.repeat(2500),
        timestamp: '2026-07-31T09:11:00.000Z',
      },
      {
        kind: 'text',
        content: 'HEAD-TEXT-2-' + '丙'.repeat(2500),
        timestamp: '2026-07-31T09:12:00.000Z',
      },
    ]);

    expect(estimateCardBytes(state)).toBeLessThan(24_000);

    const json = JSON.stringify(renderRunCard(state));
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);

    // 全量渲染：thinking1/3 都保留（若被误降级，早期 thinking 会被省略）
    expect(json).toContain('HEAD-THINK-1-');
    expect(json).toContain('HEAD-THINK-3-');
    expect(json).toContain('戊'.repeat(900));
    // 无 omission hint → 未走降级路径
    expect(json).not.toMatch(/已省略/);

    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_huge_cjk_stays_within_budget', () => {
    // 6 个 text × 2500 CJK 字符（各 ~7.5KB），交错 thinking 防止 groupBlocks 合并
    // → 估算 ~50KB+ ≥ 阈值 → 降级链兜底，产物必须 ≤28KB
    const blocks: AnyBlock[] = [];
    for (let i = 0; i < 6; i++) {
      blocks.push({
        kind: 'text',
        content: 'BIG-CJK-' + i + '-' + '丙'.repeat(2500),
        timestamp: `2026-07-31T09:2${i}:00.000Z`,
      });
      if (i < 5) {
        blocks.push({
          kind: 'thinking',
          content: '戊'.repeat(50),
          active: false,
          timestamp: `2026-07-31T09:3${i}:00.000Z`,
        });
      }
    }
    const state = makeState(blocks);

    expect(estimateCardBytes(state)).toBeGreaterThanOrEqual(24_000);

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });
});

// ---------------------------------------------------------------------------
// renderRunCard budget estimate (A2+A3) — large state degrades correctly
// ---------------------------------------------------------------------------

/**
 * ANCHOR (预算估算上界 + 保守性) — renderRunCard 对明显超 28KB 的大 RunState
 * 必须走降级路径，保证产物 ≤28KB 且含 omission hint。
 *
 * 意图（必须完整保留）：
 * P1-2 spec 要求 renderRunCard 在构建完整卡对象之前先用廉价估算预测是否超
 * 28KB 预算，明显超预算直接跳过完整卡构建走 degraded。本 anchor 不断言"是否
 * 先估后建"（实现细节，行为层无法观测），而是断言**降级行为正确**——这是无论
 * 优化前后都必须成立的行为契约：
 *
 * ① 卡片产物 ≤28KB（不触发飞书 11310 单卡 5 table / 28KB 上限错误）—— 正确性底线
 * ② 走了 degraded 路径：含 omission hint（`5 个早期思考已省略` 或
 *    `另外 2 个工具调用已省略`），且不含早期 thinking（`思考1`）—— 证明超预算被识别并降级
 *
 * 缺失会导致什么：
 * - 若估算逻辑误判"不超预算"走正常路径，完整卡 ~100KB+ 会超 28KB → 飞书 11310
 *   报错整卡不可用，用户看到空/错卡。
 * - 若绿用 `return True` 或硬编码跳过降级作弊，联合断言（≤28KB + 含 omission
 *   hint + 不含早期 thinking）会露馅：要么超 28KB，要么缺 omission hint。
 *
 * 依据：P1-2 spec（renderRunCard 预算估算优化）。
 *
 * 构造：7 个大 thinking（每个 ~2.5KB）+ 5 个大 tool output（每个 ~3.5KB）
 * + 大文本（~8KB），完整卡远超 28KB，参照 run-renderer.test.ts 的
 * `degrades thinking: keeps last 2` fixture 构造方式。
 */
describe('renderRunCard budget estimate (A2+A3)', () => {
  it('test_anchor_run_card_budget_estimate_degrades_large_state', () => {
    const state: RunState = {
      runId: 'run-budget-estimate',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-budget',
      resultSubtype: 'success',
    };

    // 7 thinking blocks — degraded 路径只保留最近 2 个
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-07-30T10:0${i}:00.000Z`,
      });
    }

    // 5 tool blocks with large output — degraded 路径只保留最近 3 个
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-budget-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-07-30T10:10:00.000Z',
          completedAt: '2026-07-30T10:11:00.000Z',
        },
      });
    }

    // Large text — degraded 路径完整保留
    state.blocks.push({
      kind: 'text',
      content: '必须完整保留的文本输出。' + 'T'.repeat(8000),
      timestamp: '2026-07-30T10:30:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // ① 正确性底线：产物 ≤28KB，不触发飞书 11310
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // ② 走了 degraded 路径：含 omission hint
    const hasThinkingOmission = /5 个早期思考已省略/.test(json);
    const hasToolOmission = /另外 2 个工具调用已省略/.test(json);
    expect(hasThinkingOmission || hasToolOmission).toBe(true);

    // ② 不含早期 thinking（证明降级裁剪生效，而非完整渲染塞进 28KB）
    expect(json).not.toContain('思考1');
    expect(json).not.toContain('思考2');
    expect(json).not.toContain('思考3');
    expect(json).not.toContain('思考4');
    expect(json).not.toContain('思考5');

    // 降级路径仍保留最近 thinking
    expect(json).toContain('思考6');
    expect(json).toContain('思考7');

    // CardKit 2.0 schema 合规
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });
});

// ---------------------------------------------------------------------------
// renderRunCard extreme fallback ≤28KB invariant
// ---------------------------------------------------------------------------

/**
 * ANCHOR (extreme fallback ≤28KB 不变量) — renderRunCard 的三层降级链
 * (normal → degraded → extreme) 中，extreme 是最后一层，直接 return 不再检查
 * 预算。若 extreme 产物本身 >28KB，会直发飞书触发 11310 错误，整卡不可用。
 *
 * 意图（必须完整保留）：
 * extreme fallback 保留 last 1 thinking(截 1000) + last 1 tool + text(合并截 5000)。
 * 当这些内容是高转义字符（反斜杠 `\`）时，体积膨胀 4×：
 *   - escapeMarkdown 把 `\` → `\\`（2×）
 *   - JSON.stringify 再把 `\\` → `\\\\`（再 2×，合计 4×）
 * 5000 个 `\` 的 text → 20000 字节；1000 个 `\` 的 thinking → 4000 字节；
 * 满 tool（cmd 600 + output 1200 的 `\`）body → ~10000 字节。合计远超 28KB。
 *
 * 缺失会导致什么：
 * - extreme 产物 33651 bytes > 28000 → 飞书 11310 整卡不可用，用户看到空/错卡。
 * - 这是 renderRunCard 的最终安全网失效，无更深层兜底。
 *
 * 依据：飞书卡片单卡 28KB 上限（CARD_BUDGET_BYTES）；extreme fallback 必须保证
 * 任何输入下产物 ≤28KB。CLAUDE.md「飞书卡片表格限制（ErrCode 11310）」+ P1-2 spec
 * 「不得破坏卡片 ≤28KB 保证」。
 *
 * 构造：3 个 5000-`\` text（间插 tool 阻止合并，extreme 滤掉早期 tool 后合并截 5000）
 * + 1 个 4000-`\` thinking（extreme 保留 last 1 截 1000）+ 1 个满 backslash tool
 * （cmd 600 + output 1200 的 `\`，extreme 保留 last 1）。
 */
describe('renderRunCard extreme fallback ≤28KB invariant', () => {
  it('test_anchor_extreme_fallback_high_escape_within_budget', () => {
    const state: RunState = {
      runId: 'run-extreme-invariant',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-extreme',
      resultSubtype: 'success',
    };

    // 3 个高转义 text（间插 tool），extreme 合并后截 5000 个 `\` → 转义 4× = 20000 字节
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\\'.repeat(5000),
        timestamp: `2026-07-30T20:0${i}:00.000Z`,
      });
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-ext-' + i,
          name: 'Bash',
          input: { command: 'c'.repeat(600) },
          output: 'o'.repeat(1200),
          status: 'ok',
          startedAt: '2026-07-30T20:10:00.000Z',
          completedAt: '2026-07-30T20:11:00.000Z',
        },
      });
    }
    // last thinking 高转义（extreme 保留 last 1，截 1000 个 `\` → 4000 字节）
    state.blocks.push({
      kind: 'thinking',
      content: '\\'.repeat(4000),
      active: false,
      timestamp: '2026-07-30T20:30:00.000Z',
    });
    // last tool 满 + 高转义（extreme 保留 last 1，body ~2500 个 `\` → ~10000 字节）
    state.blocks.push({
      kind: 'tool',
      tool: {
        id: 'tool-ext-last',
        name: 'Bash',
        input: { command: '\\'.repeat(600) },
        output: '\\'.repeat(1200),
        status: 'ok',
        startedAt: '2026-07-30T20:40:00.000Z',
        completedAt: '2026-07-30T20:41:00.000Z',
      },
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // 核心不变量：extreme fallback 产物必须 ≤28KB，不触发飞书 11310
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // CardKit 2.0 schema 合规
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });
});
