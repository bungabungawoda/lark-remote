import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from './connection-manager.js';
import { AgentStopperRegistry } from '../../../platform/agent-stopper.js';
import { binaryName } from '../../../platform/identity.js';
import { rmRf } from '../../../../tests/lib/tmp-cleanup.js';

/**
 * fixture 平台中立：直接以 `process.execPath` 启动 Node 假 server，不再包 POSIX
 * `#!/bin/sh` wrapper（Windows 起不来 → acquire 失败、pid 文件缺失等假红）。
 * pid 由脚本自写 `process.pid`——原先 `#!/bin/sh ... exec node` 里 `$$` 与 node
 * 同 pid，语义等价。
 */
function nodeLaunch(script: string) {
  return { binary: process.execPath, args: [script] };
}

/** Fake server that answers initialize, then exits after N ms. */
function makeExitServer(tmpDir: string, exitAfterMs: number): { script: string; pidFile: string } {
  const pidFile = join(tmpDir, 'server.pid');
  const server = join(tmpDir, 'exit-server.mjs');
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';\nimport { writeFileSync } from 'node:fs';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent', version: '1.0.0' } } }) + '\\n');\n    // 退出计时从「initialize 已应答」起算，而非进程启动：若按启动计时，\n    // 慢 CI（spawn + 运行时启动 + 握手往返 > N ms）下进程会在握手期间退出，\n    // initialize 被 failPending 判 ConnectionLostError，acquire 直接假红。\n    setTimeout(() => process.exit(0), ${exitAfterMs});\n  }\n});\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`,
  );
  return { script: server, pidFile };
}

/** Fake server that answers initialize and stays alive. */
function makeIdleServer(tmpDir: string): { script: string; pidFile: string } {
  const pidFile = join(tmpDir, 'idle-server.pid');
  const server = join(tmpDir, 'idle-server.mjs');
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';\nimport { writeFileSync } from 'node:fs';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent', version: '1.0.0' } } }) + '\\n');\n  }\n});\nsetInterval(() => {}, 60000);\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`,
  );
  return { script: server, pidFile };
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

describe('ConnectionManager hook layering', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-cm-'));
  });

  afterEach(() => {
    rmRf(tmpDir);
  });

  it('test_anchor_connection_lost_cleanup_survives_runner_setHooks', async () => {
    // 回归：runner 用 setHooks 替换 per-run hooks 后，连接层的
    // slot 清理 + onConnectionLost 必须仍然触发（曾整体覆盖导致死 slot 残留、
    // onConnectionLost 无人订阅）。
    const { script, pidFile } = makeExitServer(tmpDir, 100);

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
      initializeParams: INIT_PARAMS,
    });
    const lost = new Promise<string>((resolve) => {
      manager.onConnectionLost = (cwd) => resolve(cwd);
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
    const cwd = await lost;
    expect(cwd).toBe(tmpDir);
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
    const { script } = makeExitServer(tmpDir, 50);

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
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
    const { script } = makeIdleServer(tmpDir);

    vi.useFakeTimers();

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
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

  /**
   * 验证什么：`idleTtlMs: 0` = 禁用空闲回收（连接常驻），不是「立即回收」。
   * 缺失/错误会导致什么：同仓库其它 TTL 一律「0 = 不回收」（claude
   *   `session.ts` armIdleTimer 的 `<= 0` 守卫、`claude.idleTtlMinutes` schema
   *   注释），而这里 0 会 setTimeout(...,0) 把刚建好的连接秒删——用户在 YAML
   *   里照 `dir.ts` 的引导手改这个键，得到的是"每条消息都重起进程"。
   * 两种语义取其一并对齐注释，这里统一到 0=禁用。
   */
  it('idleTtlMs 0 disables idle recycling instead of dropping the connection', async () => {
    const { script } = makeIdleServer(tmpDir);

    vi.useFakeTimers();

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
      idleTtlMs: 0,
      initializeParams: INIT_PARAMS,
    });

    const client = await manager.acquire(tmpDir);
    expect(client.ready).toBe(true);

    manager.notifyIdle(tmpDir);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.healthy).toBe(true);

    vi.useRealTimers();
    await manager.disposeAll();
  }, 10000);

  it('notifyActivity disarms idle timer', async () => {
    const { script } = makeIdleServer(tmpDir);

    vi.useFakeTimers();

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
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
    const { script } = makeIdleServer(tmpDir);

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
      initializeParams: INIT_PARAMS,
    });

    // Concurrent acquire calls should return the same client
    const [c1, c2] = await Promise.all([manager.acquire(tmpDir), manager.acquire(tmpDir)]);

    expect(c1).toBe(c2);

    await manager.disposeAll();
  }, 10000);

  it('disposeAll cleans up all connections', async () => {
    const { script } = makeIdleServer(tmpDir);

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
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

  it('test_anchor_connection_manager_plumbs_cooperative_stop_channel', async () => {
    // runner 只提供「通道工厂」，登记/注销由连接层负责——连接是
    // agent 进程的生命周期边界，pid 也只有这里知道（transport.pid）。
    // 工厂必须拿到**连接本身**：协议取消只能发在这条连接上。
    const { script, pidFile } = makeIdleServer(tmpDir);
    const stoppers = new AgentStopperRegistry();
    const seen: Array<{ pid: number; client: unknown }> = [];

    const manager = new ConnectionManager({
      ...nodeLaunch(script),
      initializeParams: INIT_PARAMS,
      stoppers,
    });
    // 与 kimi/opencode 同款接线方式：runner 在构造后赋值（manager 建在 super()
    // 实参里时 this 尚不可用）
    manager.stopper = ({ pid, client }) => {
      seen.push({ pid, client });
      return () => {};
    };

    const client = await manager.acquire(tmpDir);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(seen).toEqual([{ pid, client }]);
    // agent 键取 binary 名（与 transport 建 Terminator 时同一来源，保证查表命中）
    expect(stoppers.has(binaryName(process.execPath), pid)).toBe(true);

    await manager.disposeAll();
    expect(stoppers.has(binaryName(process.execPath), pid)).toBe(false);
  }, 10000);
});

/**
 * 替换连接必须先等旧连接 dispose 完成。
 * 用内存 fake client 控制 dispose 时序，不 spawn 任何进程。
 */
describe('ConnectionManager replacement serialization', () => {
  interface FakeClient {
    name: string;
    ready: boolean;
    healthy: boolean;
    connect(): Promise<unknown>;
    dispose(): Promise<void>;
    disposed: boolean;
  }

  function makeManager(log: string[], opts?: { disposeDelayMs?: number; failDispose?: boolean }) {
    let seq = 0;
    const clients: FakeClient[] = [];
    const manager = new ConnectionManager<FakeClient>({
      binary: 'unused-in-fake-client-test',
      args: [],
      clientFactory: () => {
        const name = `c${++seq}`;
        const client: FakeClient = {
          name,
          ready: true,
          healthy: true,
          disposed: false,
          connect: async () => {
            log.push(`connect-${name}`);
            return {};
          },
          dispose: async () => {
            log.push(`dispose-${name}:start`);
            if (opts?.disposeDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, opts.disposeDelayMs));
            }
            client.healthy = false;
            client.disposed = true;
            log.push(`dispose-${name}:end`);
            if (opts?.failDispose) throw new Error('dispose failed');
          },
        };
        clients.push(client);
        return client;
      },
    });
    return { manager, clients };
  }

  it('test_anchor_connection_manager_awaits_old_dispose', async () => {
    const log: string[] = [];
    const { manager } = makeManager(log, { disposeDelayMs: 25 });

    const first = await manager.acquire('/workspace/a');
    // Make the cached connection non-reusable (connection lost / stale config).
    first.healthy = false;

    const second = await manager.acquire('/workspace/a');
    expect(second).not.toBe(first);

    // dispose-end 必须早于下一个 connect：旧实现 fire-and-forget 会让
    // connect-c2 落在 dispose-c1:start 与 dispose-c1:end 之间。
    const disposeEnd = log.indexOf('dispose-c1:end');
    const connect2 = log.indexOf('connect-c2');
    expect(disposeEnd).toBeGreaterThan(-1);
    expect(connect2).toBeGreaterThan(disposeEnd);

    await manager.disposeAll();
  });

  it('concurrent replacement creates exactly one new connection', async () => {
    const log: string[] = [];
    const { manager, clients } = makeManager(log, { disposeDelayMs: 10 });

    const first = await manager.acquire('/workspace/a');
    first.healthy = false;

    const [a, b] = await Promise.all([
      manager.acquire('/workspace/a'),
      manager.acquire('/workspace/a'),
    ]);
    expect(a).toBe(b);
    // c1（旧）+ c2（唯一的新连接），不能因为两个 acquire 都判陈旧而各建一条。
    expect(clients.map((c) => c.name)).toEqual(['c1', 'c2']);

    await manager.disposeAll();
  });

  it('disposes a connection whose slot was released during create (no orphan)', async () => {
    const log: string[] = [];
    let releaseConnect: (() => void) | undefined;
    let seq = 0;
    const clients: FakeClient[] = [];
    const manager = new ConnectionManager<FakeClient>({
      binary: 'unused-in-fake-client-test',
      args: [],
      clientFactory: () => {
        const name = `c${++seq}`;
        const client: FakeClient = {
          name,
          ready: true,
          healthy: true,
          disposed: false,
          connect: async () => {
            log.push(`connect-${name}:start`);
            if (name === 'c1') {
              await new Promise<void>((resolve) => {
                releaseConnect = resolve;
              });
            }
            log.push(`connect-${name}:end`);
            return {};
          },
          dispose: async () => {
            log.push(`dispose-${name}`);
            client.disposed = true;
            client.healthy = false;
          },
        };
        clients.push(client);
        return client;
      },
    });

    const pending = manager.acquire('/workspace/a');
    // connect 在途 → release 把 slot 删掉；落定的新连接不能无人管理。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.release('/workspace/a');
    releaseConnect?.();

    const client = await pending;
    expect(client.name).toBe('c2');
    expect(clients[0]?.disposed).toBe(true);

    await manager.disposeAll();
  });

  it('aborts replacement when the old connection cannot be disposed', async () => {
    const log: string[] = [];
    const { manager, clients } = makeManager(log, { failDispose: true });
    const first = await manager.acquire('/workspace/a');
    first.healthy = false;

    await expect(manager.acquire('/workspace/a')).rejects.toThrow('failed to dispose');
    // 旧连接 dispose 失败时不得再建新连接（否则两个 agent server 重叠）。
    expect(clients).toHaveLength(1);
  });
});
