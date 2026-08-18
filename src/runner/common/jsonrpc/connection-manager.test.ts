import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from './connection-manager.js';

/** Fake server that answers initialize, then exits after N ms. */
function makeExitServer(tmpDir: string, exitAfterMs: number): { wrapper: string; pidFile: string } {
  const pidFile = join(tmpDir, 'server.pid');
  const server = join(tmpDir, 'exit-server.mjs');
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent', version: '1.0.0' } } }) + '\\n');\n  }\n});\nsetTimeout(() => process.exit(0), ${exitAfterMs});\n`,
  );
  const wrapper = join(tmpDir, 'exit-server.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" "${server}"\n`,
  );
  chmodSync(wrapper, 0o755);
  return { wrapper, pidFile };
}

/** Fake server that answers initialize and stays alive. */
function makeIdleServer(tmpDir: string): { wrapper: string; pidFile: string } {
  const pidFile = join(tmpDir, 'idle-server.pid');
  const server = join(tmpDir, 'idle-server.mjs');
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent', version: '1.0.0' } } }) + '\\n');\n  }\n});\nsetInterval(() => {}, 60000);\n`,
  );
  const wrapper = join(tmpDir, 'idle-server.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" "${server}"\n`,
  );
  chmodSync(wrapper, 0o755);
  return { wrapper, pidFile };
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

describe('ConnectionManager hook layering (review P2-1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-cm-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_connection_lost_cleanup_survives_runner_setHooks', async () => {
    // review P2-1 回归：runner 用 setHooks 替换 per-run hooks 后，连接层的
    // slot 清理 + onConnectionLost 必须仍然触发（曾整体覆盖导致死 slot 残留、
    // onConnectionLost 无人订阅）。
    const { wrapper, pidFile } = makeExitServer(tmpDir, 100);

    const manager = new ConnectionManager({
      binary: wrapper,
      args: [],
      initializeParams: INIT_PARAMS,
    });
    const lost = new Promise<string>((resolve) => {
      manager.onConnectionLost = (workspace) => resolve(workspace);
    });

    const client = await manager.acquire(tmpDir);
    // 模拟 runner 在 turn setup 时替换 per-run hooks。
    let runOnCloseFired = false;
    client.setHooks({
      onNotification: () => {},
      onServerRequest: () => {},
      onClose: () => {
        runOnCloseFired = true;
      },
    });

    // 进程被外部杀掉（模拟 crash）：base hooks 的 slot 清理必须生效。
    const workspace = await lost;
    expect(workspace).toBe(tmpDir);
    expect(runOnCloseFired).toBe(true);

    // 死连接已从 slot 移除：重新 acquire 必须拉起全新进程，而不是复用旧 client。
    const pid1 = Number(readFileSync(pidFile, 'utf8').trim());
    const client2 = await manager.acquire(tmpDir);
    expect(client2).not.toBe(client);
    const pid2 = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid2).toBeGreaterThan(0);
    expect(pid2).not.toBe(pid1);

    await manager.disposeAll();
  }, 10000);

  it('connection lost disposes and re-acquire creates new connection', async () => {
    const { wrapper } = makeExitServer(tmpDir, 50);

    const manager = new ConnectionManager({
      binary: wrapper,
      args: [],
      initializeParams: INIT_PARAMS,
    });
    const client1 = await manager.acquire(tmpDir);
    expect(client1.ready).toBe(true);

    // Wait for process to exit
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Client should no longer be healthy
    expect(client1.healthy).toBe(false);

    // Re-acquire should create a new connection
    const client2 = await manager.acquire(tmpDir);
    expect(client2).not.toBe(client1);
    expect(client2.ready).toBe(true);

    await manager.disposeAll();
  }, 10000);

  it('idle TTL releases connection', async () => {
    const { wrapper } = makeIdleServer(tmpDir);

    vi.useFakeTimers();

    const manager = new ConnectionManager({
      binary: wrapper,
      args: [],
      idleTtlMs: 1000, // 1s idle TTL for fast test
      initializeParams: INIT_PARAMS,
    });

    const client = await manager.acquire(tmpDir);
    expect(client.ready).toBe(true);

    // Mark as idle — arms the timer
    manager.notifyIdle(tmpDir);

    // Advance past idle TTL
    vi.advanceTimersByTime(1500);
    await vi.advanceTimersByTimeAsync(0); // flush any async cleanup

    // Client should be disposed after idle timeout
    expect(client.healthy).toBe(false);

    vi.useRealTimers();
    await manager.disposeAll();
  }, 10000);

  it('notifyActivity disarms idle timer', async () => {
    const { wrapper } = makeIdleServer(tmpDir);

    vi.useFakeTimers();

    const manager = new ConnectionManager({
      binary: wrapper,
      args: [],
      idleTtlMs: 1000,
      initializeParams: INIT_PARAMS,
    });

    const client = await manager.acquire(tmpDir);
    expect(client.ready).toBe(true);

    // Mark as idle
    manager.notifyIdle(tmpDir);

    // Activity before TTL disarms the timer
    vi.advanceTimersByTime(500);
    manager.notifyActivity(tmpDir);

    // Advance past original TTL — should NOT have been released
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.healthy).toBe(true);

    vi.useRealTimers();
    await manager.disposeAll();
  }, 10000);

  it('acquire serializes concurrent calls', async () => {
    const { wrapper } = makeIdleServer(tmpDir);

    const manager = new ConnectionManager({
      binary: wrapper,
      args: [],
      initializeParams: INIT_PARAMS,
    });

    // Concurrent acquire calls should return the same client
    const [c1, c2] = await Promise.all([manager.acquire(tmpDir), manager.acquire(tmpDir)]);

    expect(c1).toBe(c2);

    await manager.disposeAll();
  }, 10000);

  it('disposeAll cleans up all connections', async () => {
    const { wrapper } = makeIdleServer(tmpDir);

    const manager = new ConnectionManager({
      binary: wrapper,
      args: [],
      initializeParams: INIT_PARAMS,
    });

    const client = await manager.acquire(tmpDir);
    expect(client.ready).toBe(true);

    await manager.disposeAll();

    expect(client.healthy).toBe(false);
  }, 10000);

  it('ENOENT: acquire throws ConnectionLostError for missing binary', async () => {
    const manager = new ConnectionManager({
      binary: '/nonexistent/binary-that-does-not-exist',
      args: [],
      initializeParams: INIT_PARAMS,
    });

    await expect(manager.acquire(tmpDir)).rejects.toThrow();
  }, 10000);
});
