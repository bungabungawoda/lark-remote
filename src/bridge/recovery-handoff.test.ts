import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { RecoveryHandoff, RecoveryMemoryClient, isContextOverflow } from './recovery-handoff.js';
import type { RunState } from '../card/run-state.js';
import { Bridge } from './index.js';
import { SessionStore } from '../session/index.js';
import { AppConfigSchema } from '../config/index.js';
import type { AgentEvent, AgentKind, SpawnOptions } from '../runner/types.js';
import { ClaudeSessionReader } from '../session/claude/session-reader.js';
import { PiSessionReader } from '../session/pi/sessions.js';
import { CodexSessionReader } from '../session/codex/sessions.js';
import { encodeProjectDirName } from '../platform/path.js';
import { createRollout, metaLine } from '../../tests/lib/codex-rollout-fixture.js';
import {
  createStubConnector,
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
} from '../../tests/lib/bridge-stubs.js';

const dirs: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const scope = { userId: 'owner', cwd: '/workspace', agent: 'claude' as const };
function state(terminal: RunState['terminal'], errorMsg?: string): RunState {
  return { runId: 'run-1', terminal, errorMsg, footer: null, blocks: [], sessionId: 'old' };
}
function fail(
  store: RecoveryHandoff,
  error = 'Your input exceeds the context window of this model',
) {
  store.record(scope, {
    state: state('error', error),
    sessionId: 'old',
    sourceCwd: scope.cwd,
    transcriptPath: '/transcript/old.jsonl',
    request: 'Finish tests sk-secret123456',
  });
}

describe('recovery state', () => {
  it('distinguishes overflow from generic 400 and connection errors', () => {
    for (const s of [
      'context_length_exceeded',
      'context_window_exceeded',
      'Prompt is too long',
      'Input tokens exceed the model context limit.',
      'Your input exceeds the context window of this model',
    ]) {
      expect(isContextOverflow(s)).toBe(true);
    }
    expect(isContextOverflow('API 400 invalid request')).toBe(false);
    expect(isContextOverflow('connection closed')).toBe(false);
  });

  it('persists bounded checkpoint, provenance and restart-safe pending with isolation', () => {
    const dir = temp();
    const store = new RecoveryHandoff(dir);
    store.record(scope, {
      state: state('done'),
      sessionId: 'old',
      sourceCwd: scope.cwd,
      request: 'ok',
    });
    fail(store);
    const restarted = new RecoveryHandoff(dir);
    expect(restarted.read(scope).pending?.lastSuccess?.runId).toBe('run-1');
    expect(restarted.read(scope).pending?.request).not.toContain('sk-secret');
    expect(restarted.prepare(scope, 'old')?.fresh).toBe(true);
    expect(restarted.prepare(scope, undefined)).toBeUndefined();
    expect(restarted.prepare(scope, 'unrelated')).toBeUndefined();
    for (const other of [
      { ...scope, agent: 'pi' as const },
      { ...scope, cwd: '/other' },
      { ...scope, userId: 'other' },
    ]) {
      expect(restarted.prepare(other, 'old')).toBeUndefined();
    }
    if (process.platform !== 'win32')
      expect(fs.statSync(store.filePath(scope)).mode & 0o777).toBe(0o600);
  });

  it('retains pending across failed spawn and acknowledges only successful continuation', () => {
    const store = new RecoveryHandoff(temp());
    fail(store);
    store.record(scope, {
      state: state('error', 'spawn failed'),
      sessionId: 'old',
      sourceCwd: scope.cwd,
      request: 'continue',
      recoveryId: 'run-1',
    });
    expect(store.prepare(scope, 'old')?.fresh).toBe(true);
    store.bind(scope, 'run-1', 'replacement');
    expect(store.prepare(scope, 'replacement')?.fresh).toBe(false);
    store.record(scope, {
      state: state('interrupted'),
      sessionId: 'replacement',
      sourceCwd: scope.cwd,
      request: 'stop',
      recoveryId: 'run-1',
    });
    expect(store.read(scope).pending?.acknowledged).toBeUndefined();
    store.record(scope, {
      state: state('done'),
      sessionId: 'replacement',
      sourceCwd: scope.cwd,
      request: 'continue',
      recoveryId: 'run-1',
    });
    expect(store.prepare(scope, 'replacement')).toBeUndefined();
    expect(fs.existsSync(store.artifactPath(scope, 'run-1'))).toBe(true);
  });

  it('retains original provenance when a replacement also overflows', () => {
    const store = new RecoveryHandoff(temp());
    fail(store);
    store.bind(scope, 'run-1', 'replacement');
    store.record(scope, {
      state: state('error', 'context_length_exceeded'),
      sessionId: 'replacement',
      sourceCwd: scope.cwd,
      transcriptPath: '/replacement.jsonl',
      request: 'continue',
      recoveryId: 'run-1',
    });
    expect(store.read(scope).pending?.originSessionId).toBe('old');
    expect(store.prepare(scope, 'replacement')?.fresh).toBe(true);
  });

  it('syncs exact isolated handoff once, retains local state on outage and confirms only success', async () => {
    const client = new RecoveryMemoryClient();
    const call = vi.spyOn(client, 'call').mockRejectedValueOnce(new Error('offline'));
    const store = new RecoveryHandoff(temp(), client);
    fail(store);
    await store.sync(scope);
    expect(store.read(scope).pending).toBeDefined();
    call
      .mockResolvedValueOnce({ handoffs: [] })
      .mockResolvedValueOnce({ handoff: { id: 'memory-1' } });
    await store.sync(scope);
    expect(store.read(scope).pending?.memoryId).toBe('memory-1');
    await store.sync(scope);
    expect(call).toHaveBeenCalledTimes(3);
    const payload = call.mock.calls[2][1];
    expect(payload.workspace).toBe('remote-recovery');
    expect(JSON.stringify(payload)).not.toContain('Finish tests');
    store.record(scope, {
      state: state('done'),
      sessionId: 'new',
      sourceCwd: scope.cwd,
      request: 'continue',
      recoveryId: 'run-1',
    });
    call.mockResolvedValueOnce({ handoff: { id: 'memory-1' } });
    await store.sync(scope);
    expect(call.mock.calls[3][1].handoff_id).toBe('memory-1');
    expect(store.read(scope).pending?.memoryAcknowledged).toBe(true);
  });

  it('deduplicates publish after a lost response', async () => {
    const client = new RecoveryMemoryClient();
    const call = vi
      .spyOn(client, 'call')
      .mockResolvedValue({ handoffs: [{ id: 'existing', summary: 'Recovery run-1' }] });
    const store = new RecoveryHandoff(temp(), client);
    fail(store);
    await store.sync(scope);
    expect(store.read(scope).pending?.memoryId).toBe('existing');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('bounded ai-memory transport', () => {
  it('handles first-use scope, rejects errors/oversized responses, and aborts slow requests', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/missing') {
        res.end(
          JSON.stringify({
            error: { code: -32602, message: "workspace 'remote-recovery' not found" },
          }),
        );
      } else if (req.url === '/missing-project') {
        res.end(
          JSON.stringify({
            error: {
              code: -32602,
              message: "project 'p' not found in workspace 'remote-recovery'",
            },
          }),
        );
      } else if (req.url === '/denied') {
        res.writeHead(401).end('unauthorized');
      } else if (req.url === '/large') {
        res.end('x'.repeat(140 * 1024));
      } else if (req.url === '/rpc-error') {
        res.end(JSON.stringify({ result: { isError: true, content: [] } }));
      }
      // /slow deliberately never responds.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const client = (route: string) =>
      new RecoveryMemoryClient(`http://127.0.0.1:${port}/${route}`, 100);
    try {
      await expect(
        client('missing').call('memory_handoff_list', { workspace: 'remote-recovery' }),
      ).resolves.toEqual({
        handoffs: [],
      });
      await expect(client('missing').call('memory_handoff_begin', {})).rejects.toThrow();
      await expect(
        client('missing-project').call('memory_handoff_list', {
          workspace: 'remote-recovery',
          project: 'p',
        }),
      ).resolves.toEqual({ handoffs: [] });
      await expect(client('denied').call('memory_handoff_list', {})).rejects.toThrow('401');
      await expect(client('large').call('memory_handoff_list', {})).rejects.toThrow('too large');
      await expect(client('rpc-error').call('memory_handoff_list', {})).rejects.toThrow(
        'RPC failed',
      );
      await expect(client('slow').call('memory_handoff_list', {})).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('transcript locators', () => {
  it('resolves exact files and enforces cwd for Claude, Codex and Pi', () => {
    const root = temp();
    const cwd = path.join(root, 'workspace');
    const claudeRoot = path.join(root, 'claude');
    const claudeFile = path.join(claudeRoot, encodeProjectDirName(cwd), 'old.jsonl');
    const piRoot = path.join(root, 'pi');
    const piFile = path.join(
      piRoot,
      'sessions',
      `--${encodeProjectDirName(cwd).replace(/^-+/, '')}--`,
      '2026-09-27_old.jsonl',
    );
    for (const file of [claudeFile, piFile]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'old', cwd }) + '\n');
    }
    const codexFile = createRollout(root, 'rollout-old.jsonl', metaLine('old', cwd));
    const readers = [
      [new ClaudeSessionReader({ projectsDir: claudeRoot }), claudeFile],
      [new PiSessionReader({ piDir: piRoot }), piFile],
      [new CodexSessionReader({ codexHome: root }), codexFile],
    ] as const;
    for (const [reader, file] of readers) {
      expect(reader.getSessionFilePath('old', cwd)).toBe(file);
      expect(reader.getSessionFilePath('old', '/other')).toBeUndefined();
      expect(reader.getSessionFilePath('not-found', cwd)).toBeUndefined();
      expect(reader.getSessionFilePath('../old', cwd)).toBeUndefined();
    }
  });
});

describe.each(['claude', 'codex', 'pi'] as const)('%s bridge recovery', (agent: AgentKind) => {
  it.each(['API Error: 400 invalid request', 'connection closed', 'missing-result', 'throw'])(
    'preserves session on non-overflow failure: %s',
    async (failure) => {
      vi.spyOn(RecoveryMemoryClient.prototype, 'call').mockRejectedValue(new Error('offline'));
      const dir = temp();
      const sessionStore = new SessionStore();
      sessionStore.setSessionId('u', agent, 'old', dir);
      const runner = createStubRunner();
      const calls: SpawnOptions[] = [];
      runner.run = async function* (_message, opts) {
        calls.push(opts);
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'old',
          cwd: dir,
          model: 'test',
        } as AgentEvent;
        if (calls.length === 1 && failure === 'throw') throw new Error('connection closed');
        if (calls.length === 1 && failure === 'missing-result') return;
        yield {
          type: 'result',
          subtype: calls.length === 1 ? 'error' : 'success',
          errorMessage: failure,
          session_id: 'old',
        } as AgentEvent;
      };
      const bridge = new Bridge({
        connector: createStubConnector(),
        sessionStore,
        agentRegistry: createStubAgentRegistry(runner),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        recoveryDir: path.join(dir, 'recovery'),
        config: AppConfigSchema.parse({
          feishu: { appId: 'x', appSecret: 'x' },
          defaultAgent: agent,
        }),
      });
      const ctx = { userId: 'u', chatId: 'c', messageId: 'm' };
      await bridge.forwardToClaude('task', ctx);
      const recovery = new RecoveryHandoff(path.join(dir, 'recovery'));
      expect(recovery.read({ userId: 'u', cwd: dir, agent }).pending).toBeDefined();
      await bridge.forwardToClaude('continue', ctx);
      expect(calls[1].sessionId).toBe('old');
    },
  );
  it('starts fresh only on overflow, injects history, then stops reinjecting after success', async () => {
    vi.spyOn(RecoveryMemoryClient.prototype, 'call').mockRejectedValue(new Error('offline'));
    const dir = temp();
    const store = new SessionStore();
    store.setSessionId('u', agent, 'old', dir);
    const calls: Array<{ message: string; opts: SpawnOptions }> = [];
    const runner = createStubRunner();
    runner.run = async function* (message, opts) {
      calls.push({ message, opts });
      const sid = calls.length === 1 ? 'old' : 'new';
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sid,
        cwd: dir,
        model: 'test',
      } as AgentEvent;
      yield {
        type: 'result',
        subtype: calls.length === 1 ? 'error' : 'success',
        session_id: sid,
        errorMessage: calls.length === 1 ? 'context_length_exceeded' : undefined,
      } as AgentEvent;
    };
    const deps = {
      connector: createStubConnector(),
      sessionStore: store,
      config: AppConfigSchema.parse({
        feishu: { appId: 'x', appSecret: 'x' },
        defaultAgent: agent,
      }),
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      recoveryDir: path.join(dir, 'recovery'),
    };
    let bridge = new Bridge(deps);
    const ctx = { userId: 'u', chatId: 'chat', messageId: 'msg' };
    await bridge.forwardToClaude('task', ctx);
    bridge = new Bridge(deps);
    await bridge.forwardToClaude('continue', ctx);
    expect(calls[1].opts.sessionId).toBeUndefined();
    expect(calls[1].message).toContain('<remote_recovery>');
    await bridge.forwardToClaude('next', ctx);
    expect(calls[2].opts.sessionId).toBe('new');
    expect(calls[2].message).not.toContain('<remote_recovery>');
    await bridge.forwardToClaude('queued before overflow', ctx, {
      binding: { agent, sessionId: 'old' },
    });
    expect(calls[3].opts.sessionId).toBe('new');
    expect(calls[3].message).not.toContain('<remote_recovery>');
  });

  it('does not override explicit new-session choice after failure', async () => {
    const dir = temp();
    const recovery = new RecoveryHandoff(dir);
    const s = { ...scope, agent };
    recovery.record(s, {
      state: state('error', 'context_length_exceeded'),
      sessionId: 'old',
      sourceCwd: s.cwd,
      request: 'task',
    });
    expect(recovery.prepare(s, undefined)).toBeUndefined();
    expect(recovery.prepare(s, 'another-session')).toBeUndefined();
  });
});
