/**
 * 飞书 API 集成测试 - 触发卡片 form 错误
 *
 * 验收标准：
 * 1. 发送包含 form（无 submit 按钮）的卡片到飞书，触发 300123 错误
 * 2. 发送 form 到不支持的位置，触发 200621 错误
 * 3. 修复后的卡片（移除 form 标签）应该成功
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test tests/feishu-card-form-error.test.ts
 *
 * 注意：使用 ~/.lark-remote-test 下的配置，避免干扰正常使用
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { TEST_CONFIG_DIR, configPath, skipIfNoConfig, describeLive } from './live-helpers.js';

// 使用独立的测试配置目录

let connector: FeishuConnector;
let testChatId: string;

describeLive('飞书 API 集成测试 - CardKit 2.0 form 校验', () => {
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
      // Fallback: skip if no chatId
      console.log('⚠️ 跳过：没有有效的 chatId');
      return;
    }
  });

  afterEach(async () => {
    if (connector) {
      await connector.disconnect();
    }
  });

  it('发送 /ls 卡片（form 无 submit 按钮）触发 300123 错误', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    // This is the exact card structure that /ls generates
    // It has a form with input + button, but no type="submit" button
    const cardWithFormNoSubmit = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '📁 test-dir' },
        template: 'blue',
      },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '`/tmp/test`\n共 1 目录, 0 文件' } },
          { tag: 'hr' },
          // Search form - this is what causes the error
          {
            tag: 'form',
            name: 'ls_search',
            elements: [
              {
                tag: 'input',
                name: 'query',
                placeholder: { tag: 'plain_text', content: '输入文件名搜索' },
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '🔍 搜索' },
                type: 'primary', // ← 这是问题！应该是 type: "submit"
                behaviors: [{ type: 'callback', value: { cmd: 'ls.file' } }],
              },
            ],
          },
        ],
      },
    };

    // Send to Feishu API - should fail with 300123
    try {
      await connector.sendWithRetry(testChatId, { card: cardWithFormNoSubmit });
      // If we reach here, the card was accepted (unexpected)
      // In production, this would cause "no card displayed" issue
      console.log('⚠️ 卡片发送成功（未触发预期错误）');
      expect(false).toBe(true); // Fail the test if we reach here
    } catch (err: unknown) {
      const e = err as {
        code?: string;
        message?: string;
        cause?: { response?: { data?: { msg?: string } } };
      };
      // Expected: 300123 - form without submit button
      // The error structure:
      // e.code = "format_error"
      // e.cause is AxiosError with response.data containing the Feishu error details
      console.log(
        '捕获到的错误:',
        JSON.stringify({
          code: e.code,
          message: e.message,
          feishuError: e.cause?.response?.data,
        }),
      );

      // The actual error from Feishu:
      // ErrCode: 300123; ErrMsg: there is no submit button in the form container, at least one
      expect(e.code).toBe('format_error');
      const feishuError = e.cause?.response?.data;
      expect(feishuError?.msg).toContain('300123');
      expect(feishuError?.msg).toContain('no submit button');
    }
  });

  it('发送 /config 卡片（form 在 column 深层嵌套）触发 200621 错误', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    // This is the exact card structure that /config generates
    // form is nested inside column_set -> column -> elements -> form
    const cardWithNestedForm = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '⚙️ 系统配置' },
        template: 'blue',
      },
      body: {
        elements: [
          {
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 2,
                vertical_align: 'center',
                elements: [{ tag: 'div', text: { tag: 'lark_md', content: '停止等待(ms)' } }],
              },
              {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                vertical_align: 'center',
                elements: [
                  {
                    tag: 'form',
                    name: 'form_claude_stopGraceMs',
                    elements: [
                      {
                        tag: 'input',
                        name: 'claude.stopGraceMs',
                        placeholder: { tag: 'plain_text', content: '请输入值' },
                        default_value: '5000',
                      },
                      {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '💾' },
                        type: 'primary', // ← 这也是问题
                        size: 'small',
                        behaviors: [
                          {
                            type: 'callback',
                            value: { cmd: 'config.input', key: 'claude.stopGraceMs' },
                          },
                        ],
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

    try {
      await connector.sendWithRetry(testChatId, { card: cardWithNestedForm });
      console.log('⚠️ 卡片发送成功（未触发预期错误）');
      expect(false).toBe(true); // Fail the test if we reach here
    } catch (err: unknown) {
      const e = err as {
        code?: string;
        message?: string;
        cause?: { response?: { data?: { msg?: string } } };
      };
      // Expected: 200621 - type of element is not supported tag: form
      console.log(
        '捕获到的错误:',
        JSON.stringify({
          code: e.code,
          message: e.message,
          feishuError: e.cause?.response?.data,
        }),
      );

      // The actual error from Feishu:
      // ErrCode: 200621; ErrMsg: type of element is not supported tag: form
      expect(e.code).toBe('format_error');
      const feishuError = e.cause?.response?.data;
      expect(feishuError?.msg).toContain('200621');
      expect(feishuError?.msg).toContain('tag: form');
    }
  });

  it('发送 /help 卡片（无 form）应该成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    // /help card uses column_set + button, no form - should work fine
    const helpCard = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📖 可用命令' },
        template: 'blue',
      },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '`/help` — 显示此帮助' } },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '/status' },
                    type: 'default',
                    behaviors: [{ type: 'callback', value: { cmd: 'help.status' } }],
                  },
                ],
              },
              {
                tag: 'column',
                width: 'auto',
                elements: [{ tag: 'div', text: { tag: 'lark_md', content: '显示当前状态' } }],
              },
            ],
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: { tag: 'lark_md', content: '**快捷命令**\n`!<bash-command>` — 执行 bash 命令' },
          },
        ],
      },
    };

    // This should succeed (no form element)
    const messageId = await connector.sendWithRetry(testChatId, { card: helpCard });
    expect(messageId).toBeDefined();
    console.log('✅ /help 卡片发送成功（无 form 元素）');
  });

  // --- 修复后的卡片结构测试 ---

  it('修复后的 /ls 卡片（移除 form 标签）应该成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    // Fixed: 直接使用 input + button，不使用 form 标签
    const fixedLsCard = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '📁 test-dir' },
        template: 'blue',
      },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '`/tmp/test`\n共 1 目录, 0 文件' } },
          { tag: 'hr' },
          // Fixed: 直接使用 input + button，不使用 form 标签
          { tag: 'div', text: { tag: 'lark_md', content: '**🔍 搜索**' } },
          {
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                vertical_align: 'center',
                elements: [
                  {
                    tag: 'input',
                    name: 'query',
                    placeholder: { tag: 'plain_text', content: '输入文件名搜索' },
                  },
                ],
              },
              {
                tag: 'column',
                width: 'auto',
                vertical_align: 'center',
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '🔍 搜索' },
                    type: 'primary',
                    behaviors: [{ type: 'callback', value: { cmd: 'ls.file' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const messageId = await connector.sendWithRetry(testChatId, { card: fixedLsCard });
    expect(messageId).toBeDefined();
    console.log('✅ 修复后的 /ls 卡片发送成功');
  });

  it('修复后的 /config 卡片（移除 form 标签）应该成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    // Fixed: 直接使用 input + button，不使用 form 标签
    const fixedConfigCard = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '⚙️ 系统配置' },
        template: 'blue',
      },
      body: {
        elements: [
          {
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 2,
                vertical_align: 'center',
                elements: [{ tag: 'div', text: { tag: 'lark_md', content: '停止等待(ms)' } }],
              },
              {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                vertical_align: 'center',
                // Fixed: 直接使用 input + button，不嵌套在 form 中
                elements: [
                  {
                    tag: 'input',
                    name: 'claude.stopGraceMs',
                    placeholder: { tag: 'plain_text', content: '请输入值' },
                    default_value: '5000',
                  },
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '💾' },
                    type: 'primary',
                    size: 'small',
                    behaviors: [
                      {
                        type: 'callback',
                        value: { cmd: 'config.input', key: 'claude.stopGraceMs' },
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

    const messageId = await connector.sendWithRetry(testChatId, { card: fixedConfigCard });
    expect(messageId).toBeDefined();
    console.log('✅ 修复后的 /config 卡片发送成功');
  });
});
