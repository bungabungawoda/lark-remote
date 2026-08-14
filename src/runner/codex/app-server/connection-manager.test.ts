import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from './connection-manager.js';

/** Fake app-server that answers initialize, then exits after 50ms. */
const EXIT_SERVER_SOURCE = `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-cli/0.147.0', codexHome: '/home/user/.codex', platformFamily: 'unix', platformOs: 'macos' } }) + '\\n');
    setTimeout(() => process.exit(0), 50);
  }
});
`;

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
    const exitServer = join(tmpDir, 'exit-server.mjs');
    writeFileSync(exitServer, EXIT_SERVER_SOURCE);
    const pidFile = join(tmpDir, 'server.pid');
    const wrapper = join(tmpDir, 'exit-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" "${exitServer}"\n`,
    );
    chmodSync(wrapper, 0o755);

    const manager = new ConnectionManager({ binary: wrapper, args: [] });
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
  });
});
