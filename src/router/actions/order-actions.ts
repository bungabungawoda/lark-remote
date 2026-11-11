// /order 与 /ws 列表卡动作族（共用列表卡原位刷新）。
import type { CommandContext } from '../../bridge/index.js';
import type { OrderEntry } from '../../order/index.js';
import { ORDER_NOT_FOUND_TEXT } from '../../order/index.js';
import { ORDER_PAGE_SIZE } from '../commands/order.js';
import { WS_PAGE_SIZE } from '../commands/ws.js';
import type { CommandRouter } from '../index.js';
import type { CardActionPayload, CardActionResponse } from './shared.js';
import { CARD_PAYLOAD_MISSING, payloadOffset, searchQueryFrom } from './shared.js';

/**
 * Resolve an order's text at the enqueue boundary so order.exec can enter
 * the serial queue as an equivalent user message (Plan A) — the same path a
 * hand-typed message takes. index.ts calls this before bridge.enqueue and
 * uses the returned `orderText` as the queue messagePreview / edit
 * default_value, and `internalKey` as the queue dedup key.
 *
 * Why an internal key instead of the Feishu card messageId: one order card
 * can be clicked many times, so the card messageId is 1:N with enqueue
 * actions. Reusing it collides queuedTasks / queueCardMessages lookups.
 * Each call therefore mints a unique key (the Feishu messageId still flows
 * through ctx for replies/reactions — the two concerns are separate).
 *
 * `updateUsedAt` runs here, at resolve time, so the usage timestamp
 * survives even an immediate crash before the queued task ever runs
 * (preserves the H3 crash-safe property previously held by handleOrderExec,
 * which recorded it right before forwardToClaude).
 *
 * Returns null when the order no longer exists; index.ts surfaces the error.
 */
export function resolveOrderExecForQueue(
  host: CommandRouter,
  orderId: string,
): { orderText: string; internalKey: string } | null {
  const order = host.orderStore.get().find((o) => o.id === orderId);
  if (!order) return null;
  host.orderStore.updateUsedAt(order.id);
  return {
    orderText: order.text,
    internalKey: host.mintQueueTaskKey('order', order.id),
  };
}

/**
 * 单源：重建 order/ws 列表卡（不投递，card 进 callback 响应体用）。
 * `q` 只服务 ws 卡的关键词筛选；order 卡无此功能，不透传。
 */
export function rebuildListCard(
  host: CommandRouter,
  kind: 'order' | 'ws',
  offset: number,
  ctx: CommandContext,
  q?: string,
): object | undefined {
  if (kind === 'order') return host.cmdOrder([], ctx, offset).card;
  return host.cmdWs([], ctx, offset, q).card;
}

/**
 * 单源：「重建列表卡 → updateCardInPlace」原地刷新骨架（列表卡删除/
 * 翻页/移除/排序/筛选动作共用）。返回重建后的卡片；无卡时返回 undefined 且跳过更新。
 */
export async function refreshListCard(
  host: CommandRouter,
  kind: 'order' | 'ws',
  value: { offset?: number; q?: string },
  ctx: CommandContext,
): Promise<object | undefined> {
  const card = host.rebuildListCard(kind, payloadOffset(value), ctx, value.q);
  if (!card) return undefined;
  await host.bridge.updateCardInPlace(card, ctx);
  return card;
}

/**
 * 单源：order 三个 input handler（aliasInput/aliasRemove/textInput）
 * 的公共骨架——校验 orderId → reload+find → mutate → 成功后 toast + raw 卡。
 * mutate 返回 error 时仅回 error toast，不重渲染。
 * 注意：本 helper 只服务「toast + card 进响应体」语义（飞书需用响应体原地
 * 替换 pre-click 编辑卡）；updateCardInPlace 原地刷新走 refreshListCard。
 */
export async function mutateOrderAndRefreshCard(
  host: CommandRouter,
  value: { orderId?: string; offset?: number },
  ctx: CommandContext,
  opts: { missingToast: string },
  mutate: (order: OrderEntry) => { ok: true; toast: string } | { ok: false; error: string },
): Promise<CardActionResponse | void> {
  if (!value.orderId) {
    return { toast: { type: 'error', content: CARD_PAYLOAD_MISSING } };
  }
  host.orderStore.reload();
  const order = host.orderStore.get().find((o) => o.id === value.orderId);
  if (!order) {
    return { toast: { type: 'error', content: opts.missingToast } };
  }
  const outcome = mutate(order);
  if (!outcome.ok) {
    return { toast: { type: 'error', content: outcome.error } };
  }
  const result = host.cmdOrder([], ctx, payloadOffset(value));
  return {
    toast: { type: 'success', content: outcome.toast },
    card: { type: 'raw', data: result.card! },
  };
}

/**
 * Handle order.delete: remove the order and update card in place.
 */
export async function handleOrderDelete(
  host: CommandRouter,
  value: { orderId?: string; offset?: number },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const orderId = value.orderId;

  if (!orderId) {
    return { toast: { type: 'error', content: CARD_PAYLOAD_MISSING } };
  }

  if (!host.orderStore.has(orderId)) {
    return { toast: { type: 'error', content: ORDER_NOT_FOUND_TEXT } };
  }

  // Delete the order
  host.orderStore.remove(orderId);

  // Refresh the order list and update card in place, preserving current page
  await host.refreshListCard('order', value, ctx);

  return { toast: { type: 'success', content: '已删除指令' } };
}

/**
 * Handle order.page: paginate the /order list in place.
 * Mirrors handleLsPage — updates the same card, never sends a new one.
 */
export async function handleOrderPage(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const paging = host.pagingOffset(value, ORDER_PAGE_SIZE);
  if ('error' in paging) {
    return { toast: { type: 'error', content: paging.error } };
  }
  // cmdOrder internally clamps stale/out-of-range offsets
  await host.refreshListCard('order', { offset: paging.offset }, ctx);
  return { toast: { type: 'success', content: '' } };
}

/**
 * order 编辑卡公共骨架：payload 校验 → 查指令 → 构造 input 编辑卡 → 原地更新。
 * handleOrderAliasEdit / handleOrderTextEdit 原先各持一份 ~90% 相同的 4 段结构。
 */
export async function showOrderEditCard(
  host: CommandRouter,
  value: { orderId?: string; offset?: number },
  ctx: CommandContext,
  opts: {
    title: string;
    hint: string;
    inputName: string;
    placeholder: string;
    defaultValue: string;
    inputCmd: 'order.aliasInput' | 'order.textInput';
    maxLength?: number;
  },
): Promise<CardActionResponse | void> {
  const orderId = value.orderId;
  const offset = payloadOffset(value);
  if (!orderId) {
    return { toast: { type: 'error', content: CARD_PAYLOAD_MISSING } };
  }
  host.orderStore.reload();
  const order = host.orderStore.get().find((o) => o.id === orderId);
  if (!order) {
    return { toast: { type: 'error', content: ORDER_NOT_FOUND_TEXT } };
  }
  // 列表卡显示的是截断版（≤100 字符 + ...），编辑卡预览保持一致
  const displayText = order.text.length > 100 ? order.text.slice(0, 97) + '...' : order.text;
  // CardKit 2.0 input 提交（回车/完成键；input_value 经 raw 回传，红线）。
  // 不用 form 容器（触发 300123 无 submit button / 200621 嵌套 column）。
  const editCard = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: opts.title },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前指令:**\n\`${displayText}\`` },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: opts.hint },
        },
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 3,
              elements: [
                {
                  tag: 'input',
                  name: opts.inputName,
                  placeholder: { tag: 'plain_text', content: opts.placeholder },
                  default_value: opts.defaultValue,
                  ...(opts.maxLength !== undefined ? { max_length: opts.maxLength } : {}),
                  behaviors: [
                    {
                      type: 'callback',
                      value: { cmd: opts.inputCmd, orderId, offset },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  await host.bridge.updateCardInPlace(editCard, ctx);
}

export function findOrderForEdit(host: CommandRouter, orderId?: string) {
  host.orderStore.reload();
  return host.orderStore.get().find((o) => o.id === orderId);
}

export async function handleOrderAliasEdit(
  host: CommandRouter,
  value: { orderId?: string; offset?: number },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const order = host.findOrderForEdit(value.orderId);
  return host.showOrderEditCard(value, ctx, {
    title: '✏️ 给指令起别名',
    hint: '💡 输入别名名后按回车提交；删除别名请点列表卡别名旁的 ✕',
    inputName: 'aliasName',
    placeholder: '输入 $别名名（如 all）...',
    defaultValue: order?.alias ?? '',
    inputCmd: 'order.aliasInput',
  });
}

/**
 * Handle order.aliasInput: 提交别名（绑/改/解绑），随后重渲染 /order 列表卡。
 * 留空 = 解绑；非空按命名规则 + 全局唯一校验，失败仅 toast 不重渲染。
 */
export async function handleOrderAliasInput(
  host: CommandRouter,
  value: {
    orderId?: string;
    offset?: number;
    inputValue?: string;
    formValue?: Record<string, unknown>;
  },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const name = value.inputValue ?? (value.formValue?.['aliasName'] as string | undefined);
  return host.mutateOrderAndRefreshCard(
    value,
    ctx,
    { missingToast: ORDER_NOT_FOUND_TEXT },
    (order) => {
      const trimmed = name?.trim() ?? '';
      // 变更前快照旧别名：setAlias 会原地变异 order 对象（delete entry.alias），
      // 删除后 order.alias 已为 undefined，直接用会让成功文案显示 `$undefined`。
      const prevAlias = order.alias;
      try {
        host.orderStore.setAlias(order.id, trimmed === '' ? undefined : trimmed);
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
      return {
        ok: true as const,
        toast: trimmed === '' ? `✅ 已移除别名 $${prevAlias ?? ''}` : `✅ 已绑定别名 $${trimmed}`,
      };
    },
  );
}

export async function handleOrderAliasRemove(
  host: CommandRouter,
  value: { orderId?: string; offset?: number },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  return host.mutateOrderAndRefreshCard(
    value,
    ctx,
    { missingToast: '指令不存在或没有别名' },
    (order) => {
      if (!order.alias) {
        return { ok: false as const, error: '指令不存在或没有别名' };
      }
      // 变更前快照旧别名：setAlias(undefined) 会原地变异 order（delete alias），
      // 删除后 order.alias 已为 undefined，直接拼会让成功文案显示 `$undefined`。
      const removedAlias = order.alias;
      host.orderStore.setAlias(order.id, undefined);
      return { ok: true as const, toast: `✅ 已移除别名 $${removedAlias}` };
    },
  );
}

/**
 * Handle order.textEdit: 展示指令文本编辑卡（input，回车/完成键提交）。
 * 预填当前 text（完整内容，不截断——input 组件有自有滚动条）；
 * 提交 `order.textInput` 处理（trim + 长度校验 + OrderStore.updateText）。
 * 完全镜像 handleOrderAliasEdit 的 4 段结构（reload → find → 构造 editCard →
 * updateCardInPlace）。
 */
export async function handleOrderTextEdit(
  host: CommandRouter,
  value: { orderId?: string; offset?: number },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const order = host.findOrderForEdit(value.orderId);
  // input 组件 default_value 预填完整 text（不受截断影响），提交后生效完整文本
  return host.showOrderEditCard(value, ctx, {
    title: '✏️ 编辑指令',
    hint: '💡 修改后按回车提交；空白提交 = 报错；最多 200 字符',
    inputName: 'text',
    placeholder: '输入新的指令文本...',
    defaultValue: order?.text ?? '',
    inputCmd: 'order.textInput',
    // 与 MAX_TEXT_LENGTH=200 对齐：超长在输入侧直接截断，避免提交后才报错
    // （后端 updateText 仍会二次校验，双保险）
    maxLength: 200,
  });
}

/**
 * Handle order.textInput: 提交指令文本编辑。校验 orderId → OrderStore.updateText
 * （store 内部统一 trim + 空/超长校验）。成功 toast + 原地重渲染列表卡（同
 * handleOrderAliasInput 语义：toast-only 响应会让飞书停留在 pre-click 编辑卡，
 * 必须把 card 放进 callback 响应体）；失败仅 error toast。
 * 保留 usedAt / alias / createdAt（OrderStore.updateText 只动 text 字段）。
 */
export async function handleOrderTextInput(
  host: CommandRouter,
  value: {
    orderId?: string;
    offset?: number;
    inputValue?: string;
    formValue?: Record<string, unknown>;
  },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const raw = value.inputValue ?? (value.formValue?.['text'] as string | undefined);
  return host.mutateOrderAndRefreshCard(
    value,
    ctx,
    { missingToast: ORDER_NOT_FOUND_TEXT },
    (order) => {
      let updated: OrderEntry | undefined;
      try {
        updated = host.orderStore.updateText(order.id, raw ?? '');
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
      if (!updated) {
        // reload + find 后 updateText 不应返回 undefined；防御性兜底（如并发删除）。
        return { ok: false as const, error: ORDER_NOT_FOUND_TEXT };
      }
      const preview = updated.text.length > 50 ? updated.text.slice(0, 50) + '...' : updated.text;
      return { ok: true as const, toast: `✅ 已更新指令: ${preview}` };
    },
  );
}

export function resolveOrderTarget(host: CommandRouter, target: string): OrderEntry | undefined {
  const all = host.orderStore.get();
  const byId = all.find((o) => o.id === target);
  if (byId) return byId;
  const n = Number(target);
  if (Number.isInteger(n) && n >= 1 && n <= all.length) return all[n - 1];
  return undefined;
}

/**
 * Handle ws.use card action: switch to the cwd, then refresh the /ws
 * list card in place so "recent" sort order is immediately visible.
 *
 * Unlike the command-line `/ws use` (which returns text), the card action
 * uses toast + inplace refresh for a cleaner UX (matching ws.remove/ws.sort).
 * If auto-resume produces a card, it is sent as a separate reply.
 */
export async function handleWsUse(
  host: CommandRouter,
  value: { name?: string; offset?: number; q?: string },
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const name = value.name ?? '';
  const useResult = host.cmdWs(['use', name], ctx);

  // Error cases (cwd not found, path invalid, etc.): relay as error toast
  if (useResult.text && !useResult.text.includes('已切换')) {
    return { toast: { type: 'error', content: useResult.text } };
  }

  // Success: send auto-resume card, or a persistent text confirmation when
  // there is no history session. Toast alone is insufficient: for this
  // immediate action the callback response is swallowed by enqueueImmediate
  // (fire-and-forget), and even if delivered it is transient — the user gets
  // no perceivable feedback on the switch. Same rationale as config.save
  // agent-switch notice: persistent message first, toast only as a
  // fallback if sendResult fails.
  let fallbackToast: string | undefined;
  if (useResult.card || useResult.text) {
    const sent = await host.bridge.sendResult(useResult, ctx);
    if (!sent && useResult.text) {
      fallbackToast = useResult.text;
    }
  }

  // Refresh the /ws list card in place so "recent" sort is immediately visible
  await host.refreshListCard('ws', value, ctx);

  // Toast feedback (suppress text when a persistent message was already sent).
  // 兜底文案必须用 warning 型：ws.use 不在 DIRECT_RETURN_CMDS，toast 经
  // enqueueImmediate fire-and-forget，而 forwardActionFeedback 只转发
  // error/warning 型——success 型兜底会被双重吞掉，点击毫无反馈。
  return {
    toast: fallbackToast
      ? { type: 'warning', content: fallbackToast }
      : { type: 'success', content: '' },
  };
}

/**
 * Handle ws.remove: remove the cwd alias and refresh the /ws list card
 * in place (mirrors handleOrderDelete). Without this the stale alias would
 * remain visible on the card the user just clicked.
 */
export async function handleWsRemove(
  host: CommandRouter,
  value: { name?: string; offset?: number; q?: string },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const name = value.name;
  if (!name) {
    return { toast: { type: 'error', content: CARD_PAYLOAD_MISSING } };
  }

  // Execute the removal and let its result decide the toast: the card can be
  // a stale list (alias already deleted elsewhere), and an unconditional
  // "已删除" would then contradict what the refreshed card shows.
  const result = host.cmdWs(['remove', name], ctx);
  const text = result.text ?? `删除 workspace "${name}" 失败`;

  // Rebuild the /ws list card and update it in place, preserving the page
  // the user was on when they clicked 删除.
  await host.refreshListCard('ws', value, ctx);

  return { toast: { type: text.startsWith('已删除') ? 'success' : 'error', content: text } };
}

/**
 * Handle ws.page: paginate the /ws list in place.
 * Mirrors handleOrderPage — updates the same card, never sends a new one.
 */
export async function handleWsPage(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const paging = host.pagingOffset(value, WS_PAGE_SIZE);
  if ('error' in paging) {
    return { toast: { type: 'error', content: paging.error } };
  }
  // cmdWs internally clamps stale/out-of-range offsets
  await host.refreshListCard('ws', { offset: paging.offset, q: value.q }, ctx);
  return { toast: { type: 'success', content: '' } };
}

/**
 * Handle ws.filter: 按搜索框提交的关键词重新渲染列表卡。
 * offset 恒重置为 0（新筛选从第 1 页开始）；提交空串 = 清除筛选。
 */
export async function handleWsFilter(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const q = searchQueryFrom(value);
  await host.refreshListCard('ws', { offset: 0, q }, ctx);
  return { toast: { type: 'success', content: q ? `筛选："${q}"` : '已清除筛选' } };
}

/**
 * Handle ws.sort: toggle sort preference and refresh the /ws list card.
 * Sort preference is memory-only (not persisted); restart resets to 'recent'.
 */
export async function handleWsSort(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const userId = ctx.userId;
  const current = host.wsSortPreference.get(userId) ?? 'recent';
  const next = current === 'recent' ? 'alpha' : 'recent';
  host.wsSortPreference.set(userId, next);
  await host.refreshListCard('ws', { offset: 0, q: value.q }, ctx);
  const nextLabel = next === 'recent' ? '🕐 最近使用' : '🔤 字母顺序';
  return {
    toast: { type: 'success', content: `已切换为 ${nextLabel}` },
  };
}
