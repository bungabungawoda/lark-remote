import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from '../../src/runner/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runner-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Create a mock claude script that outputs JSONL and captures args to a file.
function createMockClaudeCaptureArgs(): string {
  const scriptPath = path.join(tmpDir, 'mock-claude');
  // Write args to a file, then output valid JSONL
  fs.writeFileSync(
    scriptPath,
    `#!/bin/bash
echo "$@" > ${tmpDir}/args.txt
echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
echo '{"type":"result","subtype":"success","session_id":"s1"}'
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('Bug 1: --model 参数不应传递给 claude', () => {
  it('调用 claude 时不应传递 --model 参数', async () => {
    const mockClaude = createMockClaudeCaptureArgs();
    const runner = new ClaudeRunner({ workspace: 'test', binary: mockClaude, pidDir: tmpDir });

    // Run claude without specifying a model
    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume events
    }

    // Read the captured arguments
    const argsFile = path.join(tmpDir, 'args.txt');
    const args = fs.readFileSync(argsFile, 'utf-8');

    // BUG: Currently --model is always passed (lines 232-233 in runner/index.ts)
    // After fix: --model should NOT appear in args when opts.model is undefined
    expect(args).not.toContain('--model');
  });

  it('当显式传递 model 时应该传递 --model 参数', async () => {
    const mockClaude = createMockClaudeCaptureArgs();
    const runner = new ClaudeRunner({ workspace: 'test', binary: mockClaude, pidDir: tmpDir });

    // Run claude WITH an explicit model
    for await (const _ of runner.run('hello', { cwd: '/tmp', model: 'claude-sonnet-4-20250514' })) {
      // consume events
    }

    const argsFile = path.join(tmpDir, 'args.txt');
    const args = fs.readFileSync(argsFile, 'utf-8');

    // When model is explicitly provided, --model should be passed
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
  });
});
