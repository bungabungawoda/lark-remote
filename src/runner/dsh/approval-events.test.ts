/**
 * Characterization 钉子：DshClient.approvalEvents 的帧映射与终态。
 * 用脚本化 fake WebSocket 回放 `$events` 帧，不连真实 Host。
 */
import { describe, it, expect } from 'vitest';
import { DshClient, type WebSocketFactory, type WebSocketLike } from './client.js';
import type { DshApprovalStreamItem } from '../../dsh/types.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NO_CREDENTIALS_FILE = '/nonexistent/lark-remote-test/.credentials.yaml';

class FramesSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onunexpectedresponse: ((event: { statusCode?: number }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(private readonly frames: Array<Record<string, unknown>>) {
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(data: string): void {
    this.sent.push(data);
    const msg = JSON.parse(data) as { type: string; streamId: string };
    if (msg.type !== 'open') return;
    setTimeout(() => {
      for (const frame of this.frames) {
        this.onmessage?.({
          data: JSON.stringify({ type: 'item', streamId: msg.streamId, value: frame }),
        });
      }
      this.onmessage?.({ data: JSON.stringify({ type: 'end', streamId: msg.streamId }) });
    }, 0);
  }
  close(): void {}
}

/** 只把 frames 喂给第一次连接；重连轮回放空，让 generator 收敛到 unavailable。 */
function makeClient(frames: Array<Record<string, unknown>>, posted: string[] = []): DshClient {
  let opens = 0;
  const webSocketImpl: WebSocketFactory = (_url) => new FramesSocket(opens++ === 0 ? frames : []);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    posted.push(url);
    if (url.includes('/?token=')) {
      return new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-test=v1.operator; Path=/' },
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: true, value: {} } }),
    } as unknown as Response;
  }) as typeof fetch;
  return new DshClient('http://127.0.0.1:3080', {
    token: 'abc',
    credentialsFile: NO_CREDENTIALS_FILE,
    fetchImpl,
    webSocketImpl,
    requestTimeoutMs: 60_000,
  });
}

async function drain(client: DshClient): Promise<DshApprovalStreamItem[]> {
  const items: DshApprovalStreamItem[] = [];
  for await (const item of client.approvalEvents(SID, new AbortController().signal)) {
    items.push(item);
  }
  return items;
}

const readyFrame = { type: 'ready', clientId: 'cli-1', host: { home: '/h' } };

describe('DshClient.approvalEvents (characterization)', () => {
  it('ready + approval/request + cancel 按顺序映射，末帧收敛到 unavailable', async () => {
    const items = await drain(
      makeClient([
        readyFrame,
        {
          type: 'waterfall',
          event: 'approval/request',
          eventId: 'e1',
          agentId: SID,
          request: { toolName: 'Bash', callId: 'c1', reason: 'why' },
        },
        { type: 'cancel', eventId: 'e1' },
      ]),
    );
    expect(items.filter((i) => i.kind !== 'unavailable')).toEqual([
      { kind: 'ready', clientId: 'cli-1' },
      {
        kind: 'request',
        eventId: 'e1',
        clientId: 'cli-1',
        toolName: 'Bash',
        callId: 'c1',
        reason: 'why',
      },
      { kind: 'cancelled', eventId: 'e1' },
    ]);
    expect(items.at(-1)).toMatchObject({ kind: 'unavailable' });
  });

  it('ready 之前收到 waterfall → unavailable 并终止', async () => {
    const items = await drain(
      makeClient([
        {
          type: 'waterfall',
          event: 'approval/request',
          eventId: 'e1',
          agentId: SID,
          request: {},
        },
      ]),
    );
    expect(items).toEqual([
      { kind: 'unavailable', message: 'DSH approval stream sent a waterfall before ready' },
    ]);
  });

  it('user-questions/request → question item（保留 question 文本与选项）', async () => {
    const items = await drain(
      makeClient([
        readyFrame,
        {
          type: 'waterfall',
          event: 'user-questions/request',
          eventId: 'e1',
          agentId: SID,
          request: { questions: [{ id: 'q1', question: 'Pick?', options: [{ label: 'A' }] }] },
        },
      ]),
    );
    expect(items[1]).toMatchObject({ kind: 'question', eventId: 'e1', clientId: 'cli-1' });
  });

  it('timed question / 非 owner waterfall → 委托（不发可答 item，走 $events/result）', async () => {
    const posted: string[] = [];
    const items = await drain(
      makeClient(
        [
          readyFrame,
          {
            type: 'waterfall',
            event: 'user-questions/request',
            eventId: 'e1',
            agentId: SID,
            request: { wait: { timed: true }, questions: [{ id: 'q1', question: 'Pick?' }] },
          },
          {
            type: 'waterfall',
            event: 'approval/request',
            eventId: 'e2',
            agentId: 'other-session',
            request: { toolName: 'Bash' },
          },
        ],
        posted,
      ),
    );
    expect(items.filter((i) => i.kind === 'request' || i.kind === 'question')).toEqual([]);
    expect(posted.some((u) => u.includes('$events/result'))).toBe(true);
  });
});
