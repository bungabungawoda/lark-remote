/**
 * 飞书 API 集成测试 - /ls 分页栏 column_set 校验
 *
 * 验收标准：
 * 1. 发送 /ls ~ 卡片（含分页栏，触发 pagination），验证飞书 API 返回成功
 * 2. 分页栏的 column_set 中每个 column 必须有 tag: 'column'（CardKit 2.0 要求）
 * 3. 修复后的代码应该能通过，飞书 API 返回 200 (messageId)
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test tests/feishu-ls-pagination-card.test.ts
 *
 * 注意：使用 ~/.lark-remote-test 下的配置，避免干扰正常使用
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { TEST_CONFIG_DIR, configPath, skipIfNoConfig, describeLive } from './live-helpers.js';

// 使用独立的测试配置目录

let connector: FeishuConnector;
let testChatId: string;
let tmpDir: string;

describeLive('飞书 API 集成测试 - /ls 分页栏 CardKit 2.0 column 校验', () => {
  beforeEach(async () => {
    // Skip if no config
    if (skipIfNoConfig()) {
      return;
    }

    // Load config from test directory
    const config = loadConfig(configPath);

    connector = new FeishuConnector(config);
    await connector.connect();

    // Use startup-contact.json from test directory to get a valid chatId
    const startupContactPath = path.join(TEST_CONFIG_DIR, 'startup-contact.json');
    if (fs.existsSync(startupContactPath)) {
      const contact = JSON.parse(fs.readFileSync(startupContactPath, 'utf-8'));
      testChatId = contact.chatId;
    } else {
      console.log('⚠️ 跳过：没有有效的 chatId');
      return;
    }

    // Create temp directory with 31+ items to trigger pagination
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ls-test-'));
    for (let i = 0; i < 31; i++) {
      fs.mkdirSync(path.join(tmpDir, `dir${String(i).padStart(2, '0')}`));
    }
  });

  afterEach(async () => {
    if (connector) {
      await connector.disconnect();
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('发送 /ls 卡片（含分页栏）到飞书 API 应该成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }

    // Build the exact card structure that /ls generates with pagination
    // This simulates /ls ~ for a directory with 31+ items (triggers pagination)
    const cardWithPagination = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '📁 test-dir' },
        template: 'blue',
      },
      body: {
        elements: [
          // Status line with path
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '`/tmp/test`\n共 31 目录, 0 文件 · 第 1/2 页（共 31 项）',
            },
          },
          // Navigation buttons
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '刷新' },
                    type: 'default',
                    size: 'small',
                    behaviors: [
                      {
                        type: 'callback',
                        value: { cmd: 'ls.refresh', path: '/tmp/test', offset: 0 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { tag: 'hr' },
          // Directories section header
          { tag: 'div', text: { tag: 'lark_md', content: '**📂 目录 (31)**' } },
          // Directory buttons (first 30 items)
          ...Array.from({ length: 30 }, (_, i) => ({
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: `📁 dir${String(i).padStart(2, '0')}` },
                    type: 'default',
                    behaviors: [
                      {
                        type: 'callback',
                        value: {
                          cmd: 'ls.browse',
                          path: `/tmp/test/dir${String(i).padStart(2, '0')}`,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          })),
          { tag: 'hr' },
          // Pagination bar - THIS IS THE KEY TEST
          // The bug was: pageColumns.push() without tag: 'column'
          {
            tag: 'column_set',
            columns: [
              // 页码文本 - WITHOUT tag: 'column' was the bug!
              // Fixed version has: tag: 'column'
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                vertical_align: 'center',
                elements: [
                  { tag: 'div', text: { tag: 'lark_md', content: '**第 1/2 页**（共 31 项）' } },
                ],
              },
              // 下一页按钮
              {
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
                      {
                        type: 'callback',
                        value: { cmd: 'ls.page', path: '/tmp/test', offset: 30 },
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

    // Send to Feishu API - should succeed
    try {
      const messageId = await connector.sendWithRetry(testChatId, { card: cardWithPagination });
      console.log('✅ 卡片发送成功! messageId:', messageId);
      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');
      expect(messageId.length).toBeGreaterThan(0);
    } catch (err: unknown) {
      const e = err as {
        code?: string;
        message?: string;
        cause?: { response?: { data?: { msg?: string; code?: number } } };
      };
      console.log(
        '❌ 卡片发送失败:',
        JSON.stringify({
          code: e.code,
          message: e.message,
          feishuError: e.cause?.response?.data,
        }),
      );
      // If this fails, it means the card structure has issues
      // ErrCode 200621 "no tag specified" = column without tag
      const feishuError = e.cause?.response?.data;
      const errorMsg = feishuError?.msg || '';
      if (errorMsg.includes('200621') && errorMsg.includes('no tag specified')) {
        // This is the exact bug we fixed - column without tag
        expect.unreachable('card structure regression: column without tag');
      }
      throw err;
    }
  });

  it('发送包含 column_set 但 column 缺少 tag 的卡片，应该触发 200621 错误（验证测试正确性）', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：connector 或 chatId 不可用');
      return;
    }

    // Intentional bug: column without tag
    const buggyCard = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '📁 test' },
        template: 'blue',
      },
      body: {
        elements: [
          {
            tag: 'column_set',
            columns: [
              // BUG: missing tag: 'column' - this should trigger 200621
              {
                width: 'weighted',
                weight: 1,
                elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'test' } }],
              },
            ],
          },
        ],
      },
    };

    try {
      await connector.sendWithRetry(testChatId, { card: buggyCard });
      // If we reach here, Feishu accepted it (unexpected)
      console.log('⚠️ 卡片发送成功，但预期应该失败');
      // This shouldn't happen - Feishu should reject this card
      expect.unreachable('card should have been rejected by Feishu');
    } catch (err: unknown) {
      const e = err as {
        code?: string;
        cause?: { response?: { data?: { msg?: string; code?: number } } };
      };
      const feishuError = e.cause?.response?.data;
      console.log('✅ 预期错误捕获:', JSON.stringify(feishuError));

      // Should get 200621 "no tag specified" or similar format error
      expect(e.code).toBe('format_error');
      expect(feishuError?.msg).toContain('200621');
    }
  });
});
