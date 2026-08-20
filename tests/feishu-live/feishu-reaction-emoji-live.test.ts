/**
 * 真实飞书 API 集成测试 - reaction 表情 key 合法性
 *
 * 验收标准：
 * 1. 'Done' / 'ERROR' / 'Alarm' / 'SHHH' 四个 key 均能被飞书
 *    messageReaction.create 接受（SDK 原样透传 emoji_type，key 不合法会抛错）
 * 2. 验证后清理：移除本次添加的 reaction，不留垃圾数据
 *
 * 背景：bridge 按 run 终态给用户原消息打 reaction（done→Done / error→ERROR /
 * idle_timeout→Alarm / interrupted→SHHH，2026-08-02 用户确认）。
 * FeishuConnector.addReaction 吞错误只记日志，无法感知 key 拒绝，
 * 所以本测试直连 raw channel 断言每个 key 都能成功。
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test tests/feishu-reaction-emoji-live.test.ts
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

describeLive('飞书 API 集成测试 - reaction 表情 key 合法性', () => {
  beforeEach(async () => {
    if (skipIfNoConfig()) {
      return;
    }

    const config = loadConfig(configPath);
    connector = new FeishuConnector(config);
    await connector.connect();

    const startupContactPath = path.join(TEST_CONFIG_DIR, 'startup-contact.json');
    if (fs.existsSync(startupContactPath)) {
      const contact = JSON.parse(fs.readFileSync(startupContactPath, 'utf-8'));
      testChatId = contact.chatId;
    } else {
      console.log('⚠️ 跳过：没有有效的 chatId');
      return;
    }
  });

  afterEach(async () => {
    if (connector) {
      await connector.disconnect();
    }
  });

  it('四个 reaction key（Done/ERROR/Alarm/SHHH）均能被飞书 API 接受', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    // FeishuConnector.addReaction 吞错误只记日志，直连 raw channel 才能感知 key 拒绝
    const rawChannel = connector.channel;

    // 发一条真实消息作为 reaction 载体
    const messageId = await connector.sendWithRetry(testChatId, {
      text: 'reaction key 合法性自检（测试后自动清理）',
    });
    expect(messageId).toBeTruthy();

    const keys = ['Done', 'ERROR', 'Alarm', 'SHHH'];
    for (const key of keys) {
      // 失败（key 不合法）会抛错 → 测试失败
      const reactionId = await rawChannel.addReaction(messageId, key);
      expect(reactionId).toBeTruthy();
      // 清理：移除 bot 自己加的 reaction
      const removed = await rawChannel.removeReactionByEmoji(messageId, key);
      expect(removed).toBe(true);
    }
    // 真实 API 往返（发消息 + 4 组 add/remove reaction）默认 5s 超时过紧，
    // 实测 ~6s（2026-08-03 live 验证）；显式放宽到 30s 防 flaky。
  }, 30000);
});
