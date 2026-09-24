/**
 * InboundTurnAssembler 测试（B3 核心：图/文任意顺序 → 同一个 turn）。
 *
 * 用 vitest fake timers 驱动 700ms 静默期窗口；媒体下载用可控 promise 模拟
 * in-flight（这正是「先图后文」在慢下载下会丢图的路径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InboundTurnAssembler } from './turn-assembler.js';
import type { InboundAttachment, InboundTurn, MediaOutcome } from './turn.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const ATTACHMENT: InboundAttachment = {
  path: '/tmp/20260915/image_220934_1.png',
  kind: 'image',
  sourceMsgId: 'm-img',
};

interface Harness {
  assembler: InboundTurnAssembler;
  commits: Array<{ turn: InboundTurn; prompt: string }>;
  receipts: Array<{ messageId: string; text: string }>;
}

function makeAssembler(overrides: { windowMs?: number } = {}): Harness {
  const commits: Harness['commits'] = [];
  const receipts: Harness['receipts'] = [];
  const assembler = new InboundTurnAssembler({
    windowMs: overrides.windowMs,
    onCommit: (turn, prompt) => {
      commits.push({ turn, prompt });
    },
    onReceipt: (ctx, text) => {
      receipts.push({ messageId: ctx.messageId, text });
    },
  });
  return { assembler, commits, receipts };
}

/** 用 deferred 模拟媒体下载在途。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mediaOutcome(attachments: InboundAttachment[]): MediaOutcome {
  return { attachments, rejected: [] };
}

const textEvent = (messageId: string, text: string, placeholders: never[] = []) => ({
  kind: 'text' as const,
  userId: 'u1',
  chatId: 'c1',
  messageId,
  rawContentType: 'text',
  text,
  placeholders,
  unknownTags: [],
});

const mediaEvent = (messageId: string, outcome: Promise<MediaOutcome>) => ({
  kind: 'media' as const,
  userId: 'u1',
  chatId: 'c1',
  messageId,
  rawContentType: 'image',
  outcome,
});

beforeEach(() => {
  vi.useFakeTimers();
  mockLogger.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InboundTurnAssembler：图/文任意顺序等价', () => {
  it('图→文 与 文→图 产出完全相同的 prompt', async () => {
    // 图在前
    const a = makeAssembler();
    a.assembler.ingest(mediaEvent('m-img', Promise.resolve(mediaOutcome([ATTACHMENT]))));
    a.assembler.ingest(textEvent('m-text', 'test'));
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTimersAsync();

    // 文在前
    const b = makeAssembler();
    b.assembler.ingest(textEvent('m-text', 'test'));
    b.assembler.ingest(mediaEvent('m-img', Promise.resolve(mediaOutcome([ATTACHMENT]))));
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTimersAsync();

    expect(a.commits).toHaveLength(1);
    expect(b.commits).toHaveLength(1);
    expect(a.commits[0].prompt).toBe(b.commits[0].prompt);
    expect(a.commits[0].prompt).toBe(
      'test\n\n<attachments>\n  <file path="/tmp/20260915/image_220934_1.png" kind="image"/>\n</attachments>',
    );
    // 一个用户意图 = 一个 turn，两个 messageId 都记在 turn 上
    expect(a.commits[0].turn.messageIds.sort()).toEqual(['m-img', 'm-text']);
  });

  it('图→文→图 仍然只有一个 turn', async () => {
    const h = makeAssembler();
    h.assembler.ingest(mediaEvent('m1', Promise.resolve(mediaOutcome([ATTACHMENT]))));
    h.assembler.ingest(textEvent('m2', 'test'));
    h.assembler.ingest(
      mediaEvent(
        'm3',
        Promise.resolve(
          mediaOutcome([
            { path: '/tmp/20260915/image_220935_2.png', kind: 'image', sourceMsgId: 'm3' },
          ]),
        ),
      ),
    );
    await vi.advanceTimersByTimeAsync(700);

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].turn.attachments.map((x) => x.path)).toEqual([
      ATTACHMENT.path,
      '/tmp/20260915/image_220935_2.png',
    ]);
  });
});

describe('InboundTurnAssembler：窗口与 in-flight 语义', () => {
  it('任何事件到达都重置静默期窗口', async () => {
    const h = makeAssembler();
    h.assembler.ingest(textEvent('m1', 'A'));
    await vi.advanceTimersByTimeAsync(500);
    h.assembler.ingest(textEvent('m2', 'B'));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.commits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].turn.texts).toEqual(['A', 'B']);
    expect(h.commits[0].turn.commitReason).toBe('idle');
  });

  it('下载未完成不提交：窗口到期后等 in-flight 落定', async () => {
    const h = makeAssembler();
    const d = deferred<MediaOutcome>();
    h.assembler.ingest(textEvent('m-text', '看这张图'));
    h.assembler.ingest(mediaEvent('m-img', d.promise));

    await vi.advanceTimersByTimeAsync(700);
    expect(h.commits).toHaveLength(0);

    d.resolve(mediaOutcome([ATTACHMENT]));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].prompt).toContain('/tmp/20260915/image_220934_1.png');
  });

  it('下载失败 → 进 rejected，其它内容照常提交并回执', async () => {
    const h = makeAssembler();
    const d = deferred<MediaOutcome>();
    h.assembler.ingest(textEvent('m-text', '看这张图'));
    h.assembler.ingest(mediaEvent('m-img', d.promise));
    await vi.advanceTimersByTimeAsync(700);

    d.reject(new Error('timed out after 300000ms'));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].turn.rejected).toEqual([
      { kind: 'file', reason: '下载失败: timed out after 300000ms', sourceMsgId: 'm-img' },
    ]);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0].text).toContain('⚠️ 下载失败: timed out after 300000ms');
  });

  it('无文本纯附件：不 commit，只发引导回执（决策 2）', async () => {
    const h = makeAssembler();
    h.assembler.ingest(mediaEvent('m-img', Promise.resolve(mediaOutcome([ATTACHMENT]))));
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTimersAsync();

    expect(h.commits).toHaveLength(0);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0].text).toContain('📎 已保存 1 个文件');
    expect(h.receipts[0].text).toContain('💡 说一句话我就开始处理');
    expect(h.receipts[0].messageId).toBe('m-img');
  });

  it('不支持类型（占位符）不进 agent，只回执', async () => {
    const h = makeAssembler();
    h.assembler.ingest(textEvent('m1', '', ['location'] as never));
    await vi.advanceTimersByTimeAsync(700);

    expect(h.commits).toHaveLength(0);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0].text).toBe('⚠️ 暂不支持位置消息');
  });

  it('可下载占位符（图/文件/视频/语音/表情）不产生假的「不支持」回执', async () => {
    const h = makeAssembler();
    h.assembler.ingest(textEvent('m-text', '看这个', ['image', 'file'] as never));
    h.assembler.ingest(mediaEvent('m-img', Promise.resolve(mediaOutcome([ATTACHMENT]))));
    await vi.advanceTimersByTimeAsync(700);

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].turn.rejected).toEqual([]);
    expect(h.receipts).toHaveLength(0);
  });

  it('不同 (userId, chatId) 分桶，互不影响', async () => {
    const h = makeAssembler();
    h.assembler.ingest(textEvent('m1', 'A'));
    h.assembler.ingest({ ...textEvent('m2', 'B'), userId: 'u2' });
    await vi.advanceTimersByTimeAsync(700);
    expect(h.commits).toHaveLength(2);
    expect(h.commits.map((c) => c.turn.userId).sort()).toEqual(['u1', 'u2']);
  });
});

describe('InboundTurnAssembler：命令旁路与 flush', () => {
  it('flush 强制提交窗口内已装配内容（命令到达场景）', async () => {
    const h = makeAssembler();
    h.assembler.ingest(textEvent('m1', '先说的'));
    await h.assembler.flush('u1', 'c1', 'flush');
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].turn.commitReason).toBe('flush');
    // 窗口内已装配内容被冲刷后，后续消息开新 turn
    h.assembler.ingest(textEvent('m2', '后说的'));
    await vi.advanceTimersByTimeAsync(700);
    expect(h.commits).toHaveLength(2);
    expect(h.commits[1].turn.texts).toEqual(['后说的']);
  });

  it('flush 时仍有 in-flight 下载 → 等它落定再提交（路径不丢）', async () => {
    const h = makeAssembler();
    const d = deferred<MediaOutcome>();
    h.assembler.ingest(textEvent('m-text', '看这张图'));
    h.assembler.ingest(mediaEvent('m-img', d.promise));

    const flushed = h.assembler.flush('u1', 'c1', 'flush');
    let done = false;
    void flushed.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);

    d.resolve(mediaOutcome([ATTACHMENT]));
    await flushed;
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].prompt).toContain(ATTACHMENT.path);
  });

  it('flushAll 冲刷全部桶（/exit、/restart 退出前）', async () => {
    const h = makeAssembler();
    h.assembler.ingest(textEvent('m1', 'A'));
    h.assembler.ingest({ ...textEvent('m2', 'B'), userId: 'u2', chatId: 'c2' });
    await h.assembler.flushAll('flush');
    expect(h.commits).toHaveLength(2);
  });

  it('dispose 后不再接收事件', async () => {
    const h = makeAssembler();
    h.assembler.dispose();
    h.assembler.ingest(textEvent('m1', 'A'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.commits).toHaveLength(0);
  });

  it('onCommit 抛错不炸进程（记 error 日志）', async () => {
    const assembler = new InboundTurnAssembler({
      onCommit: () => {
        throw new Error('boom');
      },
    });
    assembler.ingest(textEvent('m1', 'A'));
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTimersAsync();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe('InboundTurnAssembler：可注入时钟', () => {
  it('setTimer/clearTimer 注入生效（不依赖全局定时器）', async () => {
    const tasks: Array<() => void> = [];
    const assembler = new InboundTurnAssembler({
      windowMs: 10,
      setTimer: (fn) => {
        tasks.push(fn);
        return tasks.length;
      },
      clearTimer: () => {},
      onCommit: () => {},
    });
    assembler.ingest(textEvent('m1', 'A'));
    expect(tasks).toHaveLength(1);
    tasks[0]();
    await Promise.resolve();
    expect(tasks).toHaveLength(1);
  });
});
