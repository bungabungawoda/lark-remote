import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuConnector } from '../../../src/connector/index.js';
import type { AppConfig } from '../../../src/config/index.js';

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    updateCard: vi.fn(),
  }),
}));

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const config: AppConfig = {
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    effort: 'medium',
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  defaultAgent: 'claude',
  output: { showThinking: true, showToolUse: false, showToolResult: false },
  logging: { level: 'info' },
};

describe('P1-3 sendWithRetry retries feishu business code 99991400/99991401 (anchor)', () => {
  let connector: FeishuConnector;
  let mockChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new FeishuConnector(config);
    mockChannel = (connector as unknown as { channel: { send: ReturnType<typeof vi.fn> } }).channel
      .send as ReturnType<typeof vi.fn>;
  });

  /**
   * 验证什么（target）:
   *   飞书业务错误码 99991400（频率控制）被 SDK @larksuite/channel@0.3.0 的
   *   classifyError 归类为 `code='permission_denied'`，原始 axios 错误（含
   *   response.data.code=99991400）保存在 `cause` 链上（已读 SDK 源码实证：
   *   node_modules/@larksuite/channel/dist/index.cjs:1265-1275）。
   *   sendWithRetry 必须识别 cause 链上的 99991400 并重试一次（同 rate_limited 语义）。
   *
   * 缺失导致什么（importance）:
   *   现状只判 `channelErr.code === 'rate_limited'`，99991400 归类为
   *   permission_denied 后永不重试（SDK 内部 retry 对 permission_denied
   *   fail-fast）——outbound 洪峰时消息直接失败抛给用户，限流重试设计意图
   *   完全失效（review.md §P1-3，design.md §9.5 + AGENTS.md「限流重试
   *   （99991400）」口径同步错误）。
   *
   * 依据: review.md §P1-3 失败用例（SDK 真实映射：permission_denied + feishuCode 经
   *   cause 链透传）。
   */
  it('anchor: retries once on SDK-classified permission_denied with feishuCode 99991400 in cause chain', async () => {
    mockChannel
      .mockRejectedValueOnce({
        code: 'permission_denied',
        message: 'frequency control',
        cause: { response: { data: { code: 99991400 } } },
      })
      .mockResolvedValueOnce({ messageId: 'msg-789' });

    const result = await connector.sendWithRetry('chat-1', { text: 'hello' });

    expect(result).toBe('msg-789'); // 现状：直接 throw
    expect(mockChannel).toHaveBeenCalledTimes(2);
  });
});
