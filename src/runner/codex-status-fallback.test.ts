import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexExecRunner } from './codex/index.js';

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

// Minimal mock session reader
const mockSessionReader = {
  listSessions: vi.fn().mockReturnValue({ sessions: [], total: 0 }),
  getNewestSession: vi.fn().mockReturnValue(null),
  readSessionContent: vi.fn().mockReturnValue({ events: [] }),
  isSessionActive: vi.fn().mockReturnValue(false),
};

describe('CodexExecRunner getStatusInfo with config fallback', () => {
  let tmpDir: string;
  let codexConfigPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-test-'));
    // Create a mock codex config file
    const codexHome = path.join(tmpDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    codexConfigPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(
      codexConfigPath,
      `model = "glm-5.2"
model_provider = "volcengine-coding-plan"
`,
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should use model from config file when model option is not provided', () => {
    // CODEX_HOME points to the codex home dir itself (equivalent to default ~/.codex),
    // i.e. the directory that directly contains config.toml.
    const originalEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.dirname(codexConfigPath);

    try {
      const runner = new CodexExecRunner({
        workspace: 'test',
        binary: 'codex',
        pidDir: tmpDir,
        sessionReader: mockSessionReader,
        // No model provided - should fallback to config.toml
      });

      const info = runner.getStatusInfo();

      // Should fallback to config.toml values
      expect(info.model).toBe('glm-5.2');
      expect(info.provider).toBe('volcengine-coding-plan');
    } finally {
      if (originalEnv !== undefined) {
        process.env.CODEX_HOME = originalEnv;
      } else {
        delete process.env.CODEX_HOME;
      }
    }
  });

  it('should use explicitly provided model over config file', () => {
    const runner = new CodexExecRunner({
      workspace: 'test',
      binary: 'codex',
      model: 'custom-model',
      modelProvider: 'custom-provider',
      pidDir: tmpDir,
      sessionReader: mockSessionReader,
    });

    const info = runner.getStatusInfo();

    // Explicit config takes priority
    expect(info.model).toBe('custom-model');
    expect(info.provider).toBe('custom-provider');
  });
});
