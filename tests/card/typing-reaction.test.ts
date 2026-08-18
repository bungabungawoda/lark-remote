/**
 * Typing reaction anchor 测试
 *
 * 验收标准：
 * 1. FeishuConnector 有 addReaction 方法，可添加 reaction
 * 2. 收到普通消息时，添加 Typing 表情到该消息
 * 3. 收到 slash 命令时，添加 Typing 表情
 * 4. 收到 /stop 命令时，添加 Typing 表情
 * 5. 收到卡片按钮点击时，添加 Typing 表情
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  initLogger: vi.fn(),
}));

// Import after mocks are set up
import { FeishuConnector } from '../../src/connector/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';

// Mock @larksuite/channel - need to expose reaction methods on channel
let mockChannel: {
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  updateCard: ReturnType<typeof vi.fn>;
  addReaction: ReturnType<typeof vi.fn>;
  removeReaction: ReturnType<typeof vi.fn>;
};

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => {
    mockChannel = vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      stream: vi.fn(),
      updateCard: vi.fn(),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    }))();
    return mockChannel;
  },
}));

const config: AppConfig = AppConfigSchema.parse({
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    stopGraceMs: 5000,
  },
  workspace: { default: '' },
  output: { showThinking: true, showToolUse: false, showToolResult: false },
  logging: { level: 'info' },
});

describe('Typing reaction - FeishuConnector methods', () => {
  let connector: FeishuConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new FeishuConnector(config);
  });

  it('test_anchor_feishu_connector_has_add_reaction_method', () => {
    // 验证 FeishuConnector 有 addReaction 方法
    expect(typeof connector.addReaction).toBe('function');
  });
});
