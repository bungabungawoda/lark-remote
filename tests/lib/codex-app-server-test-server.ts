import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IDLE_SERVER_SCRIPT = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const logPath = process.argv[2];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-cli/0.147.0', codexHome: '/home/user/.codex', platformFamily: 'unix', platformOs: 'macos' } }) + '\\n');
  } else if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'th-idle', sessionId: 'sess-idle', status: { type: 'idle' }, cwd: '/home/user/project', preview: '', turns: [], createdAt: 1, updatedAt: 1, modelProvider: 'deepseek', cliVersion: '0.147.0', ephemeral: false } } }) + '\\n');
  } else if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'tn-idle', items: [], status: 'inProgress' } } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`;

const ACTIVE_SERVER_SCRIPT = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const logPath = process.argv[2];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-cli/0.147.0', codexHome: '/home/user/.codex', platformFamily: 'unix', platformOs: 'macos' } }) + '\\n');
  } else if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'th-active', sessionId: 'sess-active', status: { type: 'idle' }, cwd: '/home/user/project', preview: '', turns: [], createdAt: 1, updatedAt: 1, modelProvider: 'deepseek', cliVersion: '0.147.0', ephemeral: false } } }) + '\\n');
  } else if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'tn-active', items: [], status: 'inProgress' } } }) + '\\n');
    const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    // 时序设计（配合 turnTimeoutMs=400 的滚动重置用例）：
    // - idle 窗口从 run() 启动就开始计（覆盖子进程冷启动 + 建连），CI 慢环境
    //   冷启动可达 ~50ms+，60/80ms 级裕度会被吃光导致假红（2026-09-06 修复）。
    // - turn/completed 刻意放在 500ms > 400ms 初始 deadline：若滚动重置坏掉
    //   （定时器从不因通知重置），turn 必在 completed 前超时 → 用例确定性地
    //   变红，锚点才有区分能力。最后一次通知（delta @200）把 deadline 推到
    //   冷启动+600ms，completed 在冷启动+500ms 到达，正常路径余量 ≥100ms。
    setTimeout(() => write({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th-active', turn: { id: 'tn-active', items: [], status: 'inProgress' } } }), 100);
    setTimeout(() => write({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'th-active', turnId: 'tn-active', itemId: 'item-1', delta: 'working' } }), 200);
    setTimeout(() => write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-active', turn: { id: 'tn-active', items: [{ type: 'agentMessage', id: 'item-1', text: 'done', phase: 'final_answer' }], status: 'completed' } } }), 500);
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`;

export function writeIdleServerScript(tmpDir: string): string {
  const server = join(tmpDir, 'idle-server.mjs');
  writeFileSync(server, IDLE_SERVER_SCRIPT);
  return server;
}

export function writeActiveServerScript(tmpDir: string): string {
  const server = join(tmpDir, 'active-server.mjs');
  writeFileSync(server, ACTIVE_SERVER_SCRIPT);
  return server;
}
