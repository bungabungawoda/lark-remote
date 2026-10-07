/**
 * 入站媒体"二次合批"回归（2026-10-07）。
 *
 * 事故：飞书客户端"一次选多图/多文件"会背靠背秒发成**多条独立消息**。SDK
 * safety 层的 `ChatPipeline`（默认 600ms 去抖）用 `mergeBatch` 把它们合并成
 * 一条 `NormalizedMessage`，但只保留**最后一条**的 `messageId`，却把多条消息
 * 的 `resources` 求并集。下载侧于是拿同一个 `messageId` 去下所有 `fileKey`，
 * 除最后一条外全部报 234003（HTTP 400）→ 表现为"多图只保存 1 张，其余下载
 * 失败"（日志：`downloadResource failed ... type=image: Request failed with
 * status code 400`）。
 *
 * 修复：在 `FeishuConnector` 构造时传 `safety.batch.text.delayMs = 0`，令 SDK
 * 每条消息单独成批（保留各自 messageId），合批责任交回本项目自己的 700ms
 * `InboundTurnAssembler`。`chatQueue.enabled` 仍为 true，per-chat 串行与卡片
 * 动作同通道不变。
 *
 * 本文件**不 mock** `@larksuite/channel`：直接驱动真实 SDK 的 `safety.pushMessage`，
 * 因此修复前本用例会失败（3 条被合并成 1 条），修复后通过。这补上了 stub
 * connector 测试覆盖不到的那一层（stub 绕过 SDK safety）。
 */

import { describe, it, expect, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

import { FeishuConnector, type InboundMediaMessage } from './index.js';
import type { AppConfig } from '../config/index.js';

const config: AppConfig = {
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    effort: 'medium',
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  logging: { level: 'info' },
  defaultAgent: 'claude',
};

/** SDK safety 层的可访问面（`safety` 在类型上是 private，测试用最小接口取用）。 */
interface SafetyHandle {
  safety: {
    queueEnabled: boolean;
    manager: { config: { delayMs: number } };
    pushMessage(msg: NormalizedMessage): Promise<void>;
  };
}

function safetyOf(connector: FeishuConnector): SafetyHandle['safety'] {
  return (connector.channel as unknown as SafetyHandle).safety;
}

/** 构造一条"图片消息"的 NormalizedMessage（模拟 SDK normalize 的输出）。 */
function imageMessage(messageId: string, fileKey: string, createTime: number): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_test',
    chatType: 'p2p',
    senderId: 'ou_test',
    content: `![image](${fileKey})`,
    rawContentType: 'image',
    resources: [{ type: 'image', fileKey }],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime,
  };
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('入站媒体不被 SDK 二次合批', () => {
  it('delayMs=0 关掉去抖合批，且保留 per-chat 串行与卡片同通道（queueEnabled）', () => {
    const connector = new FeishuConnector(config);
    const safety = safetyOf(connector);
    expect(safety.manager.config.delayMs).toBe(0);
    // 只摘掉"合并"，串行/卡片动作通道必须还在（避免动到定序语义）。
    expect(safety.queueEnabled).toBe(true);
  });

  it('连续多条媒体消息各自保留自己的 messageId（修复前会被合并成一条）', async () => {
    const connector = new FeishuConnector(config);
    const detected: InboundMediaMessage[] = [];
    connector.setInboundMediaDetectedHandler((msg) => {
      detected.push(msg);
    });

    const safety = safetyOf(connector);
    const ids = ['om_batch_a', 'om_batch_b', 'om_batch_c'];
    const base = Date.now();
    for (let i = 0; i < ids.length; i += 1) {
      await safety.pushMessage(imageMessage(ids[i], `img_v3_batch_${i}`, base + i * 20));
    }

    await waitUntil(() => detected.length >= ids.length, 2000);

    // 每条消息各自到达，messageId 不被"最后一条"顶替。
    expect(detected.map((m) => m.messageId)).toEqual(ids);
    expect(detected.flatMap((m) => m.resources.map((r) => r.fileKey))).toEqual([
      'img_v3_batch_0',
      'img_v3_batch_1',
      'img_v3_batch_2',
    ]);
  });
});
