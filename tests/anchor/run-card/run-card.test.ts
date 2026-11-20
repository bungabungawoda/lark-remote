/**
 * Anchor tests for RunCardSession + renderRunCard budget behavior: CJK-aware
 * estimates, degradation on large state, extreme-fallback budget invariant,
 * push coalescing, and skip-budget on start/settle.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RunCardSession } from '../../../src/card/run-card-session.js';
import { makeStreamCardConnector } from '../../../tests/lib/card-stubs.js';

/**
 * 单源：本文件原先 5 份 streamCard/updateCard 字面量收敛为共享工厂
 * （tests/lib/card-stubs）的组合封装。capture 走 controllerUpdate 回调，
 * updateCard 捕获与 producer 后 throw 走工厂参数。
 */
function makeRunCardConnector(
  opts: {
    messageId?: string;
    capture?: { updates: object[] };
    updateCapture?: Array<{ messageId: string; card: object }>;
    throwAfterProducer?: boolean;
  } = {},
) {
  return makeStreamCardConnector({
    messageId: opts.messageId,
    controllerUpdate: opts.capture
      ? (card) => {
          opts.capture.updates.push(
            typeof card === 'function' ? (card as (cur: object) => object)({}) : card,
          );
        }
      : undefined,
    updateCard: opts.updateCapture
      ? async (messageId: string, card: object) => {
          opts.updateCapture.push({ messageId, card });
        }
      : undefined,
    streamCardThrowsAfterProducer: opts.throwAfterProducer
      ? new Error('complete failed')
      : undefined,
  });
}
import * as cardBudget from '../../../src/card/card-budget.js';
import { renderRunCard } from '../../../src/card/run-renderer.js';
import type { RunState } from '../../../src/card/run-state.js';
import { expectNoV1ActionContainer } from '../../lib/card-view.js';

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
 * CPU -20~33% 浪费，且与
 * card-budget.ts:3-8 文件头注释"不适用于 run-renderer 的流式卡片"矛盾。
 *
 * src/card/card-budget.ts:3-8 注释。
 */
describe('RunCardSession budget skip', () => {
  it('test_anchor_run_card_skips_enforce_card_budget', async () => {
    // Spy 追踪 enforceCardBudget 导出函数的调用（合规：不替换内部实现）
    const spy = vi.spyOn(cardBudget, 'enforceCardBudget');

    const capture = { updates: [] as object[] };
    const { connector } = makeRunCardConnector({ capture });

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
 * ANCHOR — RunCardSession start()/settle() 也跳过 enforceCardBudget。
 *
 * 意图（必须完整保留）：
 * ① 补齐测试覆盖对称性：run-card-skip-budget 已验证 updateCard（push）
 *    路径跳过 enforceCardBudget，但 start() producer 初始卡和 settle() fallback
 *    路径无对应 anchor。CardSession.safeRenderCard 不再调用静态裁剪层，
 *    三条路径应一并验证。
 * ② 缺失后果：若有人把 enforceCardBudget 重新塞回 safeRenderCard，run 卡会
 *    经冗余的静态裁剪层（对 run 卡是 misfit），浪费 CPU 且可能误裁剪
 *    thinking/tool panels。
 *
 * renderRunCard 3 层 degraded/extreme
 * fallback 自带预算保护。
 */
describe('RunCardSession start/settle budget skip (anchor)', () => {
  it('test_anchor_run_card_start_skips_enforce_budget', async () => {
    const spy = vi.spyOn(cardBudget, 'enforceCardBudget');

    const { connector } = makeRunCardConnector();

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

    const updated: Array<{ messageId: string; card: object }> = [];
    const { connector } = makeRunCardConnector({ throwAfterProducer: true });
    let updateCalls = 0;
    connector.updateCard = async (messageId: string, card: object) => {
      updateCalls += 1;
      // 第一次 = finish() 的终态帧确认（throttle 通道不保证落地）。故意让它
      // 失败，逼 settle 真走兜底 patch —— 否则本用例守护的「兜底路径跳过
      // enforceCardBudget」就没有执行路径了。
      if (updateCalls === 1) throw new Error('confirm failed');
      updated.push({ messageId, card });
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

  it('test_anchor_run_card_settle_skips_duplicate_patch_when_terminal_frame_confirmed', async () => {
    const updated: Array<{ messageId: string; card: object }> = [];
    const { connector } = makeRunCardConnector({
      updateCapture: updated,
      throwAfterProducer: true,
    });

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-settle-2',
    });

    await session.start();
    await session.finish('interrupted', { interruptedReason: 'user_stop' });

    // finish 已经整卡 patch 过一次（终态帧确认）。
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0]?.card)).not.toContain('⏹ 停止');

    // 流异常结束时 settle 不再重复发同一张终态卡（幂等但纯浪费），
    // 返回值仍是 'streamed'——bridge 只对 'unsent' 补发 fallback 卡。
    expect(await session.settle()).toBe('streamed');
    expect(updated).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RunCardSession push coalescing
// ---------------------------------------------------------------------------

/**
 * ANCHOR (push 合批核心契约) — RunCardSession.push 当前每事件一次
 * render + controller.update（run-card-session.ts:54-57）。text 流式 50 事件/秒
 * = 50 次 render+patch/秒，是流式 CPU 主要来源。
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
 * 「更短路径：在 push 加 50–100ms coalescer：
 * 一个 tick/microtask 内多个事件只触发一次 renderCard + controller.update」。
 * 约束：finish() 必须立即 flush；最后 push 后残留窗口必须 flush。
 */
describe('RunCardSession push coalescing', () => {
  let updates: object[];

  beforeEach(() => {
    vi.useFakeTimers();
    updates = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_anchor_push_coalesces_multiple_text_deltas_into_fewer_updates', async () => {
    const { connector } = makeRunCardConnector({ messageId: 'card-coal', capture: { updates } });
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
   * ANCHOR (in-flight flush 期间到达的事件必须重新调度) — scheduleFlush
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
    const { connector } = makeRunCardConnector({
      messageId: 'card-inflight',
      capture: { updates },
    });

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
// renderRunCard budget behavior (CJK)
// ---------------------------------------------------------------------------

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

describe('renderRunCard budget behavior', () => {
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

    const json = JSON.stringify(renderRunCard(state));
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);

    // 全量渲染：thinking1/3 都保留（若被误降级，早期 thinking 会被省略）
    expect(json).toContain('HEAD-THINK-1-');
    expect(json).toContain('HEAD-THINK-3-');
    expect(json).toContain('戊'.repeat(900));
    // 无 omission hint → 未走降级路径
    expect(json).not.toMatch(/已省略/);

    expectNoV1ActionContainer(json);
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

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);
    expectNoV1ActionContainer(json);
  });
});

// ---------------------------------------------------------------------------
// renderRunCard budget — large state degrades correctly
// ---------------------------------------------------------------------------

/**
 * ANCHOR (预算上界 + 保守性) — renderRunCard 对明显超 28KB 的大 RunState
 * 必须走降级路径，保证产物 ≤28KB 且含 omission hint。
 *
 * 意图（必须完整保留）：
 * renderRunCard 构建完整卡后检查 28KB / 元素 / 组件预算，超限走 degraded。
 * 本 anchor 断言**降级行为正确**：
 *
 * ① 卡片产物 ≤28KB（不触发飞书 11310 单卡 5 table / 28KB 上限错误）—— 正确性底线
 * ② 走了 degraded 路径：含合并后的 omission hint（`已省略 7 个早期步骤`，
 *    5 个早期思考 + 2 个早期工具），且不含早期 thinking（`思考1`）—— 证明超预算被识别并降级
 *
 * 缺失会导致什么：
 * - 若估算逻辑误判"不超预算"走正常路径，完整卡 ~100KB+ 会超 28KB → 飞书 11310
 *   报错整卡不可用，用户看到空/错卡。
 * - 若绿用 `return True` 或硬编码跳过降级作弊，联合断言（≤28KB + 含 omission
 *   hint + 不含早期 thinking）会露馅：要么超 28KB，要么缺 omission hint。
 *
 * 依据：飞书单卡预算约束。
 *
 * 构造：7 个大 thinking（每个 ~2.5KB）+ 5 个大 tool output（每个 ~3.5KB）
 * + 大文本（~8KB），完整卡远超 28KB，参照 run-renderer.test.ts 的
 * `degrades thinking: keeps last 2` fixture 构造方式。
 */
describe('renderRunCard budget', () => {
  it('test_anchor_run_card_budget_degrades_large_state', () => {
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

    // ② 走了 degraded 路径：所有省略来源合并成一条「早期步骤」提示
    // （5 个早期思考 + 2 个早期工具 = 7），不再按类型分行。
    expect(json).toContain('已省略 7 个早期步骤');
    expect(json).not.toMatch(/早期思考|个工具调用|计划\/文件变更/);

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
    expectNoV1ActionContainer(json);
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
 * 任何输入下产物 ≤28KB。飞书卡片表格限制（ErrCode 11310）+spec
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
    expectNoV1ActionContainer(json);
  });
});
