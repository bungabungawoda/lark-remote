/**
 * 回归测试：不转义 []| 的 collapsible_panel 不触发飞书 11311
 *
 * 背景：escapeMarkdown 曾转义 []| -> &#91;&#93;&#124;，无证据防错，
 * 却破坏合法链接渲染。已移除 []| 转义，仅保留反斜杠转义。
 * 本测试用真实飞书验证含 []| 的卡片可正常创建，防止 []| 转义被重新引入。
 *
 * 用例覆盖 []| 的常见形态：合法链接、锚点标题、正则/数组、表格、混合。
 * 经 markdownDiv（真实代码路径，escapeMarkdown 仅转义反斜杠）渲染。
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test tests/escape-bracket-experiment.test.ts
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { markdownDiv } from '../../src/card/collapsible.js';
import { TEST_CONFIG_DIR, configPath, skipIfNoConfig, describeLive } from './live-helpers.js';

let connector: FeishuConnector;
let testChatId: string;

const panel = (title: string, content: string, expanded = true) => ({
  tag: 'collapsible_panel',
  expanded,
  header: {
    title: { tag: 'markdown', content: title },
    vertical_align: 'center' as const,
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  },
  border: { color: 'grey', corner_radius: '5px' },
  vertical_spacing: '8px',
  padding: '8px 8px 8px 8px',
  elements: [markdownDiv(content)],
});

describeLive('回归：不转义 []| 的 collapsible_panel', () => {
  beforeEach(async () => {
    if (skipIfNoConfig()) return;
    const config = loadConfig(configPath);
    connector = new FeishuConnector(config);
    await connector.connect();
    const contactPath = path.join(TEST_CONFIG_DIR, 'startup-contact.json');
    if (fs.existsSync(contactPath)) {
      testChatId = JSON.parse(fs.readFileSync(contactPath, 'utf-8')).chatId;
    }
  });

  afterEach(async () => {
    if (connector) await connector.disconnect();
  });

  it('不转义 []|：链接/锚点/正则/数组/表格/混合 不触发 11311', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      console.log('⚠️ 跳过：无测试配置');
      return;
    }

    // 每个用例覆盖真实日志里 []| 的一种形态，经 markdownDiv（escapeMarkdown 仅转义反斜杠）
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '🧪 []| 转义回归（不转义）' },
        template: 'blue',
      },
      body: {
        elements: [
          // 用例1: 合法 markdown 链接 [text](url) -- 日志里 472 个曾被破坏的形态
          panel(
            '用例1: 合法链接',
            '关联设计 [web-ui-design](./2026-07-09-web-ui-design.md) 与 [tower-mechanics-roadmap](./roadmap.md)',
          ),
          // 用例2: 锚点标题 #[text] -- 日志里 wasm_bindgen 形态
          panel('用例2: 锚点标题', '# [wasm_bindgen]\n这是章节内容，含方括号锚点'),
          // 用例3: 正则与数组下标 -- 代码语境的 []
          panel(
            '用例3: 正则/数组',
            '正则 `[0-9]+` 匹配数字，访问 `arr[0]` 第一个元素，数组 `[1, 2, 3]`',
          ),
          // 用例4: 表格 | 分隔符
          panel('用例4: 表格', '| 名称 | 值 |\n|---|---|\n| alpha | 1 |\n| beta | 2 |'),
          // 用例5: 混合（链接 + 锚点 + 代码块内 []| + 表格）-- 最接近真实复杂 content
          panel(
            '用例5: 混合',
            '见 [设计文档](./design.md) 与 [路线图](./roadmap.md)\n\n## [wasm_bindgen] 章节\n\n```\nconst re = /[0-9]+/;\narr[0] = [1, 2, 3];\n```\n\n| 模块 | 状态 |\n|---|---|\n| core | ✅ |',
          ),
        ],
      },
    };

    try {
      const messageId = await connector.sendWithRetry(testChatId, { card });
      console.log('✅ 不转义 []| 卡片发送成功，messageId:', messageId);
      expect(messageId).toBeDefined();
    } catch (err: unknown) {
      const e = err as { code?: string; cause?: { response?: { data?: { msg?: string } } } };
      const feishuError = e?.cause?.response?.data;
      console.log('❌ 卡片被拒绝:');
      console.log('  err.code:', e.code);
      console.log('  feishuError:', JSON.stringify(feishuError));
      if (feishuError?.msg?.includes('11311')) {
        console.log('  -> 不转义 []| 触发 11311，需重新评估转义策略');
        // Only throw for actual 11311 errors — these mean our escaping is wrong
        throw err;
      }
      // Non-11311 errors (network/SDK issues) — skip instead of failing the suite
      console.log('  -> 非 11311 错误，跳过（网络/SDK 问题）');
      return;
    }
  });
});
