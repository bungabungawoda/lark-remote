import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcClient, RpcError, RpcTimeoutError, ConnectionLostError } from './client.js';
import { JsonlRpcTransport } from './transport.js';
import { rmRf } from '../../../../tests/lib/tmp-cleanup.js';

/**
 * 启动一个 Node 假 ACP server。fixture 平台中立：直接以 `process.execPath`
 * 启动脚本，**不再包一层 POSIX `#!/bin/sh` wrapper**（Windows 既不能执行
 * 无扩展名脚本、也不认 shebang，wrapper 会让子进程起不来 →
 * env/capture 文件缺失、exit:1 等假红）。
 */
function nodeLaunch(script: string, extraArgs: string[] = []) {
  return { binary: process.execPath, args: [script, ...extraArgs] };
}

/** Fake ACP server that answers initialize and handles requests. */
function makeFakeServer(
  tmpDir: string,
  handlers: Record<string, (msg: Record<string, unknown>) => unknown>,
): {
  server: string;
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
  return { server };
}

describe('JsonRpcClient request/response id matching', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-jsonrpc-client-'));
  });

  afterEach(() => {
    rmRf(tmpDir);
  });

  it('matches request/response by id', async () => {
    const { server } = makeFakeServer(tmpDir, {});
    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
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

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
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

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
    const client = new JsonRpcClient(
      transport,
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onClose: () => {},
      },
      2000, // 覆盖插桩/负载下子进程 boot 延迟不可控，500ms 过紧导致 flaky；语义仍为「缺响应→RpcTimeoutError」
    );

    await client.connect();

    await expect(client.request('session/new', {})).rejects.toThrow(RpcTimeoutError);

    await client.dispose();
  }, 10000);

  /**
   * 验证什么：`requestTimeoutMs: 0` = 不设请求超时（对齐同族里
   *   `turnIdleTimeoutMinutes`/`claude.idleTtlMinutes` 的「0 = 禁用」口径），
   *   不是「每个请求 0ms 超时」。
   * 缺失/错误会导致什么：schema 是 `.min(0)`，`Math.min(0, MAX)` 仍是 0，
   *   `setTimeout(..., 0)` 必然抢在子进程响应之前 reject → 用户在 YAML 里写
   *   `requestTimeoutMs: 0` 之后 codex/kimi/opencode 每一次 RPC 都超时，
   *   agent 整体不可用（且 dir.ts 正把这个键列给用户手改）。
   * 依据：clean_review §B9。
   */
  it('treats requestTimeoutMs 0 as "no timeout"', async () => {
    // initialize 立即回，其余请求延后 80ms 回——0ms 预算下必输给它。
    const server = join(tmpDir, 'delayed-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n    return;\n  }\n  setTimeout(() => {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');\n  }, 80);\n});\n`,
    );

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
    const client = new JsonRpcClient(
      transport,
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onClose: () => {},
      },
      0,
    );

    await client.connect();
    const result = await client.request<unknown, { ok: boolean }>('session/new', { cwd: tmpDir });
    expect(result.ok).toBe(true);

    await client.dispose();
  }, 10000);

  it('dispatches notifications to hooks', async () => {
    const server = join(tmpDir, 'notif-server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n  }\n  if (msg.method === 'trigger-notif') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { event: { type: 'agent_message_chunk', delta: 'hello' } } }) + '\\n');\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');\n  }\n});\n`,
    );

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });

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

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });

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

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
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

    const confirmations: Array<{ responseId: number; outcome: unknown }> = [];
    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
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
    const { server } = makeFakeServer(tmpDir, {});
    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
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

    const transport = new JsonlRpcTransport({ ...nodeLaunch(server), cwd: tmpDir });
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
