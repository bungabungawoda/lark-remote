import type { CommandContext, CommandResult } from '../../bridge/index.js';
import type { OrderEntry } from '../../order/index.js';
import { cardButton } from '../../card/card-shared.js';
import { paginationBar } from '../../card/card-helpers.js';
import { pageSlice } from '../paging.js';

export const ORDER_PAGE_SIZE = 8;

export interface OrderCommandDeps {
  reload(): void;
  list(): OrderEntry[];
  save(text: string): void;
  updateText(id: string, text: string): void;
  setAlias(id: string, alias: string | undefined): void;
  resolveTarget(target: string): OrderEntry | undefined;
}

const ORDER_USAGE_TEXT =
  '用法: /order [list|save <text>|edit <orderId|序号> <新文本>|alias add <orderId|序号> <别名名>|alias rm <orderId|序号>]';
const ORDER_ALIAS_USAGE_TEXT =
  '用法: /order alias [add <orderId|序号> <别名名> | rm <orderId|序号> | list]';

// ── 模块级命名原语（crapper 把函数内部闭包/三元的决策点也算进外层）──────────

/** 单行指令的 3 个元素（div + column_set + 行间 hr）。 */
function orderRowElements(order: OrderEntry, safeOffset: number, isLast: boolean): object[] {
  const displayText = order.text.length > 100 ? order.text.slice(0, 97) + '...' : order.text;
  const leftColumn: object[] = order.alias
    ? [
        cardButton(
          `$${order.alias}`,
          { cmd: 'order.aliasEdit', orderId: order.id, offset: safeOffset },
          { type: 'default', size: 'small' },
        ),
        cardButton(
          '✕',
          {
            cmd: 'order.aliasRemove',
            orderId: order.id,
            aliasName: order.alias,
            offset: safeOffset,
          },
          { type: 'default', size: 'small' },
        ),
      ]
    : [
        cardButton(
          '＋别名',
          { cmd: 'order.aliasEdit', orderId: order.id, offset: safeOffset },
          { type: 'default', size: 'small' },
        ),
      ];

  const row: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: order.alias ? `\`$${order.alias}\` ${displayText}` : displayText,
      },
    },
    {
      tag: 'column_set',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: leftColumn },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'column_set',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    cardButton(
                      '▶ 执行',
                      { cmd: 'order.exec', orderId: order.id },
                      { type: 'primary', size: 'small' },
                    ),
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    cardButton(
                      '编辑',
                      { cmd: 'order.textEdit', orderId: order.id, offset: safeOffset },
                      { type: 'default', size: 'small' },
                    ),
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    cardButton(
                      '删除',
                      { cmd: 'order.delete', orderId: order.id, offset: safeOffset },
                      { type: 'danger', size: 'small' },
                    ),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  if (!isLast) row.push({ tag: 'hr' });
  return row;
}

function orderPagination(
  totalCount: number,
  totalPages: number,
  safeOffset: number,
  currentPage: number,
): object[] {
  return [
    { tag: 'hr' },
    ...paginationBar({
      cmd: 'order.page',
      offset: safeOffset,
      pageSize: ORDER_PAGE_SIZE,
      total: totalCount,
      label: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 条）`,
    }),
  ];
}

// ── 子命令 handler（模块顶层命名函数，显式传参）────────────────────────────

type OrderSubHandler = (
  args: string[],
  ctx: CommandContext,
  offset: number,
  deps: OrderCommandDeps,
) => CommandResult;

function orderList(
  _args: string[],
  _ctx: CommandContext,
  offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  deps.reload();
  const allOrders = deps.list();
  const elements: object[] = [];
  if (allOrders.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '暂无指令' } });
  } else {
    const {
      totalCount,
      totalPages,
      safeOffset,
      currentPage,
      pageItems: pageOrders,
      hasPagination,
    } = pageSlice(allOrders, offset, ORDER_PAGE_SIZE);

    for (let i = 0; i < pageOrders.length; i++) {
      elements.push(...orderRowElements(pageOrders[i], safeOffset, i === pageOrders.length - 1));
    }

    if (hasPagination) {
      elements.push(...orderPagination(totalCount, totalPages, safeOffset, currentPage));
    }
  }

  return {
    card: {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: '📋 指令' }, template: 'turquoise' },
      body: { elements },
    },
  };
}

function orderAliasAdd(
  args: string[],
  _ctx: CommandContext,
  _offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const target = args[2];
  const name = args[3];
  if (!target || !name) {
    return { text: '用法: /order alias add <orderId|序号> <别名名>' };
  }
  const order = deps.resolveTarget(target);
  if (!order) return { text: `指令不存在: ${target}` };
  try {
    deps.setAlias(order.id, name);
    return { text: `✅ 已给指令绑定别名 $${name}` };
  } catch (err) {
    return { text: `保存失败: ${(err as Error).message}` };
  }
}

function orderAliasRemove(
  args: string[],
  _ctx: CommandContext,
  _offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const target = args[2];
  if (!target) return { text: '用法: /order alias rm <orderId|序号>' };
  const order = deps.resolveTarget(target);
  if (!order) return { text: `指令不存在: ${target}` };
  if (!order.alias) return { text: '该指令没有别名' };
  const aliasName = order.alias;
  try {
    deps.setAlias(order.id, undefined);
    return { text: `✅ 已移除别名 $${aliasName}` };
  } catch (err) {
    return { text: `保存失败: ${(err as Error).message}` };
  }
}

/** alias 子操作 → handler。用 Map 而非对象字面量：`constructor` 这类键会命中 Object.prototype。 */
const ORDER_ALIAS_HANDLERS = new Map<string, OrderSubHandler>([
  ['add', orderAliasAdd],
  ['rm', orderAliasRemove],
]);

function orderAlias(
  args: string[],
  ctx: CommandContext,
  offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const op = args[1];
  if (!op || op === 'list') return buildOrderCommand([], ctx, offset, deps);
  const handler = ORDER_ALIAS_HANDLERS.get(op);
  return handler ? handler(args, ctx, offset, deps) : { text: ORDER_ALIAS_USAGE_TEXT };
}

function orderSave(
  args: string[],
  _ctx: CommandContext,
  _offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const text = args.slice(1).join(' ');
  if (!text) return { text: '用法: /order save <指令文本>' };
  try {
    deps.save(text);
    return { text: `✅ 已保存指令: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}` };
  } catch (err) {
    return { text: `保存失败: ${(err as Error).message}` };
  }
}

function orderEdit(
  args: string[],
  _ctx: CommandContext,
  _offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const target = args[1];
  const newText = args.slice(2).join(' ').trim();
  if (!target || !newText) {
    return { text: '用法: /order edit <orderId|序号> <新文本>' };
  }
  const order = deps.resolveTarget(target);
  if (!order) return { text: `指令不存在: ${target}` };
  try {
    deps.updateText(order.id, newText);
    const preview = newText.length > 50 ? newText.slice(0, 50) + '...' : newText;
    return { text: `✅ 已更新指令: ${preview}` };
  } catch (err) {
    return { text: `保存失败: ${(err as Error).message}` };
  }
}

/** 子命令 → handler。未知 sub 回退到长用法文案（与拆分前一致）。 */
const ORDER_SUB_HANDLERS = new Map<string, OrderSubHandler>([
  ['list', orderList],
  ['alias', orderAlias],
  ['save', orderSave],
  ['edit', orderEdit],
]);

export function buildOrderCommand(
  args: string[],
  ctx: CommandContext,
  offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const sub = args[0]?.toLowerCase();
  const handler = sub === undefined ? orderList : ORDER_SUB_HANDLERS.get(sub);
  return handler ? handler(args, ctx, offset, deps) : { text: ORDER_USAGE_TEXT };
}
