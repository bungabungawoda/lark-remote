/**
 * Anchor Test: KimiRunner 不会对 assistant text content 重复 emit
 *
 * 验证 KimiRunner.run() 在处理 assistant content 时，每段文本只 yield 一次，
 * 不会因为 pendingTextContent 机制导致重复输出。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KimiRunner } from '../../../src/runner/kimi/index.js';
import type { AgentEvent } from '../../../src/runner/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

function makeFakeProcess(events: object[]): any {
  const emitter = new EventEmitter();

  process.nextTick(() => {
    for (const evt of events) {
      const line = JSON.stringify(evt);
      emitter.emit('data', Buffer.from(line + '\n'));
    }
    emitter.emit('end');
  });

  return {
    pid: 99999,
    exitCode: null,
    signalCode: null,
    stdout: emitter,
    stderr: { on: vi.fn(), destroy: vi.fn() },
    kill: vi.fn(),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(0, null), 20);
      }
    }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

describe('KimiRunner.run() no duplicate text emission', () => {
  let runner: KimiRunner;

  beforeEach(() => {
    runner = new KimiRunner({ workspace: 'test' });
  });

  it('test_anchor_kimi_no_duplicate_text_on_assistant_content', async () => {
    const fakeProc = makeFakeProcess([
      { role: 'meta', type: 'session.resume_hint', session_id: 'sess-1', command: '', content: '' },
      { role: 'assistant', content: 'Hello world' },
    ]);

    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReturnValue(fakeProc);

    const events: AgentEvent[] = [];
    for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
      events.push(event);
    }

    const textEvents = events.filter(
      (e) =>
        e.type === 'assistant' &&
        'message' in e &&
        Array.isArray((e as any).message?.content) &&
        (e as any).message.content.some((c: any) => c.type === 'text'),
    );

    // There should be exactly 1 text event
    expect(textEvents.length).toBe(1);

    const textContent = (textEvents[0] as any).message.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
    expect(textContent).toBe('Hello world');
  });

  it('test_anchor_kimi_two_assistant_messages_no_duplicate', async () => {
    const fakeProc = makeFakeProcess([
      { role: 'meta', type: 'session.resume_hint', session_id: 'sess-2', command: '', content: '' },
      { role: 'assistant', content: 'First message' },
      { role: 'assistant', content: 'Second message' },
    ]);

    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReturnValue(fakeProc);

    const events: AgentEvent[] = [];
    for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
      events.push(event);
    }

    const textEvents = events.filter(
      (e) =>
        e.type === 'assistant' &&
        'message' in e &&
        Array.isArray((e as any).message?.content) &&
        (e as any).message.content.some((c: any) => c.type === 'text'),
    );

    // Bug confirmed: 3 events instead of 2 (duplicate of second message)
    expect(textEvents.length).toBe(2);

    const texts = textEvents.map((e) =>
      (e as any).message.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join(''),
    );
    expect(texts).toEqual(['First message', 'Second message']);
  });
});
