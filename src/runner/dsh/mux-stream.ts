import { getLogger } from '../../logger/index.js';
import { DshError } from './errors.js';

interface MuxSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onunexpectedresponse?: ((event: { statusCode?: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface OpenMuxStreamOptions {
  baseUrl: string;
  endpoint: string;
  payload: unknown;
  signal: AbortSignal;
  requestTimeoutMs: number;
  authCookie(): Promise<string | undefined>;
  webSocketFactory(url: string, options?: { headers?: Record<string, string> }): MuxSocket;
}

export async function* openMuxStream(opts: OpenMuxStreamOptions): AsyncGenerator<unknown> {
  const cookie = await opts.authCookie();
  const socket = opts.webSocketFactory(
    `${opts.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`,
    cookie ? { headers: { cookie } } : undefined,
  );
  const streamId = `lr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const queue: unknown[] = [];
  let waiter: ((frame: unknown | undefined) => void) | null = null;
  let ended = false;
  let failure: DshError | undefined;
  let opened = false;

  const settle = (frame?: unknown): void => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(frame);
      return;
    }
    if (frame) queue.push(frame);
    else ended = true;
  };

  const connectTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (opened || ended) return;
    failure = new DshError('transport', 'DSH remote mux WebSocket connect timeout');
    ended = true;
    settle(undefined);
    try {
      socket.close();
    } catch {
      /* ignore close error */
    }
  }, opts.requestTimeoutMs);
  connectTimer.unref?.();

  socket.onopen = () => {
    opened = true;
    clearTimeout(connectTimer);
    if (ended) return;
    try {
      socket.send(
        JSON.stringify({
          type: 'open',
          streamId,
          endpoint: opts.endpoint,
          payload: opts.payload,
        }),
      );
    } catch (err) {
      failure = new DshError('transport', `DSH remote mux send error: ${(err as Error).message}`);
      ended = true;
      settle(undefined);
    }
  };
  socket.onmessage = (event) => {
    if (ended) return;
    const text =
      typeof event.data === 'string'
        ? event.data
        : Buffer.isBuffer(event.data)
          ? event.data.toString('utf8')
          : String(event.data);
    let message: {
      type?: string;
      streamId?: string;
      value?: unknown;
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      getLogger().warn('[dsh] dropped malformed remote mux frame');
      return;
    }
    if (message.streamId !== streamId) return;
    if (message.type === 'item' && message.value) {
      settle(message.value);
      return;
    }
    if (message.type === 'end') {
      ended = true;
      settle(undefined);
      return;
    }
    if (message.type === 'error') {
      failure = new DshError(
        message.error?.code ?? 'stream',
        message.error?.message ?? 'DSH remote stream failed',
        message.error?.details ?? {},
      );
      ended = true;
      settle(undefined);
    }
  };
  socket.onerror = () => {
    if (ended) return;
    failure = new DshError('transport', 'DSH remote mux WebSocket error');
    ended = true;
    settle(undefined);
  };
  socket.onunexpectedresponse = (event) => {
    if (ended) return;
    const status = event.statusCode;
    failure = new DshError(
      'http',
      `DSH remote mux WebSocket HTTP ${status === undefined ? 'error' : status}`,
      status === undefined ? {} : { status },
    );
    ended = true;
    settle(undefined);
  };
  socket.onclose = () => {
    if (ended) return;
    ended = true;
    settle(undefined);
  };

  const onAbort = (): void => {
    if (ended) return;
    ended = true;
    settle(undefined);
    try {
      socket.close();
    } catch {
      /* ignore close error */
    }
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  const next = (): Promise<unknown | undefined> =>
    new Promise((resolve) => {
      if (queue.length > 0) {
        resolve(queue.shift());
        return;
      }
      if (ended) {
        resolve(undefined);
        return;
      }
      waiter = resolve;
    });

  try {
    while (!opts.signal.aborted) {
      const frame = await next();
      if (frame === undefined) {
        if (failure && !opts.signal.aborted) throw failure;
        return;
      }
      yield frame;
    }
  } finally {
    clearTimeout(connectTimer);
    opts.signal.removeEventListener('abort', onAbort);
    try {
      socket.close();
    } catch {
      /* ignore close error */
    }
  }
}
