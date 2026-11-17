/**
 * /config 卡片的后台渲染队列：把「刷新所有已交互卡片」移出飞书回调链。
 *
 * 飞书要求卡片回调 3 秒内响应；被点击的那张卡由回调响应体的 `card` 字段原地
 * 替换（零网络写）。其余兄弟卡的 PATCH 与目录预取放在这里，串行 + 合并窗口执行：
 *
 * - 串行：PATCH 全卡替换必须按序到达，否则后到的旧帧覆盖新帧（连点卡死）。
 * - 合并：连点 N 次草稿变更只扇出 1 次，N-1 次网络写被省掉，也避开飞书
 *   单消息更新频限（230429）。最后一次状态赢：渲染时从最新草稿重新 buildConfigCard，
 *   不缓存构建结果。
 * - 不传染：回调链不等这个队列；下一个 config.* 动作只被纯内存的
 *   configActionQueue 串行化，不再 await 后台 tail。
 *
 * 切换 Agent 的持久化通知**不在此队列**：锚定契约要求它在 config.save 回调内
 * 同步发送（成功不回 toast、失败回退 info toast，且卡片刷新失败不得吞掉通知）。
 *
 */
import type { CommandContext } from '../../bridge/index.js';
import type { CommandRouter } from '../index.js';
import { MAX_CONFIG_CARDS, CONFIG_RENDER_DEBOUNCE_MS } from './shared.js';
import { getLogger } from '../../logger/index.js';
import { enforceCardBudget } from '../../card/card-budget.js';

export interface ConfigRenderRequest {
  ctx: CommandContext;
  /** config.save 后需要刷新 DSH / CodeBuddy 动态目录。 */
  refreshCatalogs: boolean;
  /** 被响应体原地替换的卡片，兄弟卡 PATCH 要跳过它。 */
  inlineMessageId?: string;
  /** `/c` 文本命令的 ctx.messageId 是用户消息 id：不登记为 config 卡。 */
  skipRemember?: boolean;
}

/** 渲染队列状态挂在 router 上，避免模块级全局在多实例测试中互相串味。 */
export interface ConfigRenderState {
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: ConfigRenderRequest | undefined;
  tail: Promise<void>;
}

export function createConfigRenderState(): ConfigRenderState {
  return { timer: undefined, pending: undefined, tail: Promise.resolve() };
}

/**
 * 记住一张 config 卡片 messageId（有界：超限丢最早的一张）。
 * 无 messageId 的调用（测试/文本路径）不登记。
 */
export function rememberConfigCard(host: CommandRouter, messageId: string | undefined): void {
  if (!messageId) return;
  host.configCardIds.delete(messageId);
  host.configCardIds.add(messageId);
  while (host.configCardIds.size > MAX_CONFIG_CARDS) {
    const oldest = host.configCardIds.values().next().value as string;
    host.configCardIds.delete(oldest);
  }
}

/**
 * 配置卡的单一预算出口：inline 响应体与兄弟卡 PATCH 必须走同一套口径。
 *
 * 飞书对单卡「带 tag 节点 ≤ 200」（`MAX_CARD_COMPONENTS` 保守到 190）的限制在
 * send 与 patch 两条路径上都成立。只在一处裁剪会让另一条路径被 `11310` 拒绝，
 * 而 `patchCard` 失败会把该卡从 `configCardIds` 永久剔除——多卡同步静默失效，
 * 表面症状是「只有刚点的那张卡有新值」。
 */
export function budgetConfigCard(card: object, where: 'inline' | 'patch'): object {
  const { card: safeCard, wasTruncated, reason, bytesAfter } = enforceCardBudget(card);
  if (wasTruncated) {
    getLogger().info(
      `[router] config card budget applied (${where}): reason=${reason} bytesAfter=${bytesAfter}`,
    );
  }
  return safeCard;
}

/**
 * 把当前草稿刷到所有已知 config 卡片上（仅后台渲染队列调用）。
 *
 * **不在这里登记卡片**：登记是调度时刻的事（scheduleConfigRender 同步完成，
 * `/c` 文本命令通过 skipRemember 排除）。之前把「是否登记」存进合并后的 pending
 * 再传给本函数，合并时字段一丢就会把用户文本消息 id 登记成 config 卡，之后每次
 * config.set 都会把那条聊天消息 PATCH 成配置卡。职责拆开后这类事故不可能再出现。
 *
 * `excludeMessageId` 是刚被响应体替换的那张，跳过避免同消息重复 PATCH 触发
 * 飞书 230429。注意：它同时意味着这张卡不会拿到本轮刷新后的目录（如 DSH 新增
 * provider），下一次点击会补齐——最终一致，不做二次 PATCH。`config.refresh`
 * 是例外：它不回 inline 卡片，让所有卡（含被点击那张）统一走这一条 PATCH 路径。
 */
async function refreshConfigCards(host: CommandRouter, excludeMessageId?: string): Promise<number> {
  const built = host.buildConfigCard().card;
  // 与 inline 响应同一预算口径：超限卡的 PATCH 会被飞书整卡拒绝，
  // 再被 patchCard 的失败分支把这个 messageId 永久剔除。
  const card = built ? budgetConfigCard(built, 'patch') : undefined;
  if (!card) return 0;
  let patches = 0;
  for (const messageId of [...host.configCardIds]) {
    if (messageId === excludeMessageId) continue;
    const ok = await host.bridge.patchCard(messageId, card);
    if (ok) patches += 1;
    else host.configCardIds.delete(messageId);
  }
  return patches;
}

/**
 * 调度一次后台渲染。同步返回，不等待任何网络写。
 * 多次调用在窗口内合并：保留最后一次的 ctx 与 inlineMessageId。
 */
export function scheduleConfigRender(host: CommandRouter, req: ConfigRenderRequest): void {
  const state = host.configRenderState;
  // 登记是**调度时刻**的职责，同步完成：只有被点击的配置卡才进集合，
  // `/c` 文本命令的用户消息 id 通过 skipRemember 排除。
  if (!req.skipRemember) rememberConfigCard(host, req.ctx.messageId);

  // 合并语义：refreshCatalogs 取「或」；ctx / inlineMessageId 取最后一次。
  state.pending = {
    ctx: req.ctx,
    refreshCatalogs: (state.pending?.refreshCatalogs ?? false) || req.refreshCatalogs,
    inlineMessageId: req.inlineMessageId,
  };

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void runConfigRender(host);
  }, CONFIG_RENDER_DEBOUNCE_MS);
  // 计时器不许把进程钉住（/restart、测试退出都靠这个）。
  state.timer.unref?.();
}

/** 测试/关停用：立刻冲刷待渲染项并等待队列排空。 */
export async function flushConfigRender(host: CommandRouter): Promise<void> {
  const state = host.configRenderState;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
    await runConfigRender(host);
  }
  await state.tail;
}

async function runConfigRender(host: CommandRouter): Promise<void> {
  const state = host.configRenderState;
  const req = state.pending;
  if (!req) return;
  state.pending = undefined;

  const task = async (): Promise<void> => {
    try {
      if (req.refreshCatalogs) {
        await host.prefetchConfigCardCatalogs();
      }

      // 最后一次状态赢：从最新草稿重新建卡，不复用任何中间帧。
      // 复用 refreshConfigCards，兄弟卡同步语义单一事实源。
      await refreshConfigCards(host, req.inlineMessageId);
    } catch (err) {
      getLogger().error('[router] config 后台渲染失败:', err);
    }
  };

  state.tail = state.tail.then(task, task);
}
