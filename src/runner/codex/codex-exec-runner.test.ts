import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexExecRunner } from './index.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// Mock loadCodexConfig to control its behavior in getStatusInfo / validateBeforeRun
const { mockLoadCodexConfig } = vi.hoisted(() => ({
  mockLoadCodexConfig: vi.fn(),
}));

vi.mock('../../config/codex-config.js', () => ({
  loadCodexConfig: mockLoadCodexConfig,
}));

// Minimal mock session reader
const mockSessionReader = {
  listSessions: vi.fn().mockReturnValue({ sessions: [], total: 0 }),
  getNewestSession: vi.fn().mockReturnValue(null),
  readSessionContent: vi.fn().mockReturnValue({ events: [] }),
  isSessionActive: vi.fn().mockReturnValue(false),
};

let tmpDir: string;
let savedPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-exec-runner-test-'));
  savedPath = prependPath(tmpDir);
});

afterEach(() => {
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a mock codex script that simulates `codex exec --json` behavior.
 * It reads from stdin (prompt) and writes ndjson to stdout.
 */
function createMockCodex(script: string): string {
  return writeMockBin(
    tmpDir,
    'codex',
    `#!/bin/bash\n# Read stdin (prompt), then execute script\nread -r _PROMPT\n${script}`,
  );
}

describe('CodexExecRunner', () => {
  // ① Normal turn: spawn → stdin gets prompt → stdout outputs ndjson → yield AgentEvent → terminal
  it('yields AgentEvents from codex exec ndjson output', async () => {
    createMockCodex(`
      echo '{"type":"thread.started","thread_id":"019f-test","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"item.completed","item":{"type":"agent_message","text":"Hello!"}}'
      echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}'
    `);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: '019f-test' });
    expect(events[1]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello!' }] },
    });
    expect(events[2]).toMatchObject({ type: 'result', subtype: 'success' });
    expect(runner.isRunning).toBe(false);
  });

  // ② Binary not found → yield resultError
  it('yields error event when binary is not found', async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(tmpDir, 'no-bin');
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }
    restorePath(saved);

    // §9.22: spawning-runner yields syntheticInitEvent + authErrorEvent (2 events)
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(events[1]).toMatchObject({
      type: 'result',
      subtype: 'error',
      errorMessage: expect.stringContaining('命令不可用'),
    });
  });

  // ④ Stream ends before turn.completed → yield "stream ended" error
  it('yields error when stream ends before terminal event', async () => {
    createMockCodex(`
      echo '{"type":"thread.started","thread_id":"019f-early-end","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}'
      # Exit without turn.completed
    `);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    const resultEvent = events.find((e: any) => e.type === 'result');
    expect(resultEvent).toMatchObject({
      subtype: 'error',
      errorMessage: expect.stringContaining('stream ended before a terminal event'),
    });
  });

  // ⑥ killOrphan scans pid file
  it('killOrphan reads pid file and kills process if running', async () => {
    createMockCodex(`
      echo '{"type":"turn.completed","usage":{}}'
    `);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    // Create a fake pid file pointing to a non-existent process
    const pidDir = path.dirname(runner['pidFilePath']);
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(runner['pidFilePath'], '999999999');

    // killOrphan should just clean up the file (process doesn't exist)
    runner.killOrphan();
    expect(fs.existsSync(runner['pidFilePath'])).toBe(false);
  });

  // ⑦ Kind is 'codex'
  it('has kind codex', () => {
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });
    expect(runner.kind).toBe('codex');
  });

  // ⑦b Constructor defaults: binary defaults to 'codex' when not specified
  it('defaults binary to codex when not specified', () => {
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });
    expect(runner['binary']).toBe('codex');
  });

  // ⑨ Session ID is passed as threadId for resume
  it('passes sessionId as threadId for resume', async () => {
    const argsFile = path.join(tmpDir, 'codex-args.txt');
    const mockCodex = `#!/bin/bash
echo "$@" > ${argsFile}
read -r _PROMPT
echo '{"type":"thread.started","thread_id":"019f-resume","cwd":"/tmp","model":"glm-5.2"}'
echo '{"type":"turn.completed","usage":{}}'
`;
    writeMockBin(tmpDir, 'codex', mockCodex);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    for await (const _ of runner.run('continue', { cwd: '/tmp', sessionId: '019f-resume' })) {
      // consume
    }

    const capturedArgs = fs.readFileSync(argsFile, 'utf-8').trim();
    expect(capturedArgs).toContain('resume');
    expect(capturedArgs).toContain('019f-resume');
  });

  // ⑩ Command execution events (tool_use + tool_result flow)
  it('handles full command_execution flow', async () => {
    createMockCodex(`
      echo '{"type":"thread.started","thread_id":"019f-cmd","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"item.started","item":{"type":"command_execution","id":"cmd_1","command":"ls"}}'
      echo '{"type":"item.completed","item":{"type":"command_execution","id":"cmd_1","exit_code":0,"output":"file.txt"}}'
      echo '{"type":"item.completed","item":{"type":"agent_message","text":"Done!"}}'
      echo '{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":50}}'
    `);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    const events = [];
    for await (const event of runner.run('list files', { cwd: '/tmp' })) {
      events.push(event);
    }

    // system + tool_use + tool_result + text + result
    expect(events).toHaveLength(5);
    expect(events[1]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'command_execution' }] },
    });
    expect(events[2]).toMatchObject({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: false }] },
    });
  });

  // --- getStatusInfo() tests ---

  it('getStatusInfo returns configured model and provider', () => {
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      model: 'gpt-4.1',
      modelProvider: 'openai',
      sessionReader: mockSessionReader,
    });
    const info = runner.getStatusInfo();
    expect(info.kind).toBe('codex');
    expect(info.model).toBe('gpt-4.1');
    expect(info.provider).toBe('openai');
    expect(info.extras).toEqual({ sandbox: 'danger-full-access' });
  });

  it('getStatusInfo falls back to loadCodexConfig when model is not set', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'o3',
      currentProvider: 'openai',
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });
    const info = runner.getStatusInfo();
    expect(info.model).toBe('o3');
    expect(info.provider).toBe('openai');
  });

  it('getStatusInfo falls back to loadCodexConfig when provider is not set but model is', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'gpt-4.1',
      currentProvider: 'anthropic',
      providerEnvKeys: { anthropic: 'ANTHROPIC_API_KEY' },
    });

    // Only model set, no provider — should read provider from loadCodexConfig
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      model: 'gpt-4.1',
      sessionReader: mockSessionReader,
    });
    const info = runner.getStatusInfo();
    // model stays from constructor, provider comes from loadCodexConfig
    expect(info.model).toBe('gpt-4.1');
    expect(info.provider).toBe('anthropic');
  });

  it('getStatusInfo fills model from loadCodexConfig when only provider is set', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'o4-mini',
      currentProvider: 'openai',
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
    });

    // Only provider set, no model — should read model from loadCodexConfig
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'openai',
      sessionReader: mockSessionReader,
    });
    const info = runner.getStatusInfo();
    expect(info.model).toBe('o4-mini');
    expect(info.provider).toBe('openai');
  });

  it('getStatusInfo returns (未配置) when loadCodexConfig throws and no model set', () => {
    mockLoadCodexConfig.mockImplementation(() => {
      throw new Error('config read failed');
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });
    const info = runner.getStatusInfo();
    expect(info.model).toBe('(未配置)');
    expect(info.provider).toBeUndefined();
  });

  // --- validateBeforeRun() tests ---

  it('validateBeforeRun returns null when no modelProvider is set', () => {
    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });
    const result = (runner as any).validateBeforeRun({ cwd: '/tmp' });
    expect(result).toBeNull();
  });

  it('validateBeforeRun yields error when provider env key is not set', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'o3',
      currentProvider: 'openai',
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'openai',
      sessionReader: mockSessionReader,
    });

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = (runner as any).validateBeforeRun({
        cwd: '/tmp',
        sessionId: 'test-session',
      }) as any;
      expect(result).not.toBeNull();
      expect(result.type).toBe('result');
      expect(result.subtype).toBe('error');
      expect(result.errorMessage).toContain('OPENAI_API_KEY');
      expect(result.session_id).toBe('test-session');
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it('validateBeforeRun returns null when provider env key IS set', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'o3',
      currentProvider: 'openai',
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'openai',
      sessionReader: mockSessionReader,
    });

    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-key-for-coverage';

    try {
      const result = (runner as any).validateBeforeRun({ cwd: '/tmp' });
      expect(result).toBeNull();
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it('validateBeforeRun returns null when provider has no env key mapping', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'o3',
      currentProvider: 'custom',
      providerEnvKeys: {}, // no env key for 'custom_provider_xyz'
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'custom_provider_xyz',
      sessionReader: mockSessionReader,
    });

    const result = (runner as any).validateBeforeRun({ cwd: '/tmp' });
    expect(result).toBeNull();
  });

  it('validateBeforeRun yields error without session_id when sessionId is undefined', () => {
    mockLoadCodexConfig.mockReturnValue({
      currentModel: 'o3',
      currentProvider: 'openai',
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'openai',
      sessionReader: mockSessionReader,
    });

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      // No sessionId provided — opts.sessionId is undefined, ?? '' should fire
      const result = (runner as any).validateBeforeRun({ cwd: '/tmp' }) as any;
      expect(result).not.toBeNull();
      expect(result.session_id).toBe('');
      expect(result.errorMessage).toContain('OPENAI_API_KEY');
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it('validateBeforeRun returns null when loadCodexConfig throws', () => {
    mockLoadCodexConfig.mockImplementation(() => {
      throw new Error('config read failed');
    });

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'openai',
      sessionReader: mockSessionReader,
    });

    const result = (runner as any).validateBeforeRun({ cwd: '/tmp' });
    // The catch block swallows the error, returns null (let codex handle it)
    expect(result).toBeNull();
  });

  // --- buildArgv integration through run ---

  it('passes modelProvider and reasoningEffort to buildArgv', async () => {
    const argsFile = path.join(tmpDir, 'codex-args-opts.txt');
    const mockCodex = `#!/bin/bash
echo "$@" > ${argsFile}
read -r _PROMPT
echo '{"type":"thread.started","thread_id":"019f-opts","cwd":"/tmp","model":"glm-5.2"}'
echo '{"type":"turn.completed","usage":{}}'
`;
    writeMockBin(tmpDir, 'codex', mockCodex);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      modelProvider: 'anthropic',
      reasoningEffort: 'high',
      sessionReader: mockSessionReader,
    });

    for await (const _ of runner.run('test', { cwd: '/tmp' })) {
      // consume
    }

    const capturedArgs = fs.readFileSync(argsFile, 'utf-8').trim();
    expect(capturedArgs).toContain('model_provider="anthropic"');
    expect(capturedArgs).toContain('model_reasoning_effort="high"');
  });

  it('opts.reasoningEffort overrides constructor default in buildArgv', async () => {
    const argsFile = path.join(tmpDir, 'codex-args-effort.txt');
    const mockCodex = `#!/bin/bash
echo "$@" > ${argsFile}
read -r _PROMPT
echo '{"type":"thread.started","thread_id":"019f-effort","cwd":"/tmp","model":"glm-5.2"}'
echo '{"type":"turn.completed","usage":{}}'
`;
    writeMockBin(tmpDir, 'codex', mockCodex);

    const runner = new CodexExecRunner({
      workspace: 'test',
      pidDir: tmpDir,
      reasoningEffort: 'low',
      sessionReader: mockSessionReader,
    });

    for await (const _ of runner.run('test', { cwd: '/tmp', reasoningEffort: 'ultra' })) {
      // consume
    }

    const capturedArgs = fs.readFileSync(argsFile, 'utf-8').trim();
    expect(capturedArgs).toContain('model_reasoning_effort="ultra"');
    expect(capturedArgs).not.toContain('model_reasoning_effort="low"');
  });
});
