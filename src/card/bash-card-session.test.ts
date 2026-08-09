import { describe, expect, it, vi, afterEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { BashCardSession, BASH_OUTPUT_STORE_CAP } from './bash-card-session.js';

function makeController(capture: { updates: object[] }): CardStreamController {
  return {
    messageId: 'card-1',
    current: {},
    update: async (card) => {
      capture.updates.push(typeof card === 'function' ? card({}) : card);
    },
  };
}

function makeConnector(controller: CardStreamController, opts: { throwOnStream?: boolean } = {}) {
  return {
    streamCard: async (
      _chatId: string,
      _initial: object,
      producer: (ctrl: CardStreamController) => Promise<void>,
    ) => {
      await producer(controller);
      if (opts.throwOnStream) throw new Error('complete failed');
      return 'card-1';
    },
    updateCard: async () => {},
  };
}

describe('BashCardSession', () => {
  it('streams a single card: start → update → finish → settle (one message, multiple patches)', async () => {
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'bash-1',
      command: 'echo hi',
    });

    await session.start();
    // Initial running card already pushed via controller.update
    expect(capture.updates.length).toBeGreaterThanOrEqual(1);

    await session.update({ output: 'hi\n' });
    await session.finish('done', { exitCode: 0 });

    const result = await session.settle();
    expect(result).toBe('streamed');

    // Single card identity: multiple patches flowed through ONE controller
    // (initial running → output → done), NOT three independent cards.
    expect(capture.updates.length).toBeGreaterThanOrEqual(2);
    // Final patch is the done state
    const last = capture.updates.at(-1) as { header?: { title?: { content?: string } } };
    expect(JSON.stringify(last)).toContain('命令执行完成');
    // runId appears in the initial running card's stop button value
    expect(JSON.stringify(capture.updates[0])).toContain('bash-1');
  });

  it('falls back to updateCard when the stream fails to complete', async () => {
    const updated: Array<{ messageId: string; card: object }> = [];
    const controller = makeController({ updates: [] });
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        throw new Error('complete failed');
      },
      updateCard: async (messageId: string, card: object) => {
        updated.push({ messageId, card });
      },
    };

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'bash-2',
      command: 'echo hi',
    });

    await session.start();
    await session.finish('error', { exitCode: 1, stderr: 'boom' });
    expect(await session.settle()).toBe('updated');
    expect(updated[0]?.messageId).toBe('card-1');
  });
});

describe('BashCardSession coalescing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesceMs=0: each update triggers immediate flush', async () => {
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-imm',
      command: 'echo hi',
      coalesceMs: 0,
    });

    await session.start();
    const updatesBefore = capture.updates.length;

    await session.update({ output: 'line1\n' });
    // With coalesceMs=0, flush is called immediately inside update()
    expect(capture.updates.length).toBeGreaterThan(updatesBefore);

    await session.finish('done', { exitCode: 0 });
    await session.settle();
  });

  it('rapid sequential updates are coalesced into a single flush', async () => {
    vi.useFakeTimers();
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-coal',
      command: 'echo hi',
      coalesceMs: 100,
    });

    await session.start();
    const updatesAfterStart = capture.updates.length;

    // Two rapid updates within the coalesce window
    await session.update({ output: 'line1\n' });
    await session.update({ output: 'line2\n' });

    // Before the timer fires, only start updates have happened
    expect(capture.updates.length).toBe(updatesAfterStart);

    // Advance timer to trigger flush
    vi.advanceTimersByTime(150);

    // After timer, exactly one flush should have rendered the merged state
    expect(capture.updates.length).toBeGreaterThan(updatesAfterStart);

    await session.finish('done', { exitCode: 0 });
    await session.settle();
    vi.useRealTimers();
  });

  it('pendingReschedule: update during in-flight flush triggers re-render after completion', async () => {
    // Real timers + short coalesceMs. A conditional-block controller lets us
    // observe the pendingReschedule → re-schedule cycle without fake timers.
    const flushLog: string[] = [];
    let blockFlush = false;
    let flushBlockedResolve: () => void = () => {};

    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async () => {
        if (blockFlush) {
          await new Promise<void>((r) => {
            flushBlockedResolve = r;
          });
        }
        flushLog.push('update');
      },
    };

    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-1';
      },
      updateCard: async () => {
        flushLog.push('updateCard');
      },
    };

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-resched',
      command: 'echo hi',
      coalesceMs: 10,
    });

    // start() calls controller.update once inside the producer — should NOT block
    await session.start();
    const updateCountAfterStart = flushLog.length;

    // Now block subsequent flushes
    blockFlush = true;

    // First update: triggers coalesce timer → flush starts, but blocks
    await session.update({ output: 'line1\n' });
    // Wait for coalesce timer to fire → flush enters but blocks on controller.update
    await new Promise((r) => setTimeout(r, 30));

    // While flush is in-flight, another update arrives → pendingReschedule = true
    await session.update({ output: 'line2\n' });

    // Unblock the in-flight flush AND allow subsequent flushes to complete
    blockFlush = false;
    flushBlockedResolve();
    flushBlockedResolve = () => {};
    // Let microtasks settle + rescheduled timer fire + new flush complete
    await new Promise((r) => setTimeout(r, 60));

    // At least one flush happened after unblocking (the rescheduled one)
    expect(flushLog.length).toBeGreaterThan(updateCountAfterStart);

    await session.finish('done', { exitCode: 0 });
    await session.settle();
  });

  it('finish awaits in-flight flush before sending terminal patch', async () => {
    // Real timers + short coalesce — conditional-block controller
    const flushOrder: string[] = [];
    let blockFlush = false;
    let flushBlockedResolve: () => void = () => {};

    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async () => {
        if (blockFlush) {
          flushOrder.push('controller-update-blocked');
          await new Promise<void>((r) => {
            flushBlockedResolve = r;
          });
        }
        flushOrder.push('controller-update');
      },
    };

    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-1';
      },
      updateCard: async () => {
        flushOrder.push('updateCard-fallback');
      },
    };

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-await',
      command: 'echo hi',
      coalesceMs: 10,
    });

    // start() completes normally (no block yet)
    await session.start();
    // start() calls controller.update once
    expect(flushOrder).toContain('controller-update');

    // Block subsequent flushes
    blockFlush = true;
    await session.update({ output: 'line1\n' });

    // Wait for coalesce timer → flush starts but blocks
    await new Promise((r) => setTimeout(r, 30));

    // Verify the blocked flush started
    expect(flushOrder).toContain('controller-update-blocked');

    // finish() should wait for the in-flight flush
    const finishP = session.finish('done', { exitCode: 0 });

    // Give finish a tick to await flushP
    await new Promise((r) => setTimeout(r, 5));

    // Unblock: allow controller.update to proceed for finish's updateCard too
    blockFlush = false;
    flushBlockedResolve();

    await finishP;

    // After unblocking: the in-flight flush completes, then finish sends
    // the terminal patch. The order must be: blocked flush completes → finish patch.
    // There should be at least two 'controller-update' entries after the blocked one.
    const blockedIdx = flushOrder.indexOf('controller-update-blocked');
    const updatesAfterBlock = flushOrder.slice(blockedIdx + 1);
    // At least: flush-complete controller-update + finish terminal controller-update
    expect(
      updatesAfterBlock.filter((e) => e === 'controller-update').length,
    ).toBeGreaterThanOrEqual(2);

    await session.settle();
  });

  it('cancelPendingFlush: settle cancels pending timer', async () => {
    vi.useFakeTimers();
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-cancel',
      command: 'echo hi',
      coalesceMs: 5000,
    });

    await session.start();
    await session.update({ output: 'line1\n' });

    // Timer is pending — settle should cancel it
    await session.finish('done', { exitCode: 0 });
    const result = await session.settle();

    expect(result).toBe('streamed');
    // No stray timer should fire after settle
    vi.advanceTimersByTime(10000);
    vi.useRealTimers();
  });
});

describe('BashCardSession output capping', () => {
  it('caps output to BASH_OUTPUT_STORE_CAP characters', async () => {
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-cap',
      command: 'cat /dev/urandom',
      coalesceMs: 0,
    });

    await session.start();

    const longOutput = 'x'.repeat(BASH_OUTPUT_STORE_CAP + 5000);
    await session.update({ output: longOutput });

    // After capping, the state output should be ≤ CAP
    expect(session.currentState.output!.length).toBeLessThanOrEqual(BASH_OUTPUT_STORE_CAP);

    await session.finish('done', { exitCode: 0 });
    await session.settle();
  });

  it('caps stderr in finish meta', async () => {
    const capture = { updates: [] as object[] };
    const controller = makeController(capture);
    const connector = makeConnector(controller);

    const session = new BashCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'bash-cap-err',
      command: 'cat /dev/null',
      coalesceMs: 0,
    });

    await session.start();

    const longStderr = 'e'.repeat(BASH_OUTPUT_STORE_CAP + 5000);
    await session.finish('error', { exitCode: 1, stderr: longStderr });

    expect(session.currentState.stderr!.length).toBeLessThanOrEqual(BASH_OUTPUT_STORE_CAP);
    await session.settle();
  });
});
