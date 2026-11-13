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
 * 埋点 `event=render` 的 merged / patches / t_*_ms 可直接验证合并与耗时。
 */
import type { CommandContext } from '../../bridge/index.js';
import type { CommandRouter } from '../index.js';
import { CONFIG_RENDER_DEBOUNCE_MS } from './shared.js';
import { getLogger } from '../../logger/index.js';
import { logConfigPerf, ConfigPerfSpan } from '../../common/config-perf.js';

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
  merged: number;
  tail: Promise<void>;
}

export function createConfigRenderState(): ConfigRenderState {
  return { timer: undefined, pending: undefined, merged: 0, tail: Promise.resolve() };
}

/**
 * 调度一次后台渲染。同步返回，不等待任何网络写。
 * 多次调用在窗口内合并：保留最后一次的 ctx 与 inlineMessageId。
 */
export function scheduleConfigRender(host: CommandRouter, req: ConfigRenderRequest): void {
  const state = host.configRenderState;
  // 登记是**调度时刻**的职责，同步完成：只有被点击的配置卡才进集合，
  // `/c` 文本命令的用户消息 id 通过 skipRemember 排除。
  if (!req.skipRemember) host.rememberConfigCard(req.ctx.messageId);

  if (state.pending) state.merged += 1;
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
  const merged = state.merged;
  state.merged = 0;

  const task = async (): Promise<void> => {
    const span = new ConfigPerfSpan();
    let patches = 0;
    try {
      if (req.refreshCatalogs) {
        await host.prefetchConfigCardCatalogs();
        span.segment('prefetch');
      }

      // 最后一次状态赢：从最新草稿重新建卡，不复用任何中间帧。
      // 复用 refreshConfigCards，兄弟卡同步语义单一事实源。
      const stats = await host.refreshConfigCards(req.inlineMessageId);
      patches = stats.patches;
      span.segment('patch');

      logConfigPerf('render', {
        merged,
        patches,
        t_build_ms: stats.t_build_ms,
        t_patch_ms: stats.t_patch_ms,
        ...span.fields(),
      });
    } catch (err) {
      getLogger().error('[router] config 后台渲染失败:', err);
      logConfigPerf('render', { merged, patches, ok: false, ...span.fields() });
    }
  };

  state.tail = state.tail.then(task, task);
}
