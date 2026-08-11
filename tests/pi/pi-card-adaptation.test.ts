import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppConfigSchema } from '../../src/config/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { agentDisplayName } from '../../src/card/card-shared.js';
import { toolHeaderText, toolBodyMd } from '../../src/card/tool-render.js';
import type { ToolEntry } from '../../src/card/run-state.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-pi-card-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createStubConnector() {
  const sent: { chatId: string; input: unknown }[] = [];
  return {
    _sent: sent,
    sendWithRetry: async (chatId: string, input: unknown) => {
      sent.push({ chatId, input });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => 'stream-msg-id',
    updateCard: async () => {},
  };
}

function createStubRunner() {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      throw new Error('run not expected in stub');
    },
  };
}

describe('Pi card adaptation', () => {
  describe('agentDisplayName', () => {
    it('returns "Pi" for kind="pi"', () => {
      expect(agentDisplayName('pi')).toBe('Pi');
    });

    it('still returns correct names for other agents', () => {
      expect(agentDisplayName('claude')).toBe('Claude');
      expect(agentDisplayName('codex')).toBe('Codex');
      expect(agentDisplayName('opencode')).toBe('Opencode');
    });
  });

  describe('toolHeaderText for lowercase (pi) tool names', () => {
    it('does not crash for read tool with path field', () => {
      const tool: ToolEntry = {
        id: 't1',
        name: 'read',
        status: 'ok',
        input: { path: '/tmp/foo.ts' },
        output: '',
      };
      const header = toolHeaderText(tool);
      expect(header).toContain('read');
      expect(header).toContain('/tmp/foo.ts');
    });

    it('does not crash for bash tool with command field', () => {
      const tool: ToolEntry = {
        id: 't2',
        name: 'bash',
        status: 'ok',
        input: { command: 'ls -la' },
        output: '',
      };
      const header = toolHeaderText(tool);
      expect(header).toContain('bash');
      expect(header).toContain('ls -la');
    });

    it('does not crash for edit tool with path field', () => {
      const tool: ToolEntry = {
        id: 't3',
        name: 'edit',
        status: 'running',
        input: { path: '/tmp/bar.ts' },
        output: '',
      };
      const header = toolHeaderText(tool);
      expect(header).toContain('edit');
      expect(header).toContain('/tmp/bar.ts');
    });

    it('does not crash for grep tool', () => {
      const tool: ToolEntry = {
        id: 't4',
        name: 'grep',
        status: 'ok',
        input: { pattern: 'TODO', path: '/tmp' },
        output: '',
      };
      const header = toolHeaderText(tool);
      expect(header).toContain('grep');
      expect(header).toContain('TODO');
    });

    it('does not crash for find tool', () => {
      const tool: ToolEntry = {
        id: 't5',
        name: 'find',
        status: 'ok',
        input: { pattern: '*.ts' },
        output: '',
      };
      const header = toolHeaderText(tool);
      expect(header).toContain('find');
    });

    it('does not crash for ls tool', () => {
      const tool: ToolEntry = {
        id: 't6',
        name: 'ls',
        status: 'ok',
        input: { path: '/tmp' },
        output: '',
      };
      const header = toolHeaderText(tool);
      expect(header).toContain('ls');
      expect(header).toContain('/tmp');
    });
  });

  describe('toolBodyMd for lowercase (pi) tool names', () => {
    it('renders bash command in code block', () => {
      const tool: ToolEntry = {
        id: 't7',
        name: 'bash',
        status: 'ok',
        input: { command: 'echo hello' },
        output: 'hello\n',
      };
      const body = toolBodyMd(tool);
      expect(body).toContain('**Command**');
      expect(body).toContain('echo hello');
      expect(body).toContain('**Output**');
      expect(body).toContain('hello');
    });

    it('renders read tool with File path', () => {
      const tool: ToolEntry = {
        id: 't8',
        name: 'read',
        status: 'ok',
        input: { path: '/tmp/foo.ts' },
        output: 'file content',
      };
      const body = toolBodyMd(tool);
      expect(body).toContain('**File**');
      expect(body).toContain('/tmp/foo.ts');
    });
  });

  describe('/config card with defaultAgent=pi', () => {
    it('includes pi.thinking select and pi.provider/pi.model fields, no 200861 violation', async () => {
      const sessionStore = new SessionStore();
      const connector = createStubConnector();
      const runner = createStubRunner();
      const config = AppConfigSchema.parse({
        feishu: { appId: 'test', appSecret: 'test' },
        claude: {
          model: 'claude-opus-4-8',
          stopGraceMs: 5000,
        },
        agents: { pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' } },
        defaultAgent: 'pi',
        output: {
          showThinking: true,
          showToolUse: true,
          showToolResult: true,
        },
      });
      const router = new CommandRouter({
        sessionStore,
        bridge: new Bridge({
          runner,
          agentRegistry: createStubAgentRegistry(runner),
          sessionReaderRegistry: createStubSessionReaderRegistry(),
          connector,
          sessionStore,
          config,
        }),
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        sessionReaderRegistry: new SessionReaderRegistry(),
      });

      const ctx = { userId: 'test-user', chatId: 'test-chat', messageId: 'msg-1' };
      await router.handle('/config', ctx);

      const sent = (connector as unknown as { _sent: Array<{ input: unknown }> })._sent;
      expect(sent.length).toBeGreaterThan(0);
      const card = (sent[0].input as { card: object }).card;
      const cardStr = JSON.stringify(card);

      // 200861 铁律：无 "tag":"action"+"actions"
      expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

      // CardKit 2.0 schema
      expect(cardStr).toContain('"schema":"2.0"');

      // pi.thinking select field present
      expect(cardStr).toContain('pi.thinking');
      expect(cardStr).toContain('思考级别');

      // pi.provider and pi.model fields present
      expect(cardStr).toContain('pi.provider');
      expect(cardStr).toContain('Pi Provider');
      expect(cardStr).toContain('pi.model');
      expect(cardStr).toContain('使用模型');

      // tab label should be 🤖 Pi
      expect(cardStr).toContain('🤖 Pi');

      // behaviors callback structure
      expect(cardStr).toContain('"behaviors"');
      expect(cardStr).toContain('"type":"callback"');
    });
  });
});
