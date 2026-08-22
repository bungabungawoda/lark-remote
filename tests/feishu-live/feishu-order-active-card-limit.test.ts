/**
 * 飞书 API 集成测试 - /order /active 卡片元素上限（ErrCode 11310）
 *
 * 背景（2026-08-13 排查）：
 * - /order 每行 2 个元素（div + column_set，行间 hr），ORDER_PAGE_SIZE=20 时
 *   21+ 条指令第 1 页 = 20 行 + 分页栏 = 61 个 body 元素 → 11310。
 *   修复后每页 15 行 = 46 个元素。
 * - /active 每行 4 个元素（div + div + button + hr），每页最多 20 行，
 *   满页（含两个分组头 + 分页栏）= 84 个顶层元素，实测不超限；本文件锁定
 *   该结论，防止未来行结构膨胀回归。
 *
 * 验收标准：
 * 1. /order 旧结构（21 条，20/页）→ 11310（复现）
 * 2. /order 新结构（21 条，15/页）第 1、2 页 → 发送成功
 * 3. /active 最坏情况（15 agent + 20 bash，第 1 页混合 20 行）→ 发送成功
 * 4. /active 中间页（40 agent + 40 bash，offset=20）→ 发送成功
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test:live
 *
 * 注意：使用 ~/.lark-remote-test 下的配置，避免干扰正常使用。
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { TEST_CONFIG_DIR, configPath, skipIfNoConfig, describeLive } from './live-helpers.js';

let connector: FeishuConnector;
let testChatId: string;

function wrap(elements: object[]) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'probe' } },
    body: { elements },
  };
}

/** 与 CommandRouter.cmdOrder 完全一致的结构（修复后 ORDER_PAGE_SIZE=15）。 */
function buildOrderCard(n: number, offset: number, pageSize: number) {
  const orders = Array.from({ length: n }, (_, i) => `order-${i}`);
  const totalPages = Math.max(1, Math.ceil(n / pageSize));
  const maxOffset = Math.max(0, (totalPages - 1) * pageSize);
  const safeOffset = Math.min(Math.max(offset, 0), maxOffset);
  const currentPage = Math.floor(safeOffset / pageSize) + 1;
  const page = orders.slice(safeOffset, safeOffset + pageSize);
  const elements: object[] = [];
  for (let i = 0; i < page.length; i++) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: page[i] } });
    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '▶ 执行' },
              type: 'primary',
              size: 'small',
              behaviors: [{ type: 'callback', value: { cmd: 'order.exec', orderId: `id-${i}` } }],
            },
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '删除' },
              type: 'danger',
              size: 'small',
              behaviors: [
                {
                  type: 'callback',
                  value: { cmd: 'order.delete', orderId: `id-${i}`, offset: safeOffset },
                },
              ],
            },
          ],
        },
      ],
    });
    if (i < page.length - 1) elements.push({ tag: 'hr' });
  }
  if (n > pageSize) {
    const hasPrev = safeOffset > 0;
    const hasNext = safeOffset + pageSize < n;
    const columns: object[] = [];
    if (hasPrev) {
      columns.push({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⬅ 上一页' },
            type: 'default',
            size: 'small',
            behaviors: [
              { type: 'callback', value: { cmd: 'order.page', offset: safeOffset - pageSize } },
            ],
          },
        ],
      });
    }
    columns.push({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**第 ${currentPage}/${totalPages} 页**（共 ${n} 条）`,
          },
        },
      ],
    });
    if (hasNext) {
      columns.push({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '下一页 ➡' },
            type: 'default',
            size: 'small',
            behaviors: [
              { type: 'callback', value: { cmd: 'order.page', offset: safeOffset + pageSize } },
            ],
          },
        ],
      });
    }
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'column_set', columns });
  }
  return wrap(elements);
}

/** 与 CommandRouter.buildActiveCardFromMemory 完全一致的结构（ACTIVE_PAGE_SIZE=20）。 */
function buildActiveCard(agentRuns: number, bashRuns: number, offset: number, pageSize: number) {
  const totalCount = agentRuns + bashRuns;
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, totalCount - 1)));
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.floor(safeOffset / pageSize) + 1;
  const elements: object[] = [];
  if (totalPages > 1) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**第 ${currentPage}/${totalPages} 页** （共 ${totalCount} 项）`,
      },
    });
  }
  let remaining = pageSize;
  let skipped = safeOffset;
  if (agentRuns > 0 && skipped < agentRuns && remaining > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '## 🤖 Agent 任务' } });
    const start = skipped;
    const end = Math.min(start + remaining, agentRuns);
    for (let i = start; i < end; i++) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**📂 project-${i}**` } });
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `> session: sess-${i}...  \n> 状态: 运行中` },
      });
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '⏹ 停止' },
        type: 'danger',
        size: 'small',
        behaviors: [{ type: 'callback', value: { cmd: 'stop', runId: `run-${i}` } }],
      });
      elements.push({ tag: 'hr' });
    }
    remaining -= end - start;
    skipped = 0;
  } else {
    skipped -= agentRuns;
  }
  if (bashRuns > 0 && skipped < bashRuns && remaining > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '## 💻 Bash 命令' } });
    const start = skipped;
    const end = Math.min(start + remaining, bashRuns);
    for (let i = start; i < end; i++) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**\`echo ${i}\`**` } });
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `> 目录: /home/user/project-${i}  \n> 状态: 运行中` },
      });
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '⏹ 停止' },
        type: 'danger',
        size: 'small',
        behaviors: [{ type: 'callback', value: { cmd: 'stop', runId: `bash-${i}` } }],
      });
      elements.push({ tag: 'hr' });
    }
  }
  if (totalPages > 1) {
    const buttons: object[] = [];
    if (currentPage > 1) {
      buttons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '◀ 上一页' },
        type: 'default',
        size: 'small',
        behaviors: [
          { type: 'callback', value: { cmd: 'active.page', offset: (currentPage - 2) * pageSize } },
        ],
      });
    }
    if (currentPage < totalPages) {
      buttons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '下一页 ▶' },
        type: 'primary',
        size: 'small',
        behaviors: [
          { type: 'callback', value: { cmd: 'active.page', offset: currentPage * pageSize } },
        ],
      });
    }
    elements.push({
      tag: 'column_set',
      columns: buttons.map((btn) => ({ tag: 'column', width: 'auto', elements: [btn] })),
    });
  }
  return wrap(elements);
}

describeLive('飞书 API 集成测试 - /order /active 卡片元素上限（11310）', () => {
  beforeEach(async () => {
    if (skipIfNoConfig()) return;
    const config = loadConfig(configPath);
    connector = new FeishuConnector(config);
    await connector.connect();

    const startupContactPath = path.join(TEST_CONFIG_DIR, 'startup-contact.json');
    if (fs.existsSync(startupContactPath)) {
      const contact = JSON.parse(fs.readFileSync(startupContactPath, 'utf-8'));
      testChatId = contact.chatId;
    } else {
      console.log('⚠️ 跳过：没有有效的 chatId');
    }
  });

  afterEach(async () => {
    if (connector) await connector.disconnect();
  });

  it('/order 旧结构（21 条，20/页）应触发 11310', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }
    const card = buildOrderCard(21, 0, 20);
    // 20 行 + 分页栏 = 61 个 body 元素
    expect((card.body.elements as object[]).length).toBe(61);
    await expect(connector.sendWithRetry(testChatId, { card })).rejects.toMatchObject({
      cause: expect.objectContaining({
        response: expect.objectContaining({
          data: expect.objectContaining({
            msg: expect.stringContaining('11310'),
          }),
        }),
      }),
    });
  });

  it('/order 新结构（21 条，15/页）第 1、2 页均应发送成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }
    const page1 = buildOrderCard(21, 0, 15);
    // 15 行 + 分页栏 = 46 个 body 元素
    expect((page1.body.elements as object[]).length).toBe(46);
    const id1 = await connector.sendWithRetry(testChatId, { card: page1 });
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);

    const page2 = buildOrderCard(21, 15, 15);
    const id2 = await connector.sendWithRetry(testChatId, { card: page2 });
    expect(typeof id2).toBe('string');
    expect(id2.length).toBeGreaterThan(0);
  });

  it('/active 最坏情况（15 agent + 20 bash 第 1 页混合 20 行）应发送成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }
    const card = buildActiveCard(15, 20, 0, 20);
    // 页信息 1 + Agent 头 1 + 15*4 + Bash 头 1 + 5*4 + 分页栏 1 = 84 顶层元素
    expect((card.body.elements as object[]).length).toBe(84);
    const id = await connector.sendWithRetry(testChatId, { card });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('/active 中间页（40 agent + 40 bash，offset=20）应发送成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }
    const card = buildActiveCard(40, 40, 20, 20);
    const id = await connector.sendWithRetry(testChatId, { card });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});
