/**
 * Fake DSH Web Host HTTP server for agent-dsh tests.
 *
 * Mimics the real DSH wire protocol (deepseek-harness apiproxy handler.ts):
 *   - POST /api/<method>: body {type:'client-request',rpcId,method,payload},
 *     response {type:'server-response',rpcId,result:{ok:true,value}|{ok:false,error}}.
 *   - SSE GET /api/events.mux: frames `data: {type:'server-request',rpcId,
 *     method:<frame.type>, payload:<frame>}\n\n`.
 *
 * The mux frame queue is consumed ACROSS connections (shared pointer): the
 * first connection drains a prefix then closes; a reconnect drains the rest —
 * which is exactly how a server that drops mid-turn is modelled. Unary
 * handlers and the history value are registered by the test.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

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
  private historyValue: unknown = { events: [] };
  private port = 0;
  private closedConnections = 0;

  readonly requests: DshServerRequestRecord[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      const url = req.url ?? '';
      const path = url.split('?')[0];

      if (req.method === 'GET' && path === '/api/events.mux') {
        this.closedConnections++;
        this.handleMux(res);
        return;
      }

      if (req.method !== 'POST' || !path.startsWith('/api/')) {
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
        const rpcId = body.rpcId;
        this.requests.push({ method, rpcId, payload: body.payload });
        const handler = this.unaryHandlers.get(method);
        let result: FakeRpcResult | FakeRpcError;
        if (handler) {
          result = handler(body.payload, rpcId);
        } else if (method === 'session.history') {
          result = { ok: true, value: this.historyValue };
        } else if (method === 'session.list') {
          result = { ok: true, value: { items: [] } };
        } else {
          result = { ok: true, value: {} };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
      });
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get connectionCount(): number {
    return this.closedConnections;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as AddressInfo;
    this.port = addr.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  register(method: string, handler: FakeUnaryHandler): void {
    this.unaryHandlers.set(method, handler);
  }

  setMuxFrames(frames: Array<object | { close: true }>): void {
    this.muxFrames = frames;
  }

  setHistoryValue(value: unknown): void {
    this.historyValue = value;
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
    const handler = this.unaryHandlers.get(method);
    let result: FakeRpcResult | FakeRpcError;
    if (handler) {
      result = handler(payload, rpcId);
    } else if (method === 'session.history') {
      result = { ok: true, value: this.historyValue };
    } else if (method === 'session.list') {
      result = { ok: true, value: { items: [] } };
    } else {
      result = { ok: true, value: {} };
    }
    return { type: 'server-response', rpcId, result };
  }

  private handleMux(res: import('node:http').ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Drain the SHARED script (shift): the first connection consumes a prefix
    // then closes (a {close:true} marker or an exhausted queue); a reconnect
    // continues from where it left off — the natural model of a mid-turn drop.
    const timer = setInterval(() => {
      const item = this.muxFrames.shift();
      if (item === undefined) {
        clearInterval(timer);
        res.end();
        return;
      }
      if ('close' in item && item.close === true) {
        clearInterval(timer);
        res.end();
        return;
      }
      const frame = item as object;
      res.write(
        `data: ${JSON.stringify({
          type: 'server-request',
          rpcId: `mux-${randomUUID()}`,
          method: (frame as { type: string }).type,
          payload: frame,
        })}\n\n`,
      );
    }, 5);
    reqClose(res, timer);
  }
}

function reqClose(res: import('node:http').ServerResponse, timer: NodeJS.Timeout): void {
  res.on('close', () => clearInterval(timer));
}
