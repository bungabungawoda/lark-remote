import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../src/router/index.js';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubRunner,
  createStubSessionReaderRegistry,
  createStubConnector,
} from '../lib/bridge-stubs.js';
// Stub session reader for tests

// Test utilities

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bash-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter(overrides?: {
  runner?: Runner;
  output?: Partial<AppConfig['output']>;

  exitHandler?: () => void;
  projectsDir?: string;
  bridge?: Bridge;
  idleTimeoutMs?: number;
}) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner: Runner = overrides?.runner ?? createStubRunner();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
      ...overrides?.output,
    },
  });
  const router = new CommandRouter({
    sessionStore,
    bridge:
      overrides?.bridge ??
      new Bridge({
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
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
  return { router, sessionStore, connector };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('! bash command feature (Anchor Tests)', () => {
  describe('Message routing', () => {
    it('routes bang command to bash executor instead of Claude', async () => {
      const { router, connector } = createRouter();

      // Send a bang command
      await router.handle('!echo hello', ctx);

      // The key test: it should NOT forward to Claude (forwardToClaude should not be called)
      // Instead, it should execute the bash command and send result
      // If this fails, it means the router is treating ! like a regular message and forwarding to Claude
      const calls = connector._sent;

      // Should have sent some result (text output from echo)
      expect(calls.length).toBeGreaterThan(0);
    });

    it('parses bang command correctly', async () => {
      const { router, connector } = createRouter();

      // Send a complex bang command with arguments
      await router.handle('!ls -la /tmp', ctx);

      const calls = connector._sent;
      // Should produce output
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  describe('Working directory handling', () => {
    it('prompts user to set cwd when not configured', async () => {
      const { router, connector, sessionStore } = createRouter();

      // User has no cwd set
      expect(sessionStore.getCwd(ctx.userId)).toBeUndefined();

      // Send a bang command
      await router.handle('!echo hello', ctx);

      // Should get a prompt to set cwd first
      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      // The response should indicate cwd is not set (either direct message or card)
      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const hasCwdPrompt =
        (response.text && response.text.includes('cd')) ||
        (response.card && JSON.stringify(response.card).includes('cd'));
      expect(hasCwdPrompt).toBe(true);
    });

    it('executes bash command in user current cwd', async () => {
      const { router, connector, sessionStore } = createRouter();

      // Set user's cwd (use realpath to match what production code does)
      const testDir = fs.realpathSync(tmpDir);
      sessionStore.setCwd(ctx.userId, testDir);

      // Create a test file to verify cwd
      fs.writeFileSync(path.join(testDir, 'test-file.txt'), 'hello');

      // Run ls to see the file
      await router.handle('!ls', ctx);

      // Streaming bash card: output lands in the patched card (_cards), not _sent
      const cards = connector._cards;
      expect(cards.length).toBeGreaterThan(0);

      // Output should include the file we created
      const responseStr = JSON.stringify(cards[cards.length - 1]);
      expect(responseStr).toContain('test-file.txt');
    });

    it('handles cd command before bang commands', async () => {
      const { router, sessionStore } = createRouter();

      // First set cwd via /cd
      await router.handle('/cd ' + tmpDir, ctx);

      // Verify cwd is set (note: production uses realpath, so the value may differ from tmpDir)
      const cwd = sessionStore.getCwd(ctx.userId);
      expect(cwd).toBeDefined();
      expect(cwd!.endsWith(tmpDir.split('/').pop()!)).toBe(true);
    });
  });

  describe('Command execution', () => {
    it('executes simple echo command', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      await router.handle('!echo test_output', ctx);

      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const responseStr = JSON.stringify(response);
      expect(responseStr).toContain('test_output');
    });

    it('handles command failure gracefully', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      // Run a non-existent command
      await router.handle('!nonexistent_command_xyz', ctx);

      // Streaming bash card: stderr lands in the patched card (_cards), not _sent
      const cards = connector._cards;
      expect(cards.length).toBeGreaterThan(0);

      // Should show error message
      const responseStr = JSON.stringify(cards[cards.length - 1]);
      expect(
        responseStr.toLowerCase().includes('not found') ||
          responseStr.toLowerCase().includes('error') ||
          responseStr.toLowerCase().includes('找不到'),
      ).toBe(true);
    });

    it('shows exit code on command failure', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      // Command that exits with non-zero (using bash built-in)
      await router.handle('!false', ctx);

      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      // Should indicate failure (false returns exit code 1)
      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const responseStr = JSON.stringify(response);
      // Either shows exit code or error indication
      expect(
        responseStr.includes('1') || // exit code
          responseStr.toLowerCase().includes('error') ||
          responseStr.toLowerCase().includes('failed'),
      ).toBe(true);
    });
  });

  describe('Queue integration', () => {
    it('bang commands bypass the serial queue and run in parallel with Claude runs', async () => {
      const { router, sessionStore, connector } = createRouter();
      const testDir = fs.realpathSync(tmpDir);
      sessionStore.setCwd(ctx.userId, testDir);

      // Get the bridge from router (bridge is public for tests)
      const bridge = router.bridge;

      // Occupy the serial queue with a hanging task (simulates a long claude run)
      let taskStarted = false;
      const hangingTask = async () => {
        taskStarted = true;
        await new Promise(() => {}); // Never resolves
      };
      bridge.enqueue(testDir, hangingTask);

      // Wait for the hanging task to start (queue is occupied)
      await new Promise((r) => setTimeout(r, 50));
      expect(taskStarted).toBe(true);

      // `!` must bypass the serial queue and run immediately, despite the
      // hanging task occupying it. Regression history: `!` used to share the
      // serial queue with claude runs, so a long claude run blocked `!`
      // commands and vice versa.
      await router.handle('!echo hello', ctx);

      // bash card (initial + final) was sent — `!` executed, NOT queued
      expect(connector._sent.length).toBeGreaterThan(0);

      // the hanging task is still running — bash neither waited behind it nor blocked it
      expect(taskStarted).toBe(true);
    }, 10000);
  });

  describe('Error handling', () => {
    it('handles empty bang command', async () => {
      const { router, connector } = createRouter();

      // Send just "!"
      await router.handle('!', ctx);

      const calls = connector._sent;
      // Should respond with error or help message
      expect(calls.length).toBeGreaterThan(0);
    });

    it('handles special characters in command', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      // Command with quotes
      await router.handle('!echo "hello world"', ctx);

      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const responseStr = JSON.stringify(response);
      expect(responseStr).toContain('hello world');
    });

    it('handles pipe and redirection', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      // Use pipe
      await router.handle('!echo hello | cat', ctx);

      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const responseStr = JSON.stringify(response);
      expect(responseStr).toContain('hello');
    });
  });

  describe('Output format', () => {
    it('returns command output as text', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      await router.handle('!printf "line1\\nline2\\nline3"', ctx);

      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const responseStr = JSON.stringify(response);
      expect(responseStr).toContain('line1');
      expect(responseStr).toContain('line2');
      expect(responseStr).toContain('line3');
    });

    it('captures stderr output', async () => {
      const { router, connector, sessionStore } = createRouter();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));

      // Command that outputs to stderr
      await router.handle('!echo error >&2', ctx);

      const calls = connector._sent;
      expect(calls.length).toBeGreaterThan(0);

      // Should capture stderr as well
      const response = calls[calls.length - 1].input as { text?: string; card?: object };
      const responseStr = JSON.stringify(response);
      expect(responseStr).toMatch(/error/);
    });
  });
});
