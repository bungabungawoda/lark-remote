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
    setTimeout(() => write({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th-active', turn: { id: 'tn-active', items: [], status: 'inProgress' } } }), 20);
    setTimeout(() => write({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'th-active', turnId: 'tn-active', itemId: 'item-1', delta: 'working' } }), 40);
    setTimeout(() => write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-active', turn: { id: 'tn-active', items: [{ type: 'agentMessage', id: 'item-1', text: 'done', phase: 'final_answer' }], status: 'completed' } } }), 80);
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
