import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlRpcTransport } from './transport.js';

function waitForProcessGone(pid: number, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`process ${pid} is still alive`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('JsonlRpcTransport safety and cleanup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-transport-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SECRET_TEST_VAR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  });

  it('test_anchor_transport_forwards_full_env_including_provider_keys', async () => {
    // agent 是用户自己的可信二进制，provider 认证靠 OPENAI_API_KEY / 自定义
    // provider 的 env_key，代理环境靠 HTTP(S)_PROXY。此前收窄到 5 键白名单
    // 会打断认证与网络，因此必须全量透传 process.env。回归锚点：白名单收窄
    // 曾导致 provider env key 到不了子进程（认证失败）。
    const dumpFile = join(tmpDir, 'env.txt');
    const wrapper = join(tmpDir, 'env-dump.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\n` +
        `printf '%s\\n' "OPENAI_API_KEY=\${OPENAI_API_KEY-}" "DEEPSEEK_API_KEY=\${DEEPSEEK_API_KEY-}" "HTTP_PROXY=\${HTTP_PROXY-}" "HTTPS_PROXY=\${HTTPS_PROXY-}" "SECRET_TEST_VAR=\${SECRET_TEST_VAR-}" > "${dumpFile}"\n`,
    );
    chmodSync(wrapper, 0o755);
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    process.env.SECRET_TEST_VAR = 'passes-through';

    const transport = new JsonlRpcTransport({
      binary: wrapper,
      args: [],
      cwd: tmpDir,
    });

    await new Promise<void>((resolve) => {
      void transport.start({ onMessage: () => {}, onClose: () => resolve() });
    });

    const lines = readFileSync(dumpFile, 'utf8').split('\n').filter(Boolean);
    const env = Object.fromEntries(lines.map((l) => l.split('=')));
    // provider 认证键（官方 + 自定义 env_key）与代理键必须全部到达子进程
    expect(env.OPENAI_API_KEY).toBe('sk-test-openai');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-test-deepseek');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    // 普通 process.env 键同样全量透传
    expect(env.SECRET_TEST_VAR).toBe('passes-through');
  });

  it('test_anchor_transport_env_override_wins_over_process_env', async () => {
    // 调用方显式传入的 env（ConnectionManager → runner opts.env）覆盖
    // process.env 同名键；未传入的键仍来自 process.env 全量透传。
    const dumpFile = join(tmpDir, 'env-override.txt');
    const wrapper = join(tmpDir, 'env-override.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "OPENAI_API_KEY=\${OPENAI_API_KEY-}" "PATH=\${PATH-}" > "${dumpFile}"\n`,
    );
    chmodSync(wrapper, 0o755);
    process.env.OPENAI_API_KEY = 'sk-process-env';

    const transport = new JsonlRpcTransport({
      binary: wrapper,
      args: [],
      cwd: tmpDir,
      env: { OPENAI_API_KEY: 'sk-caller-override' },
    });

    await new Promise<void>((resolve) => {
      void transport.start({ onMessage: () => {}, onClose: () => resolve() });
    });

    const dump = readFileSync(dumpFile, 'utf8');
    expect(dump.trim()).toContain('OPENAI_API_KEY=sk-caller-override');
    expect(dump.trim()).toContain('PATH=');
  });

  it('test_anchor_transport_writes_messages_in_order', async () => {
    // review P3-8：write() 走有界队列 + drain 续发，多条消息必须保序到达。
    const outFile = join(tmpDir, 'received.txt');
    const collect = join(tmpDir, 'collect-lines.mjs');
    writeFileSync(
      collect,
      `import { createInterface } from 'node:readline';\nimport { appendFileSync } from 'node:fs';\nconst out = process.argv[2];\nconst rl = createInterface({ input: process.stdin });\nlet count = 0;\nrl.on('line', (line) => {\n  appendFileSync(out, line + '\\n');\n  count++;\n  if (count === 3) process.exit(0);\n});\n`,
    );
    const wrapper = join(tmpDir, 'echo-lines.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${collect}" "$1"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({
      binary: wrapper,
      args: [outFile],
      cwd: tmpDir,
    });

    const closed = new Promise<void>((resolve) => {
      void transport.start({ onMessage: () => {}, onClose: () => resolve() });
    });
    transport.write({ jsonrpc: '2.0', id: 1, method: 'one' });
    transport.write({ jsonrpc: '2.0', id: 2, method: 'two' });
    transport.write({ jsonrpc: '2.0', id: 3, method: 'three' });
    await closed;

    const lines = readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it('test_anchor_transport_kills_child_on_oversized_line', async () => {
    const pidFile = join(tmpDir, 'child.pid');
    const wrapper = join(tmpDir, 'huge-line.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" -e 'process.stdout.write("x".repeat(10 * 1024 * 1024 + 1) + "\\n"); setInterval(() => {}, 1000)'\n`,
    );
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({
      binary: wrapper,
      args: [],
      cwd: tmpDir,
    });

    const reason = await new Promise<string>((resolve) => {
      void transport.start({ onMessage: () => {}, onClose: resolve });
    });

    expect(reason).toBe('parse_error');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitForProcessGone(pid, 10000);
  }, 15000);

  it('test_anchor_transport_closes_on_epipe_and_kills_child', async () => {
    const pidFile = join(tmpDir, 'epipe-child.pid');
    const wrapper = join(tmpDir, 'epipe-child.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" -e 'require("fs").closeSync(0); setInterval(() => {}, 1000)'\n`,
    );
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({
      binary: wrapper,
      args: [],
      cwd: tmpDir,
    });

    let closeResolve: (reason: string) => void = () => {};
    const closed = new Promise<string>((resolve) => {
      closeResolve = resolve;
    });
    await transport.start({ onMessage: () => {}, onClose: closeResolve });
    await new Promise((resolve) => setTimeout(resolve, 500));
    transport.write({ method: 'ping' });

    const reason = await closed;
    expect(reason).toBe('epipe');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitForProcessGone(pid, 3000);
  }, 10000);

  it('receives NDJSON messages line by line', async () => {
    const wrapper = join(tmpDir, 'ndjson-server.sh');
    const server = join(tmpDir, 'server.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } }) + '\\n');\n  }\n  if (msg.method === 'ping') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'pong' }) + '\\n');\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { event: { type: 'agent_message_chunk', delta: 'hi' } } }) + '\\n');\n  }\n});\n`,
    );
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(wrapper, 0o755);

    const transport = new JsonlRpcTransport({
      binary: wrapper,
      args: [],
      cwd: tmpDir,
    });

    const messages: unknown[] = [];
    await transport.start({
      onMessage: (msg) => messages.push(msg),
      onClose: () => {},
    });

    transport.write({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    transport.write({ jsonrpc: '2.0', id: 2, method: 'ping' });

    // Wait for messages to arrive
    await new Promise((resolve) => setTimeout(resolve, 500));
    await transport.close();

    // Should have received the initialize response, ping response, and notification
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const initResp = messages.find(
      (m) => (m as Record<string, unknown>).id === 1 && 'result' in (m as object),
    );
    expect(initResp).toBeDefined();
    const pongResp = messages.find(
      (m) => (m as Record<string, unknown>).id === 2 && 'result' in (m as object),
    );
    expect(pongResp).toBeDefined();
  }, 10000);
});
