/**
 * Characterization 钉子：openMuxStream 的 onerror 描述提取（describeSocketError
 * 全分支）与基本帧流 / 错误终态。0% 覆盖函数拆分前先钉住行为。
 *
 * 全程使用脚本化 fake socket，不建立真实 WebSocket 连接。
 */
import { describe, it, expect } from 'vitest';
import { openMuxStream, type OpenMuxStreamOptions } from './mux-stream.js';

class FakeSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onunexpectedresponse: ((event: { statusCode?: number }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  fireOpen(): void {
    this.onopen?.({});
  }
  fireError(event: unknown): void {
    this.onerror?.(event);
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  fireUnexpected(statusCode?: number): void {
    this.onunexpectedresponse?.({ statusCode });
  }
}

function opts(
  socket: FakeSocket,
  signal: AbortSignal,
  requestTimeoutMs = 60_000,
): OpenMuxStreamOptions {
  return {
    baseUrl: 'http://127.0.0.1:1',
    endpoint: 'session/follow',
    payload: { args: {} },
    signal,
    requestTimeoutMs,
    authCookie: async () => undefined,
    webSocketFactory: () => socket,
  };
}

/** 等 generator 跑过 `await authCookie()` 并注册好 socket handlers。 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 触发一次 onerror，返回 generator 抛出的错误消息（或 '<no error>'）。 */
async function errorMessageFor(event: unknown): Promise<string> {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const gen = openMuxStream(opts(socket, controller.signal));
  const next = gen.next();
  await tick();
  socket.fireOpen();
  socket.fireError(event);
  try {
    await next;
    return '<no error>';
  } catch (err) {
    return (err as Error).message;
  } finally {
    await gen.return(undefined).catch(() => {});
  }
}

const NO_DETAIL = 'DSH remote mux WebSocket error';

describe('openMuxStream / describeSocketError (characterization)', () => {
  it('non-object events carry no detail', async () => {
    await expect(errorMessageFor(undefined)).resolves.toBe(NO_DETAIL);
    await expect(errorMessageFor(null)).resolves.toBe(NO_DETAIL);
    await expect(errorMessageFor(42)).resolves.toBe(NO_DETAIL);
    await expect(errorMessageFor('boom')).resolves.toBe(NO_DETAIL);
  });

  it('empty object carries no detail', async () => {
    await expect(errorMessageFor({})).resolves.toBe(NO_DETAIL);
  });

  it('message string wins', async () => {
    await expect(errorMessageFor({ message: 'boom' })).resolves.toBe(`${NO_DETAIL}: boom`);
  });

  it('empty message falls through to the next extractor', async () => {
    await expect(errorMessageFor({ message: '', type: 'etype' })).resolves.toBe(
      `${NO_DETAIL}: etype`,
    );
  });

  it('Error instance message is used', async () => {
    await expect(errorMessageFor({ error: new Error('inner') })).resolves.toBe(
      `${NO_DETAIL}: inner`,
    );
  });

  it('error string is used', async () => {
    await expect(errorMessageFor({ error: 'strerr' })).resolves.toBe(`${NO_DETAIL}: strerr`);
  });

  it('type string is used as last resort', async () => {
    await expect(errorMessageFor({ type: 'etype' })).resolves.toBe(`${NO_DETAIL}: etype`);
  });

  it('extractor precedence: message > error > type', async () => {
    await expect(
      errorMessageFor({ message: 'm', error: new Error('inner'), type: 'etype' }),
    ).resolves.toBe(`${NO_DETAIL}: m`);
    await expect(errorMessageFor({ error: 'strerr', type: 'etype' })).resolves.toBe(
      `${NO_DETAIL}: strerr`,
    );
  });

  it('yields item frames in order and ends on the end frame', async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const gen = openMuxStream(opts(socket, controller.signal));
    const collected: unknown[] = [];
    const consuming = (async () => {
      for await (const value of gen) collected.push(value);
    })();

    await tick();
    socket.fireOpen();
    const openFrame = JSON.parse(socket.sent[0]) as { type: string; streamId: string };
    expect(openFrame.type).toBe('open');

    socket.fireMessage(
      JSON.stringify({ type: 'item', streamId: openFrame.streamId, value: { n: 1 } }),
    );
    await tick();
    socket.fireMessage(
      JSON.stringify({ type: 'item', streamId: openFrame.streamId, value: { n: 2 } }),
    );
    await tick();
    // 错误 streamId 的帧必须被忽略
    socket.fireMessage(JSON.stringify({ type: 'item', streamId: 'other', value: { n: 99 } }));
    socket.fireMessage('not json');
    socket.fireMessage(JSON.stringify({ type: 'end', streamId: openFrame.streamId }));
    await consuming;

    expect(collected).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('connect timeout rejects with a transport DshError', async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const gen = openMuxStream(opts(socket, controller.signal, 5));
    await expect(gen.next()).rejects.toMatchObject({
      code: 'transport',
      message: 'DSH remote mux WebSocket connect timeout',
    });
  });

  it('unexpected HTTP response rejects with an http DshError carrying status', async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const gen = openMuxStream(opts(socket, controller.signal));
    const next = gen.next();
    await tick();
    socket.fireUnexpected(503);
    await expect(next).rejects.toMatchObject({
      code: 'http',
      message: 'DSH remote mux WebSocket HTTP 503',
    });
  });
});
