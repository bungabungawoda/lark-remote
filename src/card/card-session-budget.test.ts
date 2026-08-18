import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CardSession, type CardChannel } from './card-session.js';

// Mock 卡片的超大内容

// 测试用的小型 CardChannel mock
class MockCardChannel implements CardChannel {
  lastMessageId?: string;
  lastCard?: object;
  lastError?: Error;

  async streamCard(
    _chatId: string,
    _initial: object,

    producer: (controller: any) => Promise<void>,
    _opts?: { replyTo?: string },
  ): Promise<string> {
    // 模拟一个 controller
    const controller = {
      messageId: 'mock-msg-id',
      update: async (card: object) => {
        // 模拟飞书 API 拒绝超大卡片
        const size = Buffer.byteLength(JSON.stringify(card), 'utf8');
        if (size > 28_000) {
          throw new Error('Request failed with status code 400 (HTTP 400)');
        }
        this.lastCard = card;
      },
    };
    await producer(controller);
    return controller.messageId;
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    this.lastMessageId = messageId;
    this.lastCard = card;
    // 模拟飞书 API 拒绝超大卡片
    const size = Buffer.byteLength(JSON.stringify(card), 'utf8');
    if (size > 28_000) {
      throw Object.assign(new Error('Request failed with status code 400 (HTTP 400)'), {
        response: { status: 400 },
      });
    }
  }
}

// 创建一个 CardSession 子类用于测试
class TestCardSession extends CardSession<{ value: string }, {}> {
  protected get logPrefix(): string {
    return '[test]';
  }
  protected get errorPrefix(): string {
    return 'test';
  }

  protected renderCard(state: { value: string }, _options: {}): object {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { template: 'green', title: { content: 'Test', tag: 'plain_text' } },
      body: {
        elements: [{ tag: 'div', text: { content: state.value, tag: 'lark_md' } }],
      },
    };
  }

  // 暴露 protected 方法用于测试
  async testUpdateCard() {
    await this.updateCard();
  }

  // 便于测试设置 state
  setState(state: { value: string }) {
    this.state = state;
  }

  // 便于测试获取 messageId
  getMessageId() {
    return this.messageId;
  }
}

describe('cardsession-card-budget-enforcement', () => {
  let mockChannel: MockCardChannel;
  let session: TestCardSession;

  beforeEach(() => {
    mockChannel = new MockCardChannel();
    session = new TestCardSession({ value: '' }, { connector: mockChannel, chatId: 'test-chat' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Anchor: test_anchor_cardsession_update_enforces_budget
   *
   * 验证：CardSession.updateCard() 应该在发送前对卡片应用 enforceCardBudget，
   * 以避免因卡片体积超限导致 HTTP 400 错误。
   *
   * 当前行为（bug）：updateCard 直接发送原始卡片，未做 budget 检查
   * 期望行为：updateCard 调用 enforceCardBudget 后再发送
   */
  it('test_anchor_cardsession_update_enforces_budget', async () => {
    // 设置超大 state（超过飞书限制）
    session.setState({ value: 'x'.repeat(300_000) });

    // 启动 session 以获取 messageId
    await session.start();
    const msgId = session.getMessageId();
    expect(msgId).toBeDefined();

    // 尝试更新卡片 - 应该通过 budget 保护避免 400 错误
    // 当前行为：会抛出 400 错误
    // 期望行为：应该成功（因为 enforceCardBudget 会截断）
    await session.testUpdateCard();

    // 验证卡片被发送了
    expect(mockChannel.lastCard).toBeDefined();

    // 验证发送的卡片体积在限制内（budget enforcement 生效）
    const sentSize = Buffer.byteLength(JSON.stringify(mockChannel.lastCard), 'utf8');
    expect(sentSize).toBeLessThan(28_000);
  });
});
