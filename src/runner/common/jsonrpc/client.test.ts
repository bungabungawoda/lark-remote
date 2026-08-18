import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcClient, RpcError, RpcTimeoutError, ConnectionLostError } from './client.js';
import { JsonlRpcTransport } from './transport.js';

/** Fake ACP server that answers initialize and handles requests. */
function makeFakeServer(
  tmpDir: string,
  handlers: Record<string, (msg: Record<string, unknown>) => unknown>,
): {
  wrapper: string;
} {
  const server = join(tmpDir, 'acp-server.mjs');
  // Serialize handlers into a self-contained script
  const handlerSource = Object.entries(handlers)
    .map(([method, _fn]) => {
      // We can't serialize functions; use a simpler approach:
      // The fake server just echoes back responses based on method name
      return `case '${method}': break;`;
    })
    .join('\n    ');

  // 本 mock 的形状必须与 protocol-types.ts 同源；改协议先改类型再改 mock。
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n    return;\n  }\n  switch (msg.method) {\n    ${handlerSource}\n    default:\n    if (msg.id !== undefined) {\n      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');\n    }\n  }\n});\n`,
  );
  const wrapper = join(tmpDir, 'acp-server.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
  chmodSync(wrapper, 0o755);
  return { wrapper };
}

describe('JsonRpcClient request/response id matching', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-jsonrpc-client-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches request/response by id', async () => {
    const { wrapper } = makeFakeServer(tmpDir, {});
    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    const client = new JsonRpcClient(transport, {
      onNotification: () => {},
      onServerRequest: () => {},
      onClose: () => {},
    });

    const initResult = await client.connect();
    expect(initResult.protocolVersion).toBe(1);

    const result = await client.request<unknown, { ok: boolean }>('session/new', { cwd: tmpDir });
    expect(result.ok).toBe(true);

    await client.dispose();
  });

  it('rejects on JSON-RPC error response', async () => {
    // Server that returns error for session/new
    const server = join(tmpDir, 'error-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n    return;\n  }\n  if (msg.method === 'session/new') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'bad params' } }) + '\\n');\n    return;\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'error-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    const client = new JsonRpcClient(transport, {
      onNotification: () => {},
      onServerRequest: () => {},
      onClose: () => {},
    });

    await client.connect();

    await expect(client.request('session/new', {})).rejects.toThrow(RpcError);
    const err = await client.request('session/new', {}).catch((e) => e as RpcError);
    expect(err.code).toBe(-32600);

    await client.dispose();
  });

  it('times out on missing response', async () => {
    // Server that answers initialize but ignores everything else
    const server = join(tmpDir, 'timeout-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n  }\n  // ignore all other requests — client will timeout\n});\n`,
    );
    const wrapper = join(tmpDir, 'timeout-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    const client = new JsonRpcClient(
      transport,
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onClose: () => {},
      },
      500, // 500ms timeout for fast test
    );

    await client.connect();

    await expect(client.request('session/new', {})).rejects.toThrow(RpcTimeoutError);

    await client.dispose();
  }, 10000);

  it('dispatches notifications to hooks', async () => {
    const server = join(tmpDir, 'notif-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n  }\n  if (msg.method === 'trigger-notif') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { event: { type: 'agent_message_chunk', delta: 'hello' } } }) + '\\n');\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'notif-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });

    const notifications: Array<{ method: string; params: unknown }> = [];
    const client = new JsonRpcClient(transport, {
      onNotification: (method, params) => notifications.push({ method, params }),
      onServerRequest: () => {},
      onClose: () => {},
    });

    await client.connect();

    // Also set run hooks — both base and run hooks should get notifications
    const runNotifications: Array<{ method: string; params: unknown }> = [];
    client.setHooks({
      onNotification: (method, params) => runNotifications.push({ method, params }),
      onServerRequest: () => {},
      onClose: () => {},
    });

    await client.request('trigger-notif', {});

    // Wait a bit for async notification dispatch
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(notifications.some((n) => n.method === 'session/update')).toBe(true);
    expect(runNotifications.some((n) => n.method === 'session/update')).toBe(true);

    await client.dispose();
  }, 10000);

  it('dispatches server requests (reverse RPC) to hooks', async () => {
    const server = join(tmpDir, 'rpc-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n  }\n  if (msg.method === 'trigger-approval') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: { sessionId: 'sess-1', options: [{ optionId: 'approve_once', name: 'Approve', kind: 'approve_once' }] } }) + '\\n');\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'rpc-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });

    const serverRequests: Array<{ id: number | string; method: string; params: unknown }> = [];
    const client = new JsonRpcClient(transport, {
      onNotification: () => {},
      onServerRequest: (id, method, params) => serverRequests.push({ id, method, params }),
      onClose: () => {},
    });

    await client.connect();

    const runServerRequests: Array<{ id: number | string; method: string; params: unknown }> = [];
    client.setHooks({
      onNotification: () => {},
      onServerRequest: (id, method, params) => runServerRequests.push({ id, method, params }),
      onClose: () => {},
    });

    await client.request('trigger-approval', {});

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(serverRequests.some((r) => r.method === 'session/request_permission')).toBe(true);
    expect(runServerRequests.some((r) => r.method === 'session/request_permission')).toBe(true);

    await client.dispose();
  }, 10000);

  it('failPending rejects all pending requests on connection lost', async () => {
    // Server that exits after initialize
    const server = join(tmpDir, 'exit-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n    setTimeout(() => process.exit(0), 100);\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'exit-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    let onCloseFired = false;
    const client = new JsonRpcClient(transport, {
      onNotification: () => {},
      onServerRequest: () => {},
      onClose: () => {
        onCloseFired = true;
      },
    });

    await client.connect();

    // Fire a request that will never be answered (server is about to exit)
    const pending = client.request('session/new', {}).catch((e) => e as Error);

    // Wait for connection to drop
    await new Promise((resolve) => setTimeout(resolve, 500));

    const err = await pending;
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(onCloseFired).toBe(true);
  }, 10000);

  it('respond() sends success response to server request', async () => {
    // Server that sends a request_permission server request after initialize,
    // then reads the client's response and confirms it via a notification.
    const server = join(tmpDir, 'respond-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n    // After initialize, send a server request (reverse RPC)\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: { sessionId: 's1', options: [{ optionId: 'approve_once', name: 'Approve', kind: 'approve_once' }] } }) + '\\n');\n    return;\n  }\n  // Client's response to our server request (has id + result, no method)\n  if (msg.id === 42 && msg.result !== undefined && !msg.method) {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'approval_confirmed', params: { responseId: msg.id, outcome: msg.result.outcome } }) + '\\n');\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'respond-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const confirmations: Array<{ responseId: number; outcome: unknown }> = [];
    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    const client = new JsonRpcClient(transport, {
      onNotification: (method, params) => {
        if (method === 'approval_confirmed') {
          confirmations.push(params as { responseId: number; outcome: unknown });
        }
      },
      onServerRequest: (id, _method, _params) => {
        // Auto-respond to approval requests
        client.respond(id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
      },
      onClose: () => {},
    });

    await client.connect();

    // Wait for the round-trip: server sends request → client responds → server confirms
    const deadline = Date.now() + 3000;
    while (confirmations.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(confirmations.length).toBeGreaterThan(0);
    expect(confirmations[0].responseId).toBe(42);
    expect((confirmations[0].outcome as { outcome: string }).outcome).toBe('selected');

    await client.dispose();
  }, 10000);

  it('throws ConnectionLostError when client is disposed', async () => {
    const { wrapper } = makeFakeServer(tmpDir, {});
    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    const client = new JsonRpcClient(transport, {
      onNotification: () => {},
      onServerRequest: () => {},
      onClose: () => {},
    });

    await client.connect();
    await client.dispose();

    await expect(client.request('session/new', {})).rejects.toThrow(ConnectionLostError);
  });

  it('sends literal initialize params: protocolVersion 1 + all-false clientCapabilities (R4)', async () => {
    const capturePath = join(tmpDir, 'init-capture.jsonl');
    const server = join(tmpDir, 'capture-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nimport { appendFileSync } from 'node:fs';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(msg) + '\\n');\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'capture-server.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({ binary: wrapper, args: [], cwd: tmpDir });
    const client = new JsonRpcClient(
      transport,
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onClose: () => {},
      },
      60_000,
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    );

    await client.connect();
    await client.dispose();

    const firstLine = readFileSync(capturePath, 'utf-8').trim().split('\n')[0];
    const captured = JSON.parse(firstLine) as { method: string; params?: unknown };
    expect(captured.method).toBe('initialize');
    expect(captured.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  });
});
