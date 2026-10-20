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
import { afterEach, describe, expect, it } from 'vitest';
import { DshClient, extractDshToken, type WebSocketFactory, type WebSocketLike } from './client.js';
import { DSH_BROWSER_CREDENTIAL_KEY } from './auth.js';
import { DshRunner } from './runner.js';
import type { AgentSessionReader, AgentEvent } from '../types.js';
import type { DshFollowFrame, DshSessionEvent } from './types.js';

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
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
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
    readonly frames: DshFollowFrame[],
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

  it('parses session/control baseline and projection frames into filtered items', async () => {
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
          { type: 'projection', sessionId: SID, key: 'sessionStats', value: { steps: 3 }, seq: 9 },
        ]),
    });
    const items = [];
    for await (const item of client.controlFrames(new AbortController().signal)) {
      items.push(item);
    }
    // baseline 展开成逐 key 的 item（调用方按 sessionId 过滤），
    // 之后的增量帧原样透传；baseline 覆盖全 Host，不做 session 过滤。
    expect(items).toEqual([
      {
        kind: 'projection',
        sessionId: SID,
        key: 'contextPressure',
        value: { projectedTokens: 1 },
      },
      { kind: 'projection', sessionId: 'session-other', key: 'sessionStats', value: { steps: 3 } },
      { kind: 'projection', sessionId: SID, key: 'sessionStats', value: { steps: 3 } },
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
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/session/projections')) return jsonResponse({ asOfSeq: 0 });
      if (url.endsWith('/api/session/prompt')) {
        const body = JSON.parse(String(init?.body)) as {
          payload: { args: { request: { requestId: string } } };
        };
        expect(body.payload.args.request.requestId).toMatch(/^lark-remote-/);
        return jsonResponse({ accepted: true });
      }
      return jsonResponse({ accepted: true });
    }) as typeof fetch;
    const webSocketImpl: WebSocketFactory = () =>
      new ScriptedWebSocket('ws://127.0.0.1:3080/api/remote.mux', [
        { type: 'snapshot', cursor: 0, records: [] },
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
