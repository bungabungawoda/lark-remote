/**
 * DshClient transport tests.
 *
 * DSH 0.2.x requires a token→cookie handshake and serves live session data as
 * logical streams over `/api/remote.mux`. These tests use synthetic fetches and
 * a scripted WebSocket factory — no real sessions or network addresses.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DshClient,
  reconnectBackoffMs,
  type WebSocketFactory,
  type WebSocketLike,
} from './client.js';
import { extractDshToken } from '../../dsh/protocol.js';
import { DSH_BROWSER_CREDENTIAL_KEY } from '../../dsh/auth.js';
import { DshRunner } from './runner.js';
import type { AgentSessionReader } from '../../session-contract.js';
import type { AgentEvent } from '../types.js';
import type { DshFollowFrame, DshSessionEvent } from '../../dsh/types.js';
import { isWin32 } from '../../platform/select.js';

const CWD = '/home/user/project';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NO_CREDENTIALS_FILE = '/nonexistent/lark-remote-test/.credentials.yaml';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function credentialsFile(secret: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-dsh-client-'));
  tempDirs.push(dir);
  const file = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(
    file,
    YAML.stringify({
      version: 1,
      records: {
        [DSH_BROWSER_CREDENTIAL_KEY]: {
          kind: 'grant',
          payload: { version: 1, secret: secret.toString('base64url') },
        },
      },
    }),
    { mode: 0o600 },
  );
  if (!isWin32()) fs.chmodSync(file, 0o600);
  return file;
}

const stubReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({ events: [] }),
  isSessionActive: () => false,
};

function turnEnd(reason: string, seq: number): DshSessionEvent {
  return {
    type: 'turn/end',
    seq,
    time: 1700000000000,
    data: { turn: 1, reason: { kind: reason } },
  };
}

/** DSH 把 prompt 的 requestId 回写进 durable user/message 的 source.rpcId。 */
function promptMessage(rpcId: string, seq: number): DshSessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1700000000000,
    data: {
      id: `msg-${rpcId}`,
      role: 'user',
      content: [{ type: 'text', text: 'live question' }],
      source: { kind: 'user', rpcId },
    },
  };
}

function textDelta(delta: string): DshFollowFrame {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      time: 1700000000000,
      chunk: { type: 'text-delta', index: 0, text: delta },
    },
  };
}

/** A WebSocket that answers `open` with scripted follow frames. */
class ScriptedWebSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onunexpectedresponse: ((event: { statusCode?: number }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    /** session/follow 帧，或 session/control 的 baseline/projection 帧。 */
    readonly frames: Array<DshFollowFrame | Record<string, unknown>>,
    readonly closeAfterSend = true,
    readonly handshakeStatus?: number,
  ) {
    setTimeout(() => {
      if (this.handshakeStatus !== undefined) {
        this.onunexpectedresponse?.({ statusCode: this.handshakeStatus });
      } else {
        this.onopen?.({});
      }
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as { type: string; streamId: string };
    if (message.type !== 'open') return;
    setTimeout(() => {
      for (const frame of this.frames) {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'item',
            streamId: message.streamId,
            value: frame,
          }),
        });
      }
      if (this.closeAfterSend) {
        this.onmessage?.({
          data: JSON.stringify({ type: 'end', streamId: message.streamId }),
        });
      }
    }, 0);
  }

  close(): void {}
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value } }),
  } as unknown as Response;
}

function jsonRpcError(code: string, message: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: false, error: { code, message } } }),
  } as unknown as Response;
}

/** A WebSocket whose handshake always fails, for disconnect-watchdog tests. */
class FailingWebSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onunexpectedresponse: ((event: { statusCode?: number }) => void) | null = null;

  constructor() {
    setTimeout(() => this.onerror?.({ message: 'connect ECONNREFUSED' }), 0);
  }

  send(): void {}
  close(): void {}
}

describe('DshClient auth', () => {
  it('extracts the token from a pasted dsh web URL', () => {
    expect(extractDshToken('http://127.0.0.1:3080/?token=abc')).toBe('abc');
    expect(extractDshToken('?token=abc')).toBe('abc');
    expect(extractDshToken('abc')).toBe('abc');
    expect(extractDshToken(undefined)).toBe('');
  });

  it('bootstraps a v1 cookie from the launch token and sends it on unary + WebSocket calls', async () => {
    const calls: string[] = [];
    const cookies: Array<string | undefined> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/?token=')) {
        expect(url).toContain('token=abc');
        return new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'dsh-auth-127.0.0.1:3080=v1.operator; Path=/; HttpOnly' },
        });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      cookies.push(headers.cookie);
      if (url.endsWith('/api/session/create')) return jsonResponse({ sessionId: SID });
      return jsonResponse({});
    }) as typeof fetch;
    const wsCookies: Array<string | undefined> = [];
    const webSocketImpl: WebSocketFactory = (url, options) => {
      wsCookies.push(options?.headers?.cookie);
      return new ScriptedWebSocket(url, [
        { type: 'snapshot', cursor: -1, records: [] },
        textDelta('hi'),
        { type: 'event', event: turnEnd('completed', 2) },
      ]);
    };
    const client = new DshClient('http://127.0.0.1:3080', {
      token: 'http://127.0.0.1:3080/?token=abc',
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl,
    });

    await client.createSession({ cwd: CWD });
    const items = [];
    for await (const item of client.sessionEvents(SID, new AbortController().signal)) {
      items.push(item);
    }

    expect(calls[0]).toContain('/?token=abc');
    expect(cookies.every((c) => c?.includes('dsh-auth-127.0.0.1:3080=v1.operator'))).toBe(true);
    expect(wsCookies[0]).toContain('dsh-auth-127.0.0.1:3080=v1.operator');
    expect(items.map((i) => i.kind)).toEqual(['assistant-stream', 'event']);
  });

  it('surfaces an invalid token instead of retrying forever', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/?token=')) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      token: 'bad',
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    await expect(client.createSession({ cwd: CWD })).rejects.toThrow(/401/);
  });

  it('reports the missing-token 401 with configuration guidance', async () => {
    const fetchImpl = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    await expect(client.createSession({ cwd: CWD })).rejects.toThrow(/凭据文件|token/);
  });

  it('mints a fresh v1 cookie from the durable DSH credentials file', async () => {
    const file = credentialsFile(Buffer.alloc(32, 1));
    const cookies: Array<string | undefined> = [];
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      cookies.push(((init?.headers ?? {}) as Record<string, string>).cookie);
      return jsonResponse({ sessionId: SID });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: file,
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    await client.createSession({ cwd: CWD });
    fs.writeFileSync(
      file,
      YAML.stringify({
        version: 1,
        records: {
          [DSH_BROWSER_CREDENTIAL_KEY]: {
            kind: 'grant',
            payload: { version: 1, secret: Buffer.alloc(32, 2).toString('base64url') },
          },
        },
      }),
      { mode: 0o600 },
    );
    await client.createSession({ cwd: CWD });

    expect(urls.every((url) => url.endsWith('/api/session/create'))).toBe(true);
    expect(cookies[0]).toContain('=v1.');
    expect(cookies[1]).toContain('=v1.');
    expect(cookies[1]).not.toBe(cookies[0]);
  });
});

describe('DshClient session readiness', () => {
  it('waits for sessionController to activate instead of treating HTTP readiness as final', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonRpcError(
          'gateway/service-unavailable',
          'active Service "sessionController" is unavailable',
        );
      }
      return jsonResponse({ items: [] });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

    await client.waitForSessionService({ timeoutMs: 1_000 });

    expect(calls).toBe(2);
  });

  it('fails with a startup-specific message when the session service never activates', async () => {
    const fetchImpl = (async () =>
      jsonRpcError(
        'gateway/service-unavailable',
        'active Service "sessionController" is unavailable',
      )) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

    await expect(client.waitForSessionService({ timeoutMs: 40 })).rejects.toThrow(
      /未完成 session 服务启动/,
    );
  });

  it('does not block a host whose readiness endpoint is unsupported', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonRpcError(
        'gateway/invocation-unavailable',
        'no active Remote method exports this endpoint',
      );
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

    await client.waitForSessionService({ timeoutMs: 1_000 });

    expect(calls).toBe(1);
  });

  it('stops a readiness wait as soon as the run is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () =>
      jsonRpcError('gateway/service-unavailable', 'starting')) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

    const waiting = client.waitForSessionService({
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 10);

    await expect(waiting).rejects.toThrow(/aborted/);
  });
});

describe('DshClient remote mux', () => {
  it('refreshes auth and reconnects once when the WebSocket handshake returns 401', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/?token=abc');
      return new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-127.0.0.1:3080=v1.operator; Path=/; HttpOnly' },
      });
    }) as typeof fetch;
    let socketCount = 0;
    const client = new DshClient('http://127.0.0.1:3080', {
      token: 'abc',
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl: (url) => {
        socketCount++;
        return new ScriptedWebSocket(
          url,
          [{ type: 'event', event: turnEnd('completed', 1) }],
          true,
          socketCount === 1 ? 401 : undefined,
        );
      },
    });

    const events = [];
    for await (const item of client.sessionEvents(SID, new AbortController().signal)) {
      events.push(item);
    }

    expect(socketCount).toBe(2);
    expect(events).toHaveLength(1);
  });

  it('fails a live follow stream after a sustained disconnect instead of reconnecting forever', async () => {
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      streamDisconnectTimeoutMs: 20,
      webSocketImpl: () => new FailingWebSocket(),
    });

    const consume = (async () => {
      for await (const _item of client.sessionEvents(SID, new AbortController().signal)) {
        // The failing socket never yields a frame.
      }
    })();

    await expect(consume).rejects.toThrow(/不可达/);
  });

  it('consumes follow snapshot events and assistant deltas, then stops on turn/end', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
          { type: 'snapshot', cursor: 0, records: [] },
          textDelta('first '),
          textDelta('second'),
          { type: 'event', event: turnEnd('completed', 1) },
        ]),
    });
    const text: string[] = [];
    for await (const item of client.sessionEvents(SID, new AbortController().signal)) {
      if (item.kind === 'assistant-stream') {
        const chunk = item.frame.chunk as { type?: string; text?: string };
        if (chunk?.type === 'text-delta' && chunk.text) text.push(chunk.text);
      }
    }
    expect(text).toEqual(['first ', 'second']);
  });

  it('dedups replayed snapshot events by seq', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
          {
            type: 'snapshot',
            cursor: 1,
            records: [{ type: 'event', event: turnEnd('completed', 1) }],
          },
          { type: 'event', event: turnEnd('completed', 2) },
        ]),
    });
    const seen: number[] = [];
    for await (const item of client.sessionEvents(SID, new AbortController().signal, 1)) {
      if (item.kind === 'event') seen.push(item.event.seq);
    }
    expect(seen).toEqual([2]);
  });

  it('backfills the pre-snapshot gap via session/page when hasMore hides older events', async () => {
    // 源码验证：follow 快照按消息截尾，hasMore=true 表示
    // lastSeq 与快照起点之间有缺口。快照覆盖 401-402（turn/end 收尾），
    // 缺口 0-400 由 session/page 回填——回放必须 seq 升序覆盖全部 403 条。
    const pageCalls: Array<{ throughSeq: number; maxMessages: number }> = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/session/page')) {
        return jsonResponse({});
      }
      return jsonResponse({});
    }) as typeof fetch;
    // 页响应需要按 body 分派：unary 的 body 携带 method envelope。
    const dispatchingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/session/page')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          payload?: { args?: { request?: { throughSeq?: number; maxMessages?: number } } };
        };
        const req = body.payload?.args?.request ?? {};
        pageCalls.push({ throughSeq: req.throughSeq ?? -1, maxMessages: req.maxMessages ?? 0 });
        const throughSeq = req.throughSeq ?? -1;
        // 单页盖住整个缺口：返回 [0..throughSeq]，hasMore=false 终止翻页。
        const records = [];
        for (let seq = Math.max(0, throughSeq - 400); seq <= throughSeq; seq++) {
          records.push({
            type: 'event',
            event: { type: 'assistant/message', seq, time: 1700000000000, data: {} },
          });
        }
        return jsonResponse({ records, hasMore: false });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;

    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl: dispatchingFetch,
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
          {
            type: 'snapshot',
            cursor: 402,
            hasMore: true,
            records: [
              {
                type: 'event',
                event: { type: 'assistant/message', seq: 401, time: 1700000000000, data: {} },
              },
              { type: 'event', event: turnEnd('completed', 402) },
            ],
          },
        ]),
    });
    const seen: number[] = [];
    for await (const item of client.sessionEvents(SID, new AbortController().signal)) {
      if (item.kind === 'event') seen.push(item.event.seq);
    }
    expect(seen).toHaveLength(403);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(402);
    const ascending = seen.every((seq, i) => i === 0 || seq > seen[i - 1]!);
    expect(ascending).toBe(true);
    expect(pageCalls).toEqual([{ throughSeq: 400, maxMessages: 200 }]);
  });

  it('does not page backfill when the snapshot starts right above lastSeq', async () => {
    // hasMore=true 但快照首条就是 lastSeq+1：无缺口，一个 session/page 都不发。
    let pageCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/session/page')) pageCalls++;
      return jsonResponse({});
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
          {
            type: 'snapshot',
            cursor: 402,
            hasMore: true,
            records: [
              {
                type: 'event',
                event: { type: 'assistant/message', seq: 401, time: 1700000000000, data: {} },
              },
              { type: 'event', event: turnEnd('completed', 402) },
            ],
          },
        ]),
    });
    const seen: number[] = [];
    for await (const item of client.sessionEvents(SID, new AbortController().signal, 400)) {
      if (item.kind === 'event') seen.push(item.event.seq);
    }
    expect(seen).toEqual([401, 402]);
    expect(pageCalls).toBe(0);
  });

  it('openTurnState reports unknown when the event probe tail is a user/message', async () => {
    // 源码验证：user/message 在 turn 打开后 append，距下一条
    // durable 事件隔一个 LLM 往返——尾部 user/message 时 open/closed 都可能是
    // 错的（压缩 checkpoint 也以 turn:null 落 user/message），只能报 unknown。
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/session/list')) {
        return jsonResponse({ items: [{ sessionId: SID, running: undefined }] });
      }
      if (url.endsWith('/api/session/projections')) {
        return jsonResponse({ asOfSeq: 5, values: {} });
      }
      if (url.endsWith('/api/session/page')) {
        return jsonResponse({
          records: [
            {
              type: 'event',
              event: {
                type: 'user/message',
                seq: 5,
                time: 1700000000000,
                data: { id: 'm1', role: 'user', content: [] },
              },
            },
          ],
          hasMore: false,
        });
      }
      throw new Error(`unexpected fetch: ${url} ${JSON.stringify(init?.body ?? null)}`);
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const state = await client.openTurnState(SID, { timeoutMs: 1000 });
    expect(state).toBe('unknown');
  });

  it('parses session/control baseline and both projection frame shapes into filtered items', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
          {
            type: 'baseline',
            value: {
              projections: {
                [SID]: { asOfSeq: 0, values: { contextPressure: { projectedTokens: 1 } } },
                'session-other': { asOfSeq: 0, values: { sessionStats: { steps: 3 } } },
              },
            },
          },
          // 0.2.2 起：一次提交里变更的多个 key 合成一帧（缺 key/value 时不得整帧丢掉）。
          {
            type: 'projection',
            sessionId: SID,
            seq: 9,
            changes: [
              { key: 'sessionStats', val: { steps: 4 } },
              { key: 'contextPressure', val: { projectedTokens: 2, contextWindow: 10 } },
            ],
          },
          // 0.2.1 及更早：一帧一个 key。
          {
            type: 'projection',
            sessionId: SID,
            key: 'sessionStats',
            value: { steps: 5 },
            seq: 10,
          },
        ]),
    });
    const items = [];
    for await (const item of client.controlFrames(new AbortController().signal)) {
      items.push(item);
    }
    // baseline 展开成逐 key 的 item（调用方按 sessionId 过滤），
    // 之后的增量帧同样归一成逐 key；baseline 覆盖全 Host，不做 session 过滤。
    expect(items).toEqual([
      {
        kind: 'projection',
        sessionId: SID,
        key: 'contextPressure',
        value: { projectedTokens: 1 },
      },
      { kind: 'projection', sessionId: 'session-other', key: 'sessionStats', value: { steps: 3 } },
      { kind: 'projection', sessionId: SID, key: 'sessionStats', value: { steps: 4 } },
      {
        kind: 'projection',
        sessionId: SID,
        key: 'contextPressure',
        value: { projectedTokens: 2, contextWindow: 10 },
      },
      { kind: 'projection', sessionId: SID, key: 'sessionStats', value: { steps: 5 } },
    ]);
  });

  it('skips malformed entries inside a batched projection frame', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
          {
            type: 'projection',
            sessionId: SID,
            seq: 3,
            changes: [
              null,
              { key: '' },
              { val: { steps: 1 } },
              { key: 'plan', val: { active: true } },
            ],
          },
        ]),
    });
    const items = [];
    for await (const item of client.controlFrames(new AbortController().signal)) {
      items.push(item);
    }
    expect(items).toEqual([
      { kind: 'projection', sessionId: SID, key: 'plan', value: { active: true } },
    ]);
  });

  it('degrades to no items when the control stream fails (never breaks the run)', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
      // 401 → muxStream 抛 DshError；控制流是增强通道，必须吞掉并结束。
      webSocketImpl: () =>
        new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [], true, 401),
    });
    const items = [];
    for await (const item of client.controlFrames(new AbortController().signal)) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });
});

describe('DshRunner over remote mux', () => {
  it('runs a full turn to success with init → deltas → result', async () => {
    let promptRequestId = '';
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/session/projections')) return jsonResponse({ asOfSeq: 0 });
      if (url.endsWith('/api/session/prompt')) {
        const body = JSON.parse(String(init?.body)) as {
          payload: { args: { request: { requestId: string } } };
        };
        promptRequestId = body.payload.args.request.requestId;
        expect(promptRequestId).toMatch(/^lark-remote-/);
        return jsonResponse({ accepted: true });
      }
      return jsonResponse({ accepted: true });
    }) as typeof fetch;
    const webSocketImpl: WebSocketFactory = () =>
      new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
        {
          type: 'snapshot',
          cursor: 0,
          records: [{ type: 'event', event: promptMessage(promptRequestId, 0.5) }],
        },
        textDelta('live websocket '),
        { type: 'event', event: turnEnd('completed', 2) },
      ]);

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: 'http://127.0.0.1:3080',
      fetchImpl,
      webSocketImpl,
    });

    const events = await collect(runner.run('live question', { cwd: CWD, sessionId: SID }));
    expect(events.find((e) => e.type === 'system' && e.subtype === 'init')).toMatchObject({
      session_id: SID,
      cwd: CWD,
    });
    const text = events
      .filter((e) => e.type === 'assistant')
      .map((e) => e.message.content.find((c) => c.type === 'text'))
      .filter((c): c is { type: 'text'; text: string } => !!c)
      .map((c) => c.text)
      .join('');
    expect(text).toBe('live websocket ');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });
});

describe('DshClient config-plane unary methods', () => {
  it('selectModel posts provider/model/reasoningEffort and returns selected', async () => {
    let posted: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return jsonResponse({
        selected: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
        },
      });
    }) as typeof fetch;

    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const selected = await client.selectModel({
      sessionId: SID,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    expect(posted).toMatchObject({
      method: 'session/selectModel',
      payload: {
        args: {
          request: {
            sessionId: SID,
            provider: 'deepseek-official',
            model: 'deepseek-v4-pro',
            reasoningEffort: 'max',
          },
        },
      },
    });
    expect(selected).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
  });

  it('listModels uses session/modelCatalog and returns groups', async () => {
    let method = '';
    const catalog = {
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek Official',
          models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
        },
      ],
      failures: [],
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      method = String(input).split('/api/')[1] ?? '';
      return jsonResponse(catalog);
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const value = await client.listModels();
    expect(method).toBe('session/modelCatalog');
    expect(value.groups[0].models[0].id).toBe('deepseek-v4-flash');
  });

  it('listPresets uses agentPresets/list', async () => {
    let method = '';
    const value = {
      presets: [{ id: 'code', trust: 'system', isDefault: false, name: 'PTC 模式' }],
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      method = String(input).split('/api/')[1] ?? '';
      return jsonResponse(value);
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const result = await client.listPresets();
    expect(method).toBe('agentPresets/list');
    expect(result.presets[0].id).toBe('code');
  });

  it('listPermissionPresets uses permissionPresets/catalog', async () => {
    let posted: unknown;
    const value = {
      options: [{ value: 'workspace-write', name: 'workspace-write' }],
      defaultOptions: [{ value: 'workspace-write', name: 'workspace-write' }],
      defaultPreset: 'workspace-write',
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted = { url: String(input), body: JSON.parse(String(init?.body)) };
      return jsonResponse(value);
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const result = await client.listPermissionPresets();
    expect(posted).toMatchObject({
      url: 'http://127.0.0.1:3080/api/permissionPresets/catalog',
      body: { payload: { args: {} } },
    });
    expect(result.defaultPreset).toBe('workspace-write');
  });

  it('executeCommand posts the commands/execute named arguments', async () => {
    let posted: unknown;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return jsonResponse({ commandId: 'cmd-1', result: { kind: 'success' } });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const result = await client.executeCommand(SID, '/permission workspace-write');
    expect(posted).toMatchObject({
      method: 'commands/execute',
      payload: {
        args: {
          agentId: SID,
          line: '/permission workspace-write',
          submittedAttachments: [],
        },
      },
    });
    expect(result?.kind).toBe('success');
  });

  it('createSession passes agentPreset through', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const posted = JSON.parse(String(init?.body)) as { payload: unknown };
      expect(posted.payload).toEqual({
        args: { request: { cwd: CWD, agentPreset: 'code' } },
      });
      return jsonResponse({ sessionId: SID, agentPreset: 'code' });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    const created = await client.createSession({ cwd: CWD, agentPreset: 'code' });
    expect(created).toEqual({ sessionId: SID, agentPreset: 'code' });
  });

  it('executeCommand posts commands/execute with agentId/line and no unary budget when asked', async () => {
    // commands/execute 的 wire 形状与 session/* 不同：参数按 wire 名 agentId
    // 传（不是 request 包一层），且压缩这类长命令必须能关掉 60s 默认预算。
    let method = '';
    let posted: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      method = String(input).split('/api/')[1] ?? '';
      posted = JSON.parse(String(init?.body));
      return jsonResponse({ kind: 'success', text: 'Compacted 3 history items (~1200 tokens).' });
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

    const value = await client.executeCommand(SID, '/compact', { timeoutMs: 0 });
    expect(method).toBe('commands/execute');
    expect(posted).toMatchObject({
      method: 'commands/execute',
      payload: {
        args: { agentId: SID, line: '/compact', submittedAttachments: [] },
      },
    });
    expect(value).toEqual({
      kind: 'success',
      text: 'Compacted 3 history items (~1200 tokens).',
    });
  });

  it('executeCommand returns undefined for an admission miss (unknown command)', async () => {
    // 命令未注册时服务端返回 ok:true 且无 value：什么都没执行，不能当成成功。
    const fetchImpl = (async () => jsonResponse(undefined)) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });
    await expect(client.executeCommand(SID, '/nope')).resolves.toBeUndefined();
  });

  it('test_anchor_dsh_unary_times_out_and_honors_abort', async () => {
    // unary 请求必须有超时 + 可取消。fetchImpl 永不 resolve，只在
    // AbortSignal 触发时 reject（模拟真实 fetch 行为）。
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort, { once: true });
      })) as unknown as typeof fetch;

    const timingClient = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl: hangingFetch,
      requestTimeoutMs: 30,
    });
    await expect(timingClient.unary('session/prompt', {})).rejects.toMatchObject({
      code: 'timeout',
    });

    const abortClient = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl: hangingFetch,
    });
    const controller = new AbortController();
    const pending = abortClient.unary('session/prompt', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('DshClient.removeQueuedPrompt', () => {
  const makeClient = (fetchImpl: typeof fetch): DshClient =>
    new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

  const errorResponse = (code: string, message: string): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: false, error: { code, message } } }),
    }) as unknown as Response;

  it('host 成功撤掉未受理的排队消息时返回 true，请求带 itemId 与 remove 动作', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/session/updateQueue')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      }
      return jsonResponse({});
    }) as typeof fetch;

    const removed = await makeClient(fetchImpl).removeQueuedPrompt(SID, 'inbox-1');

    expect(removed).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ method: 'session/updateQueue' });
    expect(JSON.stringify(bodies[0])).toContain('inbox-1');
    expect(JSON.stringify(bodies[0])).toContain('remove');
  });

  it('消息已被 turn 取走（session/queue-item-not-found）时返回 false 而非抛错', async () => {
    const fetchImpl = (async () =>
      errorResponse('session/queue-item-not-found', 'already claimed')) as typeof fetch;

    await expect(makeClient(fetchImpl).removeQueuedPrompt(SID, 'inbox-1')).resolves.toBe(false);
  });

  it('其它错误原样抛出，交由上层决定重试或告警', async () => {
    const fetchImpl = (async () => errorResponse('internal', 'host exploded')) as typeof fetch;

    await expect(makeClient(fetchImpl).removeQueuedPrompt(SID, 'inbox-1')).rejects.toThrow(
      'host exploded',
    );
  });
});

describe('DshClient.goalState', () => {
  const goalSnapshot = {
    id: 'goal-1',
    revision: 1,
    objective: '完成 notes-app 实时链路 MVP',
    phase: 'active',
    maxGoalRounds: 40,
  };
  /** 宿主投影信封：durable phase + 轮次，没有 activation（进程内状态）。 */
  const projection = (phase = 'active'): Response =>
    jsonResponse({
      asOfSeq: 3,
      values: {
        goal: {
          current: {
            goal: { ...goalSnapshot, phase },
            roundsStarted: 2,
            createdAt: 1,
            updatedAt: 2,
          },
          seenGoalIds: ['goal-1'],
          failure: null,
        },
      },
    });
  const liveView = (activation: string): Response =>
    jsonResponse({
      ...goalSnapshot,
      roundsStarted: 2,
      createdAt: 1,
      updatedAt: 2,
      activation,
    });
  const makeClient = (fetchImpl: typeof fetch): DshClient =>
    new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

  it('把 goals/get 的进程内 activation 补进 goal（投影里没有这一维）', async () => {
    const methods: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      methods.push(body.method ?? String(input));
      if (body.method === 'session/projections') return projection();
      if (body.method === 'goals/get') return liveView('disarmed');
      throw new Error(`unexpected method: ${String(body.method)}`);
    }) as typeof fetch;

    const state = await makeClient(fetchImpl).goalState(SID);

    expect(state).toEqual({
      known: true,
      goal: expect.objectContaining({ id: 'goal-1', phase: 'active', activation: 'disarmed' }),
    });
    expect(methods).toContain('goals/get');
  });

  it('goals/get 读不到时保留 durable goal，activation 缺省（不降级成 unknown）', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      if (body.method === 'session/projections') return projection();
      if (body.method === 'goals/get') return new Response('boom', { status: 500 });
      throw new Error(`unexpected method: ${String(body.method)}`);
    }) as typeof fetch;

    const state = await makeClient(fetchImpl).goalState(SID);

    expect(state.known).toBe(true);
    expect(state.goal).toMatchObject({ id: 'goal-1', phase: 'active' });
    expect(state.goal).not.toHaveProperty('activation');
  });

  it('非 active 的 goal 不额外打 goals/get（那些 phase 本来就不会续跑）', async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      methods.push(body.method ?? '');
      return projection('complete');
    }) as typeof fetch;

    const state = await makeClient(fetchImpl).goalState(SID);

    expect(state).toEqual({ known: true, goal: expect.objectContaining({ phase: 'complete' }) });
    expect(methods).not.toContain('goals/get');
  });
});

describe('DshClient.cookieFromCredentials 损坏凭据回退', () => {
  const broken = async (): Promise<Buffer> => {
    throw new Error('corrupt yaml');
  };

  it('有启动 token 时回退 token 握手，unary 仍成功', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/?token=')) {
        return new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'dsh-auth-127.0.0.1:3080=v1.operator' },
        });
      }
      return jsonResponse({});
    }) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      token: 'abc',
      credentialsFile: NO_CREDENTIALS_FILE,
      readCredentials: broken,
      fetchImpl,
    });

    await client.unary('session/prompt', {});
    expect(urls.some((u) => u.includes('/?token=abc'))).toBe(true);
  });

  it('无启动 token 时抛出带凭据文件信息的可见错误', async () => {
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      readCredentials: broken,
      fetchImpl,
    });

    await expect(client.unary('session/prompt', {})).rejects.toThrow(/corrupt yaml/);
  });
});

describe('DshClient 凭据 (mtime, size) 指纹缓存', () => {
  it('指纹未变时复用缓存的 secret，重写文件后自动重读', async () => {
    const file = credentialsFile(Buffer.alloc(32, 9));
    let readCount = 0;
    const readCredentials = vi.fn(async (_file: string) => {
      readCount += 1;
      return Buffer.alloc(32, 9);
    });
    const fetchImpl = (async () => jsonResponse({ sessionId: SID })) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: file,
      readCredentials,
      fetchImpl,
    });

    await client.createSession({ cwd: CWD });
    await client.createSession({ cwd: CWD });
    expect(readCount).toBe(1);

    // 轮换 = 重写凭据文件：mtime 变化 → 下次调用重读（免重启生效语义保留）。
    fs.writeFileSync(
      file,
      YAML.stringify({
        version: 1,
        records: {
          [DSH_BROWSER_CREDENTIAL_KEY]: {
            kind: 'grant',
            payload: { version: 1, secret: Buffer.alloc(32, 10).toString('base64url') },
          },
        },
      }),
      { mode: 0o600 },
    );
    await client.createSession({ cwd: CWD });
    expect(readCount).toBe(2);
    expect(vi.mocked(readCredentials).mock.calls.every(([f]) => f === file)).toBe(true);
  });

  it('stat 失败（文件消失）时不缓存，reader 错误契约不变', async () => {
    let readCount = 0;
    const broken = async (): Promise<Buffer> => {
      readCount += 1;
      throw new Error('corrupt yaml');
    };
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const client = new DshClient('http://127.0.0.1:3080', {
      credentialsFile: NO_CREDENTIALS_FILE,
      readCredentials: broken,
      fetchImpl,
    });

    await expect(client.unary('session/prompt', {})).rejects.toThrow(/corrupt yaml/);
    expect(readCount).toBe(1);
  });
});

describe('DshClient sessionEvents 重连退避', () => {
  /** 从 setTimeout 调用里提取退避 sleep（排除 0ms 脚本 timer 与 60s 连接超时）。 */
  function backoffDelays(spy: { mock: { calls: unknown[][] } }): number[] {
    return spy.mock.calls
      .map((call: unknown[]) => (typeof call[1] === 'number' ? call[1] : 0))
      .filter((ms: number) => ms > 0 && ms < 60_000);
  }

  it('退避调度：200ms 起指数翻倍，封顶 5s', () => {
    expect(reconnectBackoffMs(0)).toBe(200);
    expect(reconnectBackoffMs(1)).toBe(400);
    expect(reconnectBackoffMs(2)).toBe(800);
    expect(reconnectBackoffMs(3)).toBe(1_600);
    expect(reconnectBackoffMs(4)).toBe(3_200);
    expect(reconnectBackoffMs(5)).toBe(5_000);
    expect(reconnectBackoffMs(20)).toBe(5_000);
  });

  it('宿主持续宕机时重连按指数退避（真实 setTimeout 序列 200→400→…→封顶）', async () => {
    let socketCount = 0;
    const client = new DshClient('http://127.0.0.1:3080', {
      token: 'abc',
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl: (async () =>
        new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'dsh-auth-127.0.0.1:3080=v1.operator' },
        })) as typeof fetch,
      webSocketImpl: (url) => {
        socketCount += 1;
        // 每次握手都 503：宿主宕机形态（ScriptedWebSocket 的 0ms timer 立即回包）。
        return new ScriptedWebSocket(url, [], true, 503);
      },
    });

    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const controller = new AbortController();
      const consumed = (async () => {
        for await (const _item of client.sessionEvents(SID, controller.signal)) {
          // 永远等不到帧。
        }
      })();
      // 5 档退避累计 200+400+800+1600+3200 = 6.2s，等前 4 档出现即可。
      await vi.waitFor(
        () => {
          const delays = backoffDelays(sleepSpy);
          expect(delays.length).toBeGreaterThanOrEqual(4);
        },
        { timeout: 8_000, interval: 50 },
      );
      controller.abort();
      await consumed;
      const delays = backoffDelays(sleepSpy).slice(0, 4);
      expect(delays).toEqual([200, 400, 800, 1_600]);
      // 第 N 个 socket 失败后才排第 N 个 sleep；4 个 sleep = 至少 4 次尝试。
      expect(socketCount).toBeGreaterThanOrEqual(4);
    } finally {
      sleepSpy.mockRestore();
    }
  });
});
