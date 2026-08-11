import { describe, it, expect, vi } from 'vitest';

// 捕获 createLarkChannel 调用参数，验证 safety.dedup.ttl 传入正确。
// vi.mock factory 会被提升到文件顶部，引用的变量必须用 vi.hoisted 创建。
const { createLarkChannelMock } = vi.hoisted(() => {
  const createLarkChannelMock = vi.fn(() => ({
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    updateCard: vi.fn(),
  }));
  return { createLarkChannelMock };
});

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: createLarkChannelMock,
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { FeishuConnector, DEDUP_TTL_MS } from './index.js';
import type { AppConfig } from '../config/index.js';

const config: AppConfig = {
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    effort: 'medium',
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  output: { showThinking: true, showToolUse: false, showToolResult: false },
  logging: { level: 'info' },
  defaultAgent: 'claude',
};

// 2026-07-05 回归测试：dedup ttl 必须远小于用户连击间隔。
//
// 根因：SDK 的 cardAction dedup eventId = card:{messageId}:{operator}:{actionId}，
// actionId = tag|name|option|JSON.stringify(value)，不含时间戳。config 卡片原地更新，
// 用户在同一张卡连点 toggle 时三段都相同 → eventId 相同 → 第二次被 seenCache drop，
// toggle 不可逆（"显示工具结果"第二次点击静默失效）。
//
// 此 bug 无法在 stub connector 测试中复现（测试绕过 SDK safety 层），只能靠
// 常量区间断言防止 ttl 被改回长窗口。详见 design.md §9.8。
describe('connector dedup TTL', () => {
  it('DEDUP_TTL_MS is small enough to let user multi-click through', () => {
    // 下界：仍能挡飞书瞬时重投递（<100ms 级）
    expect(DEDUP_TTL_MS).toBeGreaterThanOrEqual(100);
    // 上界：放过用户连击（慢点两次通常 >500ms）
    expect(DEDUP_TTL_MS).toBeLessThanOrEqual(500);
  });

  it('passes DEDUP_TTL_MS to createLarkChannel as safety.dedup.ttl', () => {
    createLarkChannelMock.mockClear();

    new FeishuConnector(config);
    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);
    const callArgs = createLarkChannelMock.mock.calls[0] as unknown[];
    const arg = callArgs[0] as {
      safety?: { dedup?: { ttl?: number } };
    };
    expect(arg.safety?.dedup?.ttl).toBe(DEDUP_TTL_MS);
  });
});
