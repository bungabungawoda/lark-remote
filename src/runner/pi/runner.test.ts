import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiRunner } from './runner.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let savedPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-pi-runner-unit-'));
  savedPath = prependPath(tmpDir);
});

afterEach(() => {
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PiRunner', () => {
  describe('constructor defaults', () => {
    it('test_anchor_default_binary_is_pi', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      // SpawningRunner.binary is protected; verify via buildArgv by running
      // a no-op mock pi script. The binary field is 'pi' by default.
      expect((runner as unknown as { binary: string }).binary).toBe('pi');
    });

    it('test_anchor_default_model_is_glm_5_2', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      expect(runner.getStatusInfo().model).toBe('glm-5.2');
    });

    it('test_anchor_default_provider_is_volcano', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      expect(runner.getStatusInfo().provider).toBe('Volcano');
    });

    it('test_anchor_default_thinking_is_medium', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      expect(runner.getStatusInfo().reasoning).toBe('medium');
    });

    it('test_anchor_default_session_reader_is_noop', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      const reader = runner.sessionReader;
      expect(reader.listSessions('/tmp')).toEqual({ sessions: [], total: 0 });
      expect(reader.getNewestSession('/tmp')).toBeNull();
      expect(reader.readSessionContent('any')).toEqual({ events: [] });
      expect(reader.isSessionActive('any', '/tmp')).toBe(false);
    });
  });

  describe('constructor with custom values', () => {
    it('test_anchor_custom_model', () => {
      const runner = new PiRunner({
        workspace: 'test',
        model: 'claude-sonnet-4-20250514',
        pidDir: tmpDir,
      });
      expect(runner.getStatusInfo().model).toBe('claude-sonnet-4-20250514');
    });

    it('test_anchor_custom_stop_grace_ms', () => {
      const runner = new PiRunner({ workspace: 'test', stopGraceMs: 1000, pidDir: tmpDir });
      expect((runner as unknown as { stopGraceMs: number }).stopGraceMs).toBe(1000);
    });

    it('test_anchor_custom_workspace_affects_pid_file', () => {
      const runner = new PiRunner({ workspace: 'reports', pidDir: tmpDir });
      const pidPath = (runner as unknown as { pidFilePath: string }).pidFilePath;
      expect(pidPath).toContain('pi-reports.pid');
    });

    it('test_anchor_custom_provider', () => {
      const runner = new PiRunner({ workspace: 'test', provider: 'anthropic', pidDir: tmpDir });
      expect(runner.getStatusInfo().provider).toBe('anthropic');
    });

    it('test_anchor_custom_thinking', () => {
      const runner = new PiRunner({ workspace: 'test', thinking: 'high', pidDir: tmpDir });
      expect(runner.getStatusInfo().reasoning).toBe('high');
    });
  });

  describe('pid getter', () => {
    it('test_anchor_pid_returns_undefined_when_no_process', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      expect(runner.pid).toBeUndefined();
    });

    it('test_anchor_pid_returns_process_pid_when_running', async () => {
      writeMockBin(
        tmpDir,
        'pi',
        '#!/bin/bash\necho \'{"type":"session","id":"s","cwd":"/tmp","model":"glm-5.2"}\'\necho \'{"type":"agent_end","messages":[]}\'\nexec sleep 5',
      );

      const runner = new PiRunner({
        workspace: 'test',
        pidDir: tmpDir,
        stopGraceMs: 500,
      });
      const runPromise = (async () => {
        for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
          // consume
        }
      })();

      // Wait for the process to start
      await new Promise((r) => setTimeout(r, 200));

      const pidBefore = runner.pid;
      expect(typeof pidBefore).toBe('number');
      expect(pidBefore).toBeGreaterThan(0);

      await runner.stop({ immediate: true });
      await runPromise;

      expect(runner.pid).toBeUndefined();
    });
  });

  describe('getStatusInfo', () => {
    it('test_anchor_returns_kind_pi_and_default_model', () => {
      const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
      const info = runner.getStatusInfo();
      expect(info.kind).toBe('pi');
      expect(info.model).toBe('glm-5.2');
    });

    it('test_anchor_returns_custom_provider_and_thinking', () => {
      const runner = new PiRunner({
        workspace: 'test',
        provider: 'openai',
        model: 'gpt-4o',
        thinking: 'low',
        pidDir: tmpDir,
      });
      const info = runner.getStatusInfo();
      expect(info.kind).toBe('pi');
      expect(info.model).toBe('gpt-4o');
      expect(info.provider).toBe('openai');
      expect(info.reasoning).toBe('low');
    });
  });
});
