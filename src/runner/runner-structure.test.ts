/**
 * Runner module structure invariants.
 *
 * Guards the post-refactor layout of src/runner/:
 * - types.ts holds all shared type definitions (no runtime deps on session/)
 * - common/ holds the shared utilities, imported directly (no barrel file)
 * - each agent runner lives in its own directory (runner.ts + index.ts)
 * - index.ts is a thin re-export entry (types + agent runners + registry +
 *   resolveAgentChoices/syncAgentChoices), with no local implementations and
 *   no re-exports of common/ utilities
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const runnerDir = path.resolve(__dirname, '../../src/runner');

function read(rel: string): string {
  return fs.readFileSync(path.join(runnerDir, rel), 'utf-8');
}

function lineCount(rel: string): number {
  return read(rel).split('\n').length;
}

describe('runner structure: types.ts', () => {
  it('exists and exports all shared types', () => {
    const content = read('types.ts');
    expect(content).toContain('export type AgentKind');
    expect(content).toContain('export type AgentEvent');
    expect(content).toContain('export interface Runner');
    expect(content).toContain('export interface AgentRunner');
    expect(content).toContain('export interface SpawnOptions');
    expect(content).toContain('export interface AgentSessionReader');
    expect(content).toContain('export interface AgentStatusInfo');
    expect(content).toContain('export interface SessionContent');
  });

  it('has no runtime or type dependency on session/ (no circular import)', () => {
    const content = read('types.ts');
    expect(content).not.toContain("from '../session/");
    // AgentSessionReader is defined locally in types.ts
    expect(content).not.toContain('import type { AgentSessionReader }');
  });
});

describe('runner structure: common/ shared utilities', () => {
  const commonDir = path.join(runnerDir, 'common');

  it('common/ directory exists', () => {
    expect(fs.existsSync(commonDir)).toBe(true);
    expect(fs.statSync(commonDir).isDirectory()).toBe(true);
  });

  it('contains the shared utility files with their expected exports', () => {
    expect(read('common/process-stopper.ts')).toContain('export class ProcessStopper');
    expect(read('common/spawn-heartbeat.ts')).toContain('export class SpawnHeartbeat');
    expect(read('common/jsonl-stream.ts')).toContain('export function createJSONLStream');
    expect(read('common/runner-utils.ts')).toContain('export function authErrorEvent');
  });

  it('base class owns registerExitHandlers (P1-1 singleton dispatch)', () => {
    expect(read('common/spawning-runner.ts')).toContain('registerExitHandlers()');
    expect(read('common/spawning-runner.ts')).toContain('unregisterExitHandlers()');
    expect(read('common/spawning-runner.ts')).toContain('cleanupOnExit()');
  });

  it('has no barrel file (consumers import the utility modules directly)', () => {
    expect(fs.existsSync(path.join(commonDir, 'index.ts'))).toBe(false);
  });
});

describe('runner structure: index.ts thin entry', () => {
  it('re-exports types from types.ts', () => {
    const content = read('index.ts');
    expect(content).toContain('export type {');
    expect(content).toContain('AgentEvent');
    expect(content).toContain('Runner');
    expect(content).toContain("from './types.js'");
  });

  it('re-exports every agent runner from its own directory', () => {
    const content = read('index.ts');
    expect(content).toContain("export { ClaudeRunner } from './claude/index.js'");
    expect(content).toContain("export { CodexExecRunner } from './codex/index.js'");
    expect(content).toContain("export { OpencodeExecRunner } from './opencode/index.js'");
    expect(content).toContain("export { PiRunner } from './pi/index.js'");
    expect(content).toContain("export { KimiRunner } from './kimi/index.js'");
    expect(content).toContain("from './bash/index.js'");
  });

  it('does not re-export common/ utilities (imported directly from common/*)', () => {
    const content = read('index.ts');
    expect(content).not.toContain('createJSONLStream');
    expect(content).not.toContain('ProcessStopper');
    expect(content).not.toContain('SpawnHeartbeat');
    expect(content).not.toContain('authErrorEvent');
    expect(content).not.toContain("from './common/");
  });

  it('exports resolveAgentChoices / syncAgentChoices', () => {
    const content = read('index.ts');
    expect(content).toContain('resolveAgentChoices');
    expect(content).toContain('syncAgentChoices');
  });

  it('contains no local runner class definitions', () => {
    const content = read('index.ts');
    expect(content).not.toContain('class ClaudeRunner');
    expect(content).not.toContain('class CodexExecRunner');
    expect(content).not.toContain('class OpencodeExecRunner');
  });

  it('stays a thin entry (≤ 100 lines)', () => {
    expect(lineCount('index.ts')).toBeLessThanOrEqual(100);
  });
});

describe('runner structure: per-agent directories', () => {
  const agents = ['claude', 'codex', 'opencode', 'pi', 'kimi', 'bash'] as const;

  for (const agent of agents) {
    it(`${agent}/ has index.ts and runner.ts`, () => {
      const dir = path.join(runnerDir, agent);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(dir, 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'runner.ts'))).toBe(true);
    });

    it(`${agent}/runner.ts stays under 600 lines`, () => {
      expect(lineCount(`${agent}/runner.ts`)).toBeLessThanOrEqual(600);
    });
  }

  it('codex/ and opencode/ also contain jsonl.ts and argv.ts', () => {
    for (const agent of ['codex', 'opencode'] as const) {
      expect(fs.existsSync(path.join(runnerDir, agent, 'jsonl.ts'))).toBe(true);
      expect(fs.existsSync(path.join(runnerDir, agent, 'argv.ts'))).toBe(true);
    }
  });

  it('claude/runner.ts holds the ClaudeRunner implementation', () => {
    const content = read('claude/runner.ts');
    expect(content).toContain('export class ClaudeRunner');
    expect(content).toContain('implements IAgentRunner');
    expect(content).toContain("readonly kind = 'claude'");
    // run()/stop() are inherited from the SpawningRunner deep-module base class
    expect(content).toContain('extends SpawningRunner');
    // P1-1 (2026-08-02): registerExitHandlers moved to the SpawningRunner base as a
    // module-level singleton dispatch — subclass must NOT re-implement it (the old
    // per-instance copy registered 3 process listeners per run, never removed, leaking
    // both listeners and runner instances; see §P1-1). This negative assertion
    // guards against copy-paste regression of the isomorphic duplicate.
    expect(content).not.toContain('registerExitHandlers()');
  });

  it('claude/index.ts re-exports ClaudeRunner', () => {
    expect(read('claude/index.ts')).toContain('export { ClaudeRunner }');
  });

  it('old flat runner files are gone (no re-export shims left behind)', () => {
    const oldFiles = [
      'codex-exec-runner.ts',
      'codex-exec-jsonl.ts',
      'codex-exec-argv.ts',
      'opencode-exec-runner.ts',
      'opencode-exec-jsonl.ts',
      'opencode-exec-argv.ts',
      'pi-runner.ts',
      'kimi-runner.ts',
      'bash-runner.ts',
      'claude-runner.test.ts',
    ];
    for (const file of oldFiles) {
      expect(fs.existsSync(path.join(runnerDir, file))).toBe(false);
    }
  });

  it('runner tests live in their agent directories', () => {
    expect(fs.existsSync(path.join(runnerDir, 'claude/claude-runner.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(runnerDir, 'codex/codex-exec-runner.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(runnerDir, 'opencode/opencode-exec-runner.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(runnerDir, 'pi/pi-runner.test.ts'))).toBe(true);
  });
});
