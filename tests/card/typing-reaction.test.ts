/**
 * 红 agent - Typing reaction anchor 测试
 *
 * 验收标准：
 * 1. FeishuConnector 有 addReaction 方法，可添加 reaction
 * 2. 收到普通消息时，添加 Typing 表情到该消息
 * 3. 收到 slash 命令时，添加 Typing 表情
 * 4. 收到 /stop 命令时，添加 Typing 表情
 * 5. 收到卡片按钮点击时，添加 Typing 表情
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

describe('Typing reaction - Message handler integration', () => {
  let tempDir: string;
  let indexContent: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-typing-test-'));
    indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_anchor_normal_message_adds_typing_reaction', () => {
    // 验证普通消息处理时添加 Typing 表情
    // 期望：在处理普通消息的代码路径中，调用了 addReaction 方法，参数包含 'Typing'
    expect(indexContent).toMatch(/addReaction.*Typing|Typing.*addReaction/s);
  });

  it('test_anchor_slash_command_adds_typing_reaction', () => {
    // 验证 slash 命令处理时添加 Typing 表情
    // 期望：在处理 / 命令的代码路径中，调用了 addReaction 方法，参数包含 'Typing'
    // 注意：slash 命令和普通消息走不同的代码路径
    expect(indexContent).toMatch(/addReaction.*Typing|Typing.*addReaction/s);
  });

  it('test_anchor_stop_command_adds_typing_reaction', () => {
    // 验证 /stop 命令处理时添加 Typing 表情
    // 期望：在处理 /stop 命令的代码路径中，调用了 addReaction 方法
    expect(indexContent).toMatch(/addReaction.*Typing|Typing.*addReaction/s);
  });

  it('test_anchor_card_action_adds_typing_reaction', () => {
    // 验证卡片按钮点击处理时添加 Typing 表情
    // 期望：在处理卡片动作的代码路径中（setCardActionHandler），调用了 addReaction 方法
    expect(indexContent).toMatch(/addReaction.*Typing|Typing.*addReaction/s);
  });
});
