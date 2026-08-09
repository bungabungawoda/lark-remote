/**
 * Merged anchor tests for BashCardSession + renderBashCard
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - bash-card-budget.test.ts
 *   - bash-card-render-budget.test.ts
 *   - bash-card-settle-budget.test.ts
 *
 * Note: bash-runner-event-driven.test.ts is NOT merged here because it uses
 * vi.hoisted + top-level import (incompatible mock pattern with these files).
 */
import { describe, expect, it, vi } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { BashCardSession } from '../../../src/card/bash-card-session.js';
import * as cardBudget from '../../../src/card/card-budget.js';
import { renderBashCard, type BashState } from '../../../src/card/bash-renderer.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeController(capture: { updates: object[] }): CardStreamController {
  return {
    messageId: 'card-1',
    current: {},
    update: async (card) => {
      capture.updates.push(typeof card === 'function' ? card({}) : card);
    },
  };
}

function makeConnector(controller: CardStreamController, options?: { throwOnComplete?: boolean }) {
  return {
    streamCard: async (
      _chatId: string,
      _initial: object,
      producer: (ctrl: CardStreamController) => Promise<void>,
    ) => {
      await producer(controller);
      if (options?.throwOnComplete) {
        throw new Error('complete failed');
      }
      return 'card-1';
    },
    updateCard: async (_messageId?: string, _card?: object) => {
      if (options?.throwOnComplete) {
        // Store updates for settle fallback verification
      }
    },
  };
}

// ---------------------------------------------------------------------------
// T1: BashCardSession explicit budget protection contract
// ---------------------------------------------------------------------------

/**
 * ANCHOR (T1) — explicit contract declaration for BashCardSession budget safety.
 *
 * 意图（必须完整保留）：
 * ① 验证 BashCardSession 显式覆写 hasOwnBudgetProtection（即在
 *    BashCardSession.prototype 上有 own property，而非从基类 CardSession
 *    继承默认值）。用 Object.getOwnPropertyDescriptor 反射访问已存在的
 *    类方法，合规（不 mock 内部实现、不替换实现）。
 * ② 契约翻转：现在 hasOwnBudgetProtection 返回 true 语义——renderBashCard
 *    自带 stringify 级 degraded/extreme fallback 预算保护（与 renderRunCard
 *    对称），保证返回卡 ≤28KB 且保留 command/exitCode。enforceCardBudget 是
 *    静态卡片（会话事件面板专用）的裁剪层，对 bash 卡的普通 markdownDiv
 *    output 是 misfit（不匹配 emoji panel → 极端降级丢全部信息），因此 bash
 *    卡应跳过它，靠自身 renderer 保护。
 * ③ 缺失后果：若有人误删 BashCardSession 的 hasOwnBudgetProtection 覆写或改回
 *    false，bash 卡将重新依赖 misfit 的 enforceCardBudget，超限时丢 command/
 *    exitCode 信息。若有人误删 renderBashCard 的 stringify 级保护而 hasOwnBudgetProtection
 *    仍 true，bash 卡将裸发 >28KB 卡触发飞书 400/11310。
 */
describe('BashCardSession explicit budget protection contract (anchor)', () => {
  it('test_anchor_bash_card_explicitly_declares_own_budget_protection', async () => {
    // 契约 1：BashCardSession 必须显式覆写 hasOwnBudgetProtection
    // （own property on prototype，非继承基类默认值）
    const desc = Object.getOwnPropertyDescriptor(
      BashCardSession.prototype,
      'hasOwnBudgetProtection',
    );
    expect(desc).toBeDefined();
    expect(typeof desc?.value).toBe('function');

    // 契约 2（翻转后 GREEN）：hasOwnBudgetProtection=true 语义——
    // renderBashCard 自带 stringify 级保护，enforceCardBudget 不被调用
    // （bash 卡跳过静态裁剪层，靠自身 degraded/extreme fallback）。
    const spy = vi.spyOn(cardBudget, 'enforceCardBudget');
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'bash-a1',
      command: 'echo hi',
    });

    await session.start();
    await session.update({ output: 'hi\n' });
    await session.finish('done', { exitCode: 0 });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// T1: BashCardSession settle/start budget protection symmetry
// ---------------------------------------------------------------------------

/**
 * ANCHOR (T1) — settle()/start() budget protection symmetry.
 *
 * 意图（必须完整保留）：
 * ① 验证 CardSession 的三条发出路径——start() producer 初始卡、updateCard()
 *    流式更新、settle() fallback——对 hasOwnBudgetProtection()=true 的子类
 *    （BashCardSession）统一跳过 enforceCardBudget，靠自身 renderer 的
 *    stringify 级保护。消除三条路径的不对称。
 * ② 契约翻转：BashCardSession 现在 hasOwnBudgetProtection=true（renderBashCard
 *    自带 degraded/extreme fallback），因此 start/settle/updateCard 三路径都
 *    不再调 enforceCardBudget。enforceCardBudget 是会话事件面板专用的静态
 *    裁剪层，对 bash 卡的普通 markdownDiv output 是 misfit（超限时极端降级
 *    丢 command/exitCode），bash 卡应完全靠自身 renderer 保护。
 * ③ 守护：settle fallback 仍须产出卡片（result==='updated'），不能因跳过
 *    enforceCardBudget 而静默失败。
 *
 * 依据：§P1-1 + renderBashCard stringify 级保护修复。
 */
describe('BashCardSession settle/start budget protection symmetry (anchor)', () => {
  it('test_anchor_bash_card_settle_fallback_skips_enforce_budget', async () => {
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

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'bash-anchor-1',
      command: 'echo hi',
    });

    await session.start();
    await session.finish('done', { exitCode: 0, output: 'some output' });

    // finish() 内部调 this.updateCard()（基类方法）。重置 spy 以隔离 settle
    // fallback 阶段，精确验证 settle 是否独立跳过 enforceCardBudget。
    spy.mockClear();

    const result = await session.settle();

    // 守护：确认走了 settle fallback（而非 streamed），仍产出卡片
    expect(result).toBe('updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.messageId).toBe('card-1');

    // 核心断言（翻转后 GREEN）：settle fallback 阶段跳过 enforceCardBudget
    // （bash 卡靠自身 renderBashCard 的 stringify 级保护）。
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('test_anchor_bash_card_start_producer_skips_enforce_budget', async () => {
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

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'bash-anchor-2',
      command: 'echo hi',
    });

    // start() 触发 producer 内 controller.update 初始卡。
    await session.start();

    // 核心断言（翻转后 GREEN）：start producer 初始 controller.update 跳过
    // enforceCardBudget（bash 卡靠自身 renderBashCard 的 stringify 级保护）。
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Core quality: renderBashCard stringify-level budget protection
// ---------------------------------------------------------------------------

/**
 * ANCHOR (核心质量) — bash 卡高转义 output 超限时必须自带 stringify 级预算保护。
 *
 * 意图（必须完整保留）：
 * 真实 bash 输出常含大量需 JSON 转义的字符（引号/反斜杠/换行/制表符，如
 * JSON/代码/路径输出）。renderBashCard 的字段级 truncateUtf8 按**字符**把
 * output/stderr 各截到 OUTPUT_MAX_BYTES=12_000，但 JSON.stringify 转义膨胀
 * 后单个字段就 ~22KB，output+stderr 合可达 ~52KB > 28KB。原实现依赖
 * enforceCardBudget（card-budget.ts）兜底，但该裁剪启发式是**会话事件面板专用**
 * （按 🤖👤💭🔧 emoji 识别 collapsible_panel），bash 卡的 output 在普通
 * markdownDiv（非 panel），不匹配 → 阶段1/2 全 no-op → 走阶段3 极端降级，
 * 产出 ~304 字节通用卡「⚠️ 内容已截断」，**丢失 command、output、exitCode
 * 全部信息**。
 *
 * 修复契约：renderBashCard 自带 stringify 级 degraded/extreme fallback（与
 * renderRunCard 对称），保证：
 * ① 所有返回路径 `Buffer.byteLength(JSON.stringify(card),'utf8') <= 28_000`
 * ② 超限降级仍保留 command 文本（status row 内 `⏱ <command>`）
 * ③ 终态时保留 exitCode 文本（`退出码: <code>` 或 `已手动终止`/`已完成`）
 *
 * RED 主目标：高转义 output+stderr 同时超限时，renderBashCard 返回卡 >28KB。
 */
describe('BashCard renderBashCard stringify-level budget protection (anchor)', () => {
  it('test_anchor_bash_card_high_escape_output_within_budget_keeps_info', () => {
    // 高转义字符：引号 + 反斜杠 + 换行 + 制表符 + 回车，stringify 时大幅膨胀
    // （每个 " → \"，\\ → \\\\，\n → \\n，\t → \\t，\r → \\r）
    // output + stderr 各 140000 字符，截断后各 ~22KB JSON，合计 ~52KB > 28KB
    const heavyEscape = `'"\\\n\t\r`.repeat(20_000);
    const state: BashState = {
      runId: 'bash-budget-1',
      terminal: 'done',
      output: heavyEscape,
      stderr: heavyEscape,
      exitCode: 0,
      command: 'echo big',
    };

    const card = renderBashCard(state, {});
    const size = Buffer.byteLength(JSON.stringify(card), 'utf8');

    // 契约 ①：总卡 ≤ 28KB（renderBashCard 自带保护，不依赖外部 enforceCardBudget）
    expect(size).toBeLessThanOrEqual(28_000);

    // 契约 ②：保留 command 文本
    const json = JSON.stringify(card);
    expect(json).toContain('echo big');

    // 契约 ③：终态保留 exitCode 文本
    expect(json).toContain('退出码');
    expect(json).toContain('0');
  });

  it('test_anchor_bash_card_high_escape_only_stderr_within_budget_keeps_info', () => {
    // 只有 stderr 巨大时，output 为空，单字段 ~22KB < 28KB 应正常渲染不降级
    // 但仍验证不超限且保留关键信息
    const heavyEscape = `'"\\\n\t\r`.repeat(20_000);
    const state: BashState = {
      runId: 'bash-budget-2',
      terminal: 'error',
      output: '',
      stderr: heavyEscape,
      exitCode: 1,
      command: 'bad-cmd',
    };

    const card = renderBashCard(state, {});
    const size = Buffer.byteLength(JSON.stringify(card), 'utf8');

    expect(size).toBeLessThanOrEqual(28_000);
    const json = JSON.stringify(card);
    expect(json).toContain('bad-cmd');
    expect(json).toContain('退出码');
    expect(json).toContain('1');
  });

  it('test_anchor_bash_card_running_state_stays_within_budget', () => {
    // running 状态无 exitCode footer，但 output+stderr 仍可能很大
    const heavyEscape = `'"\\\n\t\r`.repeat(20_000);
    const state: BashState = {
      runId: 'bash-budget-3',
      terminal: 'running',
      output: heavyEscape,
      stderr: heavyEscape,
      exitCode: null,
      command: 'long-running-cmd',
    };

    const card = renderBashCard(state, {});
    const size = Buffer.byteLength(JSON.stringify(card), 'utf8');

    expect(size).toBeLessThanOrEqual(28_000);
    const json = JSON.stringify(card);
    expect(json).toContain('long-running-cmd');
  });

  it('test_anchor_bash_card_normal_output_unaffected', () => {
    // 回归守护：普通小输出不受降级影响，正常渲染
    const state: BashState = {
      runId: 'bash-normal',
      terminal: 'done',
      output: 'hello world\n',
      stderr: '',
      exitCode: 0,
      command: 'echo hello',
    };

    const card = renderBashCard(state, {});
    const size = Buffer.byteLength(JSON.stringify(card), 'utf8');
    expect(size).toBeLessThanOrEqual(28_000);

    const json = JSON.stringify(card);
    expect(json).toContain('hello world');
    expect(json).toContain('echo hello');
    expect(json).toContain('退出码');
  });
});
