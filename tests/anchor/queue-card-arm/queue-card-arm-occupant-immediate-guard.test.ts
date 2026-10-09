import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanupQueueTestContext,
  makeQueueTestContext,
  type QueueTestContext,
} from '../../lib/queue-scenario.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

let ctx: QueueTestContext;

beforeEach(() => {
  ctx = makeQueueTestContext();
});

afterEach(() => {
  cleanupQueueTestContext(ctx);
});

describe('queue.immediate 在 Compact 占 lane 期间被拒绝（anchor）', () => {
  it('test_anchor_queue_immediate_refused_while_compact_occupies_lane', async () => {
    // 验证什么行为：正在压缩会话时点「立即执行」，不触发 interruptCurrentRun
    // （压缩也注册在 activeRuns 里，会被一并杀掉），目标消息保持排队，用户收到
    // 可见反馈。
    //
    // 缺失会导致什么问题：卡片渲染层把按钮置灰只挡得住"看完新卡片的人"；
    // 改动前渲染的旧卡片按钮仍可点，一点就杀掉正在跑的压缩（浪费已花的压缩
    // 时间与 token）。执行层守卫是这条路径的兜底。
    const { bridge, router, connector, tmpDir } = ctx;

    let compactFinished = false;
    let releaseCompact: () => void = () => {};
    const compactHang = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await compactHang;
        compactFinished = true;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'card-compact-1',
          feishuReplyTo: 'om-compact-card',
          messagePreview: 'card action: compact',
          editable: false,
          kind: 'compact',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.getQueueExecutingInfo(tmpDir)?.kind).toBe('compact');

    // 用户消息排在压缩后面
    bridge.enqueue(tmpDir, async () => {}, {
      taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-2', messagePreview: '用户消息' },
    });
    await new Promise((r) => setTimeout(r, 50));

    const interruptSpy = vi.spyOn(bridge, 'interruptCurrentRun');
    await router.handleCardAction(
      { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' },
      { userId: 'u1', chatId: 'c1', messageId: 'om-user-card' },
    );

    expect(interruptSpy).not.toHaveBeenCalled();
    expect(compactFinished).toBe(false);
    expect(bridge.getQueueExecutingInfo(tmpDir)?.kind).toBe('compact');
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeDefined();

    const texts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');
    expect(texts.some((t) => t.includes('正在压缩会话'))).toBe(true);

    releaseCompact();
    await new Promise((r) => setTimeout(r, 100));
    expect(compactFinished).toBe(true);
  });
});
