/**
 * Shared mock ACP server for integration tests of ACP-based runners
 * (kimi acp / opencode acp).
 *
 * Writes a self-contained mock server script (`acp-server.mjs`) that reads a
 * scenario config JSON from argv[2] and responds to JSON-RPC messages over
 * stdio. The same script serves both kimi and opencode protocol variants;
 * protocol-specific behavior is selected via config flags (see ScenarioOpts).
 *
 * All fixture data must be synthetic (AABB UUIDs, /home/user/project paths) —
 * CLAUDE.md red line: no real user data in test fixtures.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner, AgentEvent } from '../../src/runner/index.js';

/** Protocol-specific agent name echoed in the initialize result. */
export type AcpProtocol = 'kimi' | 'opencode';

export interface MockAcpScenarioOpts {
  sessionId?: string;
  notifications?: Array<{ method: string; params: unknown }>;
  stopReason?: string;
  delayMs?: number;
  /** Send an approval request (session/request_permission) during the prompt. */
  sendApproval?: boolean;
  /** (kimi) Send a question elicitation permission request (no toolCall). */
  sendQuestion?: boolean;
  /** (kimi) Send an elicitation/create form request during the prompt. */
  sendElicitation?: boolean;
  /** (opencode) Send an fs/write_text_file server request (client must reject). */
  sendFsWrite?: boolean;
  /** (kimi) Exit the process right after session/new (crash recovery test). */
  crashAfterInit?: boolean;
  /** Delay session/new and session/resume responses (setup-phase stop test). */
  delayNewMs?: number;
  capturePath?: string;
  wirePath?: string;
  compactionRecordDelayMs?: number;
  pidPath?: string;
  configOptions?: unknown[];
  /** (opencode) Hold the prompt result until the client answers a server request. */
  holdPromptUntilResponse?: boolean;
  /** (opencode) Hold the prompt result until session/cancel arrives. */
  holdPromptUntilCancel?: boolean;
  /** (opencode) Resume result omits sessionId (real opencode behavior). */
  resumeOmitsSessionId?: boolean;
}

const DEFAULT_SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

/**
 * Write the shared mock ACP server script into `tmpDir`. Call once per test
 * suite, then use `writeScenario` per test case.
 */
export function writeMockAcpServer(tmpDir: string): string {
  const server = join(tmpDir, 'acp-server.mjs');
  // 本 mock 的形状必须与协议类型同源；改协议先改类型再改 mock。
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const configPath = process.argv[2];
if (!configPath) { process.exit(1); }
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const rl = createInterface({ input: process.stdin });
if (config.pidPath) { writeFileSync(config.pidPath, String(process.pid)); }

let promptId = null;
let cancelSeen = false;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const sendPromptResult = () => {
  if (promptId === null) return;
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: config.stopReason || 'end_turn' } });
  promptId = null;
};

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Capture every outbound request for literal wire-shape assertions.
  if (config.capturePath) {
    appendFileSync(config.capturePath, JSON.stringify(msg) + '\\n');
  }

  // Client response to a server request (has id, no method): finish the
  // prompt if the scenario holds it.
  if (msg.method === undefined && msg.id !== undefined) {
    if (config.holdPromptUntilResponse) sendPromptResult();
    return;
  }

  if (msg.method === 'initialize') {
    // Protocol shape guard: protocolVersion (number) + clientCapabilities required
    if (msg.params?.protocolVersion !== 1 || !msg.params?.clientCapabilities) {
      process.stderr.write('MOCK_ASSERT: initialize invalid params\\n');
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params' } });
      return;
    }
    const agentInfo = config.agentName
      ? { name: config.agentName, version: '0.0.0-test' }
      : { name: 'mock-acp', version: '1.0.0' };
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo } });
    return;
  }
  if (msg.method === 'session/new') {
    // Protocol shape guard: mcpServers must be present (can be empty array)
    if (!msg.params || !Array.isArray(msg.params.mcpServers)) {
      process.stderr.write('MOCK_ASSERT: session/new missing mcpServers\\n');
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: mcpServers required' } });
      return;
    }
    if (config.crashAfterInit) {
      process.exit(1);
    }
    const respondNew = () => send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: config.sessionId, configOptions: config.configOptions ?? [] } });
    if (config.delayNewMs) setTimeout(respondNew, config.delayNewMs); else respondNew();
    return;
  }
  if (msg.method === 'session/resume') {
    const result = config.resumeOmitsSessionId
      ? { configOptions: config.configOptions ?? [] }
      : { sessionId: msg.params.sessionId, configOptions: config.configOptions ?? [] };
    const respondResume = () => send({ jsonrpc: '2.0', id: msg.id, result });
    if (config.delayNewMs) setTimeout(respondResume, config.delayNewMs); else respondResume();
    return;
  }
  if (msg.method === 'session/set_mode') {
    // Protocol shape guard: parameter name must be modeId (not mode)
    if (!msg.params || msg.params.modeId === undefined) {
      process.stderr.write('MOCK_ASSERT: session/set_mode missing modeId\\n');
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: modeId required' } });
      return;
    }
    // Explicit regression guard: reject old 'mode' field name
    if (msg.params.mode !== undefined) {
      process.stderr.write('MOCK_ASSERT: session/set_mode uses old "mode" field (must be "modeId")\\n');
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: use modeId not mode' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    // Protocol shape guard: configId + value required (opencode)
    if (!msg.params || msg.params.configId === undefined || msg.params.value === undefined) {
      process.stderr.write('MOCK_ASSERT: session/set_config_option missing configId/value\\n');
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: config.configOptions ?? [] } });
    return;
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    let delay = 20;
    if (config.sendApproval) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0', id: 42, method: 'session/request_permission',
          params: {
            sessionId: config.sessionId,
            toolCall: config.kimiApprovalShape
              ? { title: 'Bash', rawInput: '{"command":"rm -rf /tmp/test"}' }
              : {
                  toolCallId: 'call_perm', title: 'Bash: ls /home/user/project',
                  kind: 'bash', status: 'pending',
                  rawInput: { command: 'ls /home/user/project' },
                },
            options: config.kimiApprovalShape
              ? [
                  { optionId: 'approve_once', name: 'Approve once', kind: 'approve_once' },
                  { optionId: 'approve_always', name: 'Approve always', kind: 'approve_always' },
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ]
              : [
                  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
                  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
                  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
                ],
          },
        });
      }, delay);
      delay += 60;
    }
    if (config.sendQuestion) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0', id: 43, method: 'session/request_permission',
          params: { sessionId: config.sessionId, isQuestion: true, options: [{ optionId: 'skip', name: 'Skip', kind: 'skip' }] },
        });
      }, delay);
      delay += 40;
    }
    if (config.sendElicitation) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0', id: 44, method: 'elicitation/create',
          params: {
            sessionId: config.sessionId,
            toolCallId: 'call_q',
            mode: 'form',
            message: 'Which database?\\nPick frameworks',
            requestedSchema: {
              type: 'object',
              required: ['q0', 'q1'],
              properties: {
                q0: {
                  type: 'string',
                  title: 'Setup',
                  description: '',
                  oneOf: [
                    { const: 'PostgreSQL', title: 'PostgreSQL', description: 'Robust' },
                    { const: 'SQLite', title: 'SQLite', description: 'Lightweight' },
                  ],
                },
                q1: {
                  type: 'array',
                  title: 'Frameworks',
                  description: '',
                  minItems: 1,
                  items: {
                    anyOf: [
                      { const: 'React', title: 'React' },
                      { const: 'Vue', title: 'Vue' },
                    ],
                  },
                },
              },
            },
          },
        });
      }, delay);
      delay += 60;
    }
    if (config.sendFsWrite) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0', id: 43, method: 'fs/write_text_file',
          params: { sessionId: config.sessionId, path: '/home/user/project/file.ts', content: 'placeholder' },
        });
      }, delay);
      delay += 60;
    }
    for (const notif of (config.notifications || [])) {
      setTimeout(() => send({ jsonrpc: '2.0', method: notif.method, params: notif.params }), delay);
      delay += 20;
    }
    // kimi: simulate the background compaction completing after the prompt
    // settles — the runner must poll wire.jsonl for this record before
    // producing the result event.
    if (config.compactionRecordDelayMs !== undefined && config.wirePath) {
      setTimeout(() => {
        appendFileSync(
          config.wirePath,
          JSON.stringify({
            type: 'context.apply_compaction',
            summary: 'placeholder summary',
            compactedCount: 4,
            tokensBefore: 30000,
            tokensAfter: 15000,
            time: Date.now(),
          }) + '\\n',
        );
        if (config.doneMarker) {
          writeFileSync(config.doneMarker, '1');
        }
      }, delay + config.compactionRecordDelayMs);
    }
    if (config.holdPromptUntilResponse) return;
    if (config.holdPromptUntilCancel && !cancelSeen) return;
    setTimeout(sendPromptResult, delay + (config.delayMs || 0));
    return;
  }
  if (msg.method === 'session/cancel') {
    // session/cancel is a NOTIFICATION (no id, no response) per ACP spec.
    if (msg.id !== undefined) {
      process.stderr.write('MOCK_ASSERT: session/cancel must be a notification (no id)\\n');
    }
    cancelSeen = true;
    if (config.holdPromptUntilCancel) sendPromptResult();
    return;
  }
  // Default: respond with ok
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  }
});
`,
  );
  return server;
}

export interface WriteScenarioResult {
  wrapper: string;
  workspace: string;
}

/**
 * Write a scenario config and create a wrapper script.
 * Returns the wrapper script path and a real workspace directory.
 */
export function writeScenario(
  tmpDir: string,
  serverScript: string,
  protocol: AcpProtocol,
  opts: MockAcpScenarioOpts = {},
): WriteScenarioResult {
  const sessionId = opts.sessionId ?? DEFAULT_SESSION_ID;
  const workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const configPath = join(tmpDir, 'server-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      sessionId,
      stopReason: opts.stopReason ?? 'end_turn',
      notifications: opts.notifications ?? [],
      delayMs: opts.delayMs ?? 0,
      sendApproval: opts.sendApproval ?? false,
      sendQuestion: opts.sendQuestion ?? false,
      sendElicitation: opts.sendElicitation ?? false,
      sendFsWrite: opts.sendFsWrite ?? false,
      crashAfterInit: opts.crashAfterInit ?? false,
      delayNewMs: opts.delayNewMs ?? 0,
      capturePath: opts.capturePath ?? null,
      wirePath: opts.wirePath ?? null,
      compactionRecordDelayMs: opts.compactionRecordDelayMs ?? null,
      pidPath: opts.pidPath ?? null,
      configOptions: opts.configOptions ?? null,
      holdPromptUntilResponse: opts.holdPromptUntilResponse ?? false,
      holdPromptUntilCancel: opts.holdPromptUntilCancel ?? false,
      resumeOmitsSessionId: opts.resumeOmitsSessionId ?? false,
      kimiApprovalShape: protocol === 'kimi',
      agentName: protocol === 'kimi' ? 'kimi-acp' : 'OpenCode',
      doneMarker: opts.capturePath ? `${opts.capturePath}.done` : null,
    }),
  );

  const wrapper = join(tmpDir, 'acp-server.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "${configPath}"\n`,
  );
  chmodSync(wrapper, 0o755);

  return { wrapper, workspace };
}

/** Create a temp dir for the mock server (convenience for suites that need one). */
export function makeMockAcpTmpDir(prefix = 'lark-mock-acp-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── Shared ACP runner test harness ───────────────────────────────────
// Collected into this module because both kimi and opencode ACP runner tests
// use the same mock-server scenario + wrapper pattern and previously
// copy-pasted these helpers.

/**
 * Consume a runner's run() generator, collecting every event. An optional
 * onEvent hook runs per event (e.g. to stop mid-run).
 */
export async function collectEvents(
  runner: Runner,
  message: string,
  opts: { cwd: string; sessionId?: string },
  onEvent?: (ev: AgentEvent) => Promise<void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runner.run(message, opts)) {
    events.push(event);
    if (onEvent) await onEvent(event);
  }
  return events;
}

/**
 * Read a wrapper capture file (newline-delimited JSON, one record per line)
 * into an array of parsed records.
 */
export function readCapture(capturePath: string): Array<Record<string, unknown>> {
  return readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
