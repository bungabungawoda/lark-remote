import { describe, it, expect, vi } from 'vitest';
import { PiRpcClient } from './client.js';
import type { JsonlRpcTransport } from '../../common/jsonrpc/transport.js';

/** Minimal fake transport capturing writes and letting tests inject server lines. */
class FakeTransport {
  closed = false;
  started = false;
  onMessage: ((msg: unknown) => void) | null = null;
  onClose: (() => void) | null = null;
  written: unknown[] = [];

  async start(events: {
    onMessage(msg: unknown): void;
    onClose(reason: string): void;
  }): Promise<void> {
    this.started = true;
    this.onMessage = events.onMessage;
    this.onClose = events.onClose;
  }

  write(msg: object): void {
    this.written.push(msg);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onClose?.();
  }

  /** Simulate a server line arriving. */
  recv(line: unknown): void {
    this.onMessage?.(line);
  }
}

function makeClient(baseOnClose = () => {}): { client: PiRpcClient; transport: FakeTransport } {
  const transport = new FakeTransport() as unknown as JsonlRpcTransport;
  const client = new PiRpcClient(transport, baseOnClose, 1000);
  return { client, transport };
}

describe('PiRpcClient', () => {
  it('test_anchor_connect_sets_ready', async () => {
    const { client } = makeClient();
    await client.connect();
    expect(client.ready).toBe(true);
    expect(client.healthy).toBe(true);
  });

  it('test_anchor_request_resolves_by_id_and_ignores_other_commands', async () => {
    const { client, transport } = makeClient();
    await client.connect();

    const p = client.request({ type: 'get_state' });
    // Another command's response should not resolve the pending request.
    transport.recv({ id: 'req_999', type: 'response', command: 'prompt', success: true });
    transport.recv({
      id: 'req_1',
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444' },
    });
    const resp = await p;
    expect(resp.success).toBe(true);
    expect((resp as { data: { sessionId: string } }).data.sessionId).toBe(
      'aaaaaaaa-1111-2222-3333-444444444444',
    );
  });

  it('test_anchor_forwards_non_response_lines_as_events', async () => {
    const { client, transport } = makeClient();
    await client.connect();
    const onEvent = vi.fn();
    client.setHooks({ onEvent });

    transport.recv({ type: 'message_start', message: { role: 'assistant', content: [] } });
    transport.recv({ type: 'agent_settled' });
    transport.recv({ id: 'req_2', type: 'response', command: 'compact', success: true, data: {} });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0]).toMatchObject({ type: 'message_start' });
    expect(onEvent.mock.calls[1][0]).toMatchObject({ type: 'agent_settled' });
  });

  it('test_anchor_notify_writes_without_waiting', async () => {
    const { client, transport } = makeClient();
    await client.connect();
    client.notify({ type: 'abort' });
    expect(transport.written).toHaveLength(1);
    expect((transport.written[0] as { type: string }).type).toBe('abort');
  });

  it('test_anchor_request_timeout_rejects', async () => {
    const { client } = makeClient();
    await client.connect();
    await expect(client.request({ type: 'compact' })).rejects.toThrow(/timeout/);
  });

  it('test_anchor_on_close_fires_base_and_run_hooks', async () => {
    const baseOnClose = vi.fn();
    const runOnClose = vi.fn();
    const { client, transport } = makeClient(baseOnClose);
    await client.connect();
    client.setHooks({ onClose: runOnClose });
    transport.close();
    expect(baseOnClose).toHaveBeenCalledTimes(1);
    expect(runOnClose).toHaveBeenCalledTimes(1);
  });
});
