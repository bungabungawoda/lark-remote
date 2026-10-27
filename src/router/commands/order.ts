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

export function buildOrderCommand(
  args: string[],
  ctx: CommandContext,
  offset: number,
  deps: OrderCommandDeps,
): CommandResult {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'list') {
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
        const order = pageOrders[i];
        const displayText = order.text.length > 100 ? order.text.slice(0, 97) + '...' : order.text;
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: order.alias ? `\`$${order.alias}\` ${displayText}` : displayText,
          },
        });

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

        elements.push({
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
        });
        if (i < pageOrders.length - 1) elements.push({ tag: 'hr' });
      }

      if (hasPagination) {
        elements.push(
          { tag: 'hr' },
          ...paginationBar({
            cmd: 'order.page',
            offset: safeOffset,
            pageSize: ORDER_PAGE_SIZE,
            total: totalCount,
            label: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 条）`,
          }),
        );
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

  if (sub === 'alias') {
    const op = args[1];
    if (op === 'add') {
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
    if (op === 'rm') {
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
    if (!op || op === 'list') return buildOrderCommand([], ctx, offset, deps);
    return {
      text: '用法: /order alias [add <orderId|序号> <别名名> | rm <orderId|序号> | list]',
    };
  }

  if (sub === 'save') {
    const text = args.slice(1).join(' ');
    if (!text) return { text: '用法: /order save <指令文本>' };
    try {
      deps.save(text);
      return { text: `✅ 已保存指令: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}` };
    } catch (err) {
      return { text: `保存失败: ${(err as Error).message}` };
    }
  }

  if (sub === 'edit') {
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

  return {
    text: '用法: /order [list|save <text>|edit <orderId|序号> <新文本>|alias add <orderId|序号> <别名名>|alias rm <orderId|序号>]',
  };
}
