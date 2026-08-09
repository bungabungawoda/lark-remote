import { describe, expect, it } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from './run-card-session.js';

describe('RunCardSession', () => {
  it('test_anchor_start_resolves_when_controller_is_ready_not_when_producer_finishes', async () => {
    let producerFinished = false;
    const updates: object[] = [];
    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async (card) => {
        updates.push(typeof card === 'function' ? card({}) : card);
      },
    };
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        producerFinished = true;
        return 'card-1';
      },
      updateCard: async () => {},
    };
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-1',
    });

    await session.start();
    expect(producerFinished).toBe(false);
    await session.finish('done', { resultSubtype: 'success' });
    expect(await session.settle()).toBe('streamed');
    expect(producerFinished).toBe(true);
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it('test_anchor_failure_after_initial_updates_original_card', async () => {
    const updated: Array<{ messageId: string; card: object }> = [];
    const controller: CardStreamController = {
      messageId: 'card-2',
      current: {},
      update: async () => {},
    };
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
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-2',
    });

    await session.start();
    await session.finish('error', { errorMsg: 'boom' });
    expect(await session.settle()).toBe('updated');
    expect(updated[0]?.messageId).toBe('card-2');
  });

  it('test_anchor_start_timeout_does_not_block_the_run_forever', async () => {
    const connector = {
      streamCard: async () => await new Promise<string>(() => {}),
      updateCard: async () => {},
    };
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-timeout',
      startTimeoutMs: 5,
      settleTimeoutMs: 5,
    });

    await expect(session.start()).rejects.toThrow('card stream start timeout');
    await session.finish('error', { errorMsg: 'fallback' });
    expect(await session.settle()).toBe('unsent');
  });

  // P3-7 (rejected): the two safeRenderCard() calls in start() look redundant
  // (same state), but they are NOT — the streamCard `initial` payload renders
  // EAGERLY at start time, while the producer's first controller.update
  // renders LAZILY after the controller is ready. Events pushed in between
  // (before the producer runs) update `this.state`, so the lazy render captures
  // them while the eager initial does not. This anchor locks that invariant:
  // the initial payload and the first update are DIFFERENT objects (proving two
  // distinct render moments), and an event pushed before the producer runs
  // appears in the first update but NOT in the initial payload. Reusing the
  // initial card (the proposed P3-7 optimization) would drop early events.
  it('test_anchor_start_two_rerenders_captures_early_event_second_render_distinct', async () => {
    let initialCard: object | undefined;
    let beginProducer!: () => void;
    const gate = new Promise<void>((resolve) => {
      beginProducer = resolve;
    });
    const updates: object[] = [];
    const controller: CardStreamController = {
      messageId: 'card-distinct',
      current: {},
      update: async (card) => {
        updates.push(typeof card === 'function' ? card({}) : card);
      },
    };
    const connector = {
      streamCard: async (
        _chatId: string,
        initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        initialCard = initial;
        await gate;
        await producer(controller);
        return 'card-distinct';
      },
      updateCard: async () => {},
    };
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-distinct',
      startTimeoutMs: 100,
    });

    const start = session.start();
    // Push an event BEFORE the producer runs (initial payload already captured).
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'arrived early' }] },
    });
    beginProducer();
    await start;

    // The initial payload (eager, pre-event) must NOT contain the early event.
    expect(JSON.stringify(initialCard)).not.toContain('arrived early');
    // The first controller.update (lazy, post-event) MUST contain it.
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(updates[0])).toContain('arrived early');
    // And the two are distinct render objects (not reused).
    expect(updates[0]).not.toBe(initialCard);

    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });

  it('test_anchor_events_before_controller_ready_are_rendered_when_stream_starts', async () => {
    let beginProducer!: () => void;
    const gate = new Promise<void>((resolve) => {
      beginProducer = resolve;
    });
    const updates: object[] = [];
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await gate;
        await producer({
          messageId: 'card-late',
          current: {},
          update: async (next) => {
            updates.push(typeof next === 'function' ? next({}) : next);
          },
        });
        return 'card-late';
      },
      updateCard: async () => {},
    };
    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      runId: 'run-late',
      startTimeoutMs: 100,
    });

    const start = session.start();
    await session.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'arrived early' }] },
    });
    beginProducer();
    await start;
    expect(JSON.stringify(updates.at(-1))).toContain('arrived early');
    await session.finish('done', { resultSubtype: 'success' });
    await session.settle();
  });
});
