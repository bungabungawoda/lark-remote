/**
 * Fake DSH Web Host for agent-dsh tests.
 *
 * Mimics the DSH 0.2.x wire protocol:
 *   - POST /api/<method>: body {type:'client-request',rpcId,method,payload},
 *     response {type:'server-response',rpcId,result:{ok:true,value}|{ok:false,error}}.
 *   - Optional auth: GET /?token=... (and the legacy /connect route) sets a
 *     dsh-auth cookie; /api and the WebSocket require it when `requireAuth` is
 *     enabled.
 *   - WebSocket /api/remote.mux: logical `session.follow` streams. Scripted
 *     frames are consumed across reconnects (shared pointer), modelling a
 *     server that drops mid-turn.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeRpcResult {
  ok: true;
  value: unknown;
}

export interface FakeRpcError {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export type FakeUnaryHandler = (payload: unknown, rpcId: string) => FakeRpcResult | FakeRpcError;

export interface DshServerRequestRecord {
  method: string;
  rpcId: string;
  payload: unknown;
}

export class FakeDshServer {
  readonly server: Server;
  private readonly unaryHandlers = new Map<string, FakeUnaryHandler>();
  private muxFrames: Array<object | { close: true }> = [];
  private eventFrames: Array<object | { close: true }> = [];
  private eventStreamError: string | undefined;
  private historyValue: unknown = { records: [], hasMore: false };
  private historySequence: unknown[] = [];
  private projectionValue: unknown = { asOfSeq: 0, values: {} };
  private port = 0;
  private closedConnections = 0;
  private lastEventClientIdValue: string | undefined;
  private requireAuth = false;
  private launchToken = 'test-token';
  private readonly wss = new WebSocketServer({ noServer: true });

  readonly requests: DshServerRequestRecord[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      const url = req.url ?? '';
      const path = url.split('?')[0];

      if (req.method === 'GET' && path === '/') {
        const token = new URL(url, 'http://dsh.invalid').searchParams.get('token');
        if (this.requireAuth && token !== this.launchToken) {
          res.writeHead(401);
          res.end('unauthorized');
          return;
        }
        const authority = req.headers.host ?? '127.0.0.1';
        res.writeHead(303, {
          location: './',
          'set-cookie': `dsh-auth-${authority}=v1.fake; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && path === '/connect') {
        const token = new URL(url, 'http://dsh.invalid').searchParams.get('token');
        if (this.requireAuth && token !== this.launchToken) {
          res.writeHead(401);
          res.end('unauthorized');
          return;
        }
        const authority = req.headers.host ?? '127.0.0.1';
        res.writeHead(302, {
          location: './api/remote.mux',
          'set-cookie': `dsh-auth-${authority}=fake-operator; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }

      if (!path.startsWith('/api/')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      if (this.requireAuth && !this.hasAuthCookie(req.headers.cookie)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: { type?: string; rpcId?: string; method?: string; payload?: unknown } = {};
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          res.writeHead(400);
          res.end('bad request');
          return;
        }
        const method = path.slice('/api/'.length);
        if (body.type !== 'client-request' || !body.rpcId || body.method !== method) {
          res.writeHead(400);
          res.end('bad request');
          return;
        }
        const args = (body.payload as { args?: unknown } | undefined)?.args;
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'server-response',
              rpcId: body.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'gateway/internal',
                  message: 'Remote payload must contain exactly one plain-object args field',
                },
              },
            }),
          );
          return;
        }
        const rpcId = body.rpcId;
        const request =
          (args as { request?: unknown }).request ??
          (args as { _request?: unknown })._request ??
          args;
        this.requests.push({ method, rpcId, payload: request });
        const result = this.dispatch(method, request, rpcId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
      });
    });

    this.server.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== '/api/remote.mux') {
        socket.destroy();
        return;
      }
      if (this.requireAuth && !this.hasAuthCookie(req.headers.cookie)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', (ws) => this.handleMux(ws));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get connectionCount(): number {
    return this.closedConnections;
  }

  /**
   * Client id issued to the most recent `$events` stream. Reconnect tests use it
   * to prove an answer went out on the *current* stream, not a dead one.
   */
  get lastEventClientId(): string | undefined {
    return this.lastEventClientIdValue;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as AddressInfo;
    this.port = addr.port;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // fetch() keeps HTTP keep-alive sockets open; close() alone would wait
      // for them and hang the test process.
      this.server.closeAllConnections?.();
    });
  }

  register(method: string, handler: FakeUnaryHandler): void {
    this.unaryHandlers.set(method, handler);
  }

  /** Enable token auth; the client must complete /connect first. */
  setRequireAuth(requireAuth: boolean, launchToken = 'test-token'): void {
    this.requireAuth = requireAuth;
    this.launchToken = launchToken;
  }

  setMuxFrames(frames: Array<object | { close: true }>): void {
    this.muxFrames = frames;
  }

  /** Append a single frame at response time (real DSH only produces a turn's
   *  events after accepting its prompt) — avoids pre-queued frames racing a
   *  previous run's still-closing mux subscription. */
  pushMuxFrame(frame: object | { close: true }): void {
    this.muxFrames.push(frame);
  }

  setEventFrames(frames: Array<object | { close: true }>): void {
    this.eventFrames = frames;
  }

  /** Append a `$events` frame at response time (waterfall/cancel/close). */
  pushEventFrame(frame: object | { close: true }): void {
    this.eventFrames.push(frame);
  }

  /** Reject the next `$events` open with a Gateway stream error. */
  setEventStreamError(code: string): void {
    this.eventStreamError = code;
  }

  setHistoryValue(value: unknown): void {
    this.historyValue = value;
  }

  /** One snapshot value per follow opening; the last one repeats. */
  setHistorySequence(values: unknown[]): void {
    this.historySequence = [...values];
  }

  setProjectionValue(value: unknown): void {
    this.projectionValue = value;
  }

  /** Synchronous unary dispatch (no HTTP) — used by tests that inject the
   *  reader's sync transport to avoid the spawnSync-in-process deadlock. */
  dispatchSync(
    method: string,
    payload: unknown,
    rpcId = `rpc-${randomUUID()}`,
  ): {
    type: string;
    rpcId: string;
    result: FakeRpcResult | FakeRpcError;
  } {
    this.requests.push({ method, rpcId, payload });
    return {
      type: 'server-response',
      rpcId,
      result: this.dispatch(method, payload, rpcId),
    };
  }

  private dispatch(method: string, payload: unknown, rpcId: string): FakeRpcResult | FakeRpcError {
    const handler = this.unaryHandlers.get(method);
    if (handler) return handler(payload, rpcId);
    switch (method) {
      case 'session/projections':
        return { ok: true, value: this.projectionValue };
      case 'session/page':
        return { ok: true, value: this.historyValue };
      case 'session/list':
        return { ok: true, value: { items: [] } };
      default:
        return { ok: true, value: {} };
    }
  }

  private hasAuthCookie(cookie: string | undefined): boolean {
    return !!cookie?.includes('dsh-auth-');
  }

  private handleMux(ws: WebSocket): void {
    this.closedConnections++;
    let streamId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stopTimer = (): void => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };

    ws.on('message', (raw) => {
      let message: {
        type?: string;
        streamId?: string;
        endpoint?: string;
        payload?: { args?: { address?: { sessionId?: string } } };
      };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'cancel') {
        ws.close();
        return;
      }
      if (message.type !== 'open' || !message.streamId) return;
      streamId = message.streamId;
      if (message.endpoint === '$events') {
        if (this.eventStreamError) {
          ws.send(
            JSON.stringify({
              type: 'error',
              streamId,
              error: {
                code: this.eventStreamError,
                message: 'approval event stream unavailable',
                details: {},
              },
            }),
          );
          return;
        }
        const clientId = `fake-client-${this.closedConnections}`;
        this.lastEventClientIdValue = clientId;
        ws.send(
          JSON.stringify({
            type: 'item',
            streamId,
            value: {
              type: 'ready',
              clientId,
              host: { home: '/home/user' },
            },
          }),
        );
        timer = setInterval(() => {
          if (ws.readyState !== ws.OPEN) {
            stopTimer();
            return;
          }
          const item = this.eventFrames.shift();
          if (item === undefined) return;
          if ('close' in item && item.close === true) {
            stopTimer();
            ws.send(JSON.stringify({ type: 'end', streamId }));
            ws.close();
            return;
          }
          ws.send(JSON.stringify({ type: 'item', streamId, value: item }));
        }, 5);
        return;
      }
      const sessionId = message.payload?.args?.address?.sessionId ?? '';
      const history =
        this.historySequence.length > 0
          ? this.historySequence.length > 1
            ? this.historySequence.shift()
            : this.historySequence[0]
          : this.historyValue;
      const records = this.historyRecords(history);
      const cursor = records.reduce<number>(
        (max, record) => Math.max(max, (record as { event?: { seq?: number } }).event?.seq ?? -1),
        -1,
      );
      ws.send(
        JSON.stringify({
          type: 'item',
          streamId,
          value: {
            type: 'snapshot',
            header: { version: 1, id: sessionId, createdAt: 0, isSeeded: false },
            cursor,
            records,
            hasMore: false,
            projections: { asOfSeq: cursor, values: {} },
          },
        }),
      );

      timer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          stopTimer();
          return;
        }
        const item = this.muxFrames.shift();
        if (item === undefined) return;
        if ('close' in item && item.close === true) {
          stopTimer();
          ws.send(JSON.stringify({ type: 'end', streamId }));
          ws.close();
          return;
        }
        const value = this.toFollowFrame(item);
        if (value) ws.send(JSON.stringify({ type: 'item', streamId, value }));
      }, 5);
    });
    ws.on('close', stopTimer);
    ws.on('error', stopTimer);
  }

  /** Translate legacy `session/event` script frames to follow frames. */
  private toFollowFrame(frame: object): object | undefined {
    const candidate = frame as {
      type?: string;
      payload?: { sessionId?: string; event?: unknown };
      event?: unknown;
      frame?: unknown;
    };
    if (candidate.type === 'session/event' && (candidate.payload?.event || candidate.event)) {
      return { type: 'event', event: candidate.payload?.event ?? candidate.event };
    }
    if (candidate.type === 'event' && candidate.event) {
      return { type: 'event', event: candidate.event };
    }
    if (candidate.type === 'assistant-stream' && candidate.frame) {
      return { type: 'assistant-stream', frame: candidate.frame };
    }
    if (candidate.type === 'snapshot') return candidate;
    return undefined;
  }

  /** Accept both 0.2.x `records` and legacy `events` history fixtures. */
  private historyRecords(value: unknown): unknown[] {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as { records?: unknown[]; events?: unknown[] };
    return candidate.records ?? candidate.events ?? [];
  }
}
