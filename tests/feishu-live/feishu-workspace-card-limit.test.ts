/**
 * 飞书 API 集成测试 - /ws 卡片 body.elements 上限（ErrCode 11310）
 *
 * 背景（2026-08-13 线上故障）：
 * /ws 卡片按 entries.length 全量渲染，每个 workspace 占 3 个 body 元素
 * （div + column_set + hr，末行 hr 被 pop），加上头部 2 个元素。20 个
 * workspace = 61 个元素，超过飞书单卡 body.elements 60 个上限，发送报
 * ErrCode 11310 "element exceeds the limit"。
 *
 * 验收标准：
 * 1. 20 个 workspace 的原始卡片（无分页）→ 飞书返回 11310（复现线上故障）
 * 2. 15 条/页 + 分页栏（修复后结构，20 条共 2 页）→ 两页均发送成功
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

/** 与 CommandRouter.cmdWs 完全一致的结构（修复后：每页 WS_PAGE_SIZE 条 + 分页栏）。 */
function buildWsCard(entries: [string, string][], offset: number, pageSize: number) {
  const totalCount = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const maxOffset = Math.max(0, (totalPages - 1) * pageSize);
  const safeOffset = Math.min(Math.max(offset, 0), maxOffset);
  const currentPage = Math.floor(safeOffset / pageSize) + 1;
  const page = entries.slice(safeOffset, safeOffset + pageSize);
  const hasPagination = totalCount > pageSize;

  const bodyElements: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: '📂 当前工作目录：`/tmp`' } },
    { tag: 'hr' },
  ];

  for (const [name, p] of page) {
    bodyElements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${name}** → \`${p}\`` },
    });
    bodyElements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '切换' },
              type: 'primary',
              size: 'small',
              behaviors: [{ type: 'callback', value: { cmd: 'ws.use', name } }],
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
                { type: 'callback', value: { cmd: 'ws.remove', name, offset: safeOffset } },
              ],
            },
          ],
        },
      ],
    });
    bodyElements.push({ tag: 'hr' });
  }
  bodyElements.pop();

  if (hasPagination) {
    const hasPrev = safeOffset > 0;
    const hasNext = safeOffset + pageSize < totalCount;
    const pageColumns: object[] = [];
    if (hasPrev) {
      pageColumns.push({
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
              { type: 'callback', value: { cmd: 'ws.page', offset: safeOffset - pageSize } },
            ],
          },
        ],
      });
    }
    pageColumns.push({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 条）`,
          },
        },
      ],
    });
    if (hasNext) {
      pageColumns.push({
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
              { type: 'callback', value: { cmd: 'ws.page', offset: safeOffset + pageSize } },
            ],
          },
        ],
      });
    }
    bodyElements.push({ tag: 'hr' });
    bodyElements.push({ tag: 'column_set', columns: pageColumns });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Workspaces' } },
    body: { elements: bodyElements },
  };
}

const twentyEntries: [string, string][] = Array.from({ length: 20 }, (_, i) => [
  `ws${String(i).padStart(2, '0')}`,
  `/tmp/ws${String(i).padStart(2, '0')}`,
]);

describeLive('飞书 API 集成测试 - /ws 卡片元素上限（11310）', () => {
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

  it('20 个 workspace 全量渲染（旧结构）应触发 11310 element exceeds the limit', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }

    // 旧结构：pageSize = 20 且无分页栏（hasPagination=false）
    const card = buildWsCard(twentyEntries, 0, 20);
    // 2(头部) + 20*3(行) - 1(末行 hr) = 61 个 body 元素，超过 60 上限
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

  it('15 条/页 + 分页栏（修复后结构，20 条 2 页）两页均应发送成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }

    // 第 1 页：2(头部) + 15*3(行) - 1(末行 hr) + 2(分页栏) = 48 个 body 元素
    const page1 = buildWsCard(twentyEntries, 0, 15);
    expect((page1.body.elements as object[]).length).toBe(48);
    const id1 = await connector.sendWithRetry(testChatId, { card: page1 });
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);

    // 第 2 页：5 条
    const page2 = buildWsCard(twentyEntries, 15, 15);
    const id2 = await connector.sendWithRetry(testChatId, { card: page2 });
    expect(typeof id2).toBe('string');
    expect(id2.length).toBeGreaterThan(0);
  });
});
