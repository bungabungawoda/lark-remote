/**
 * Runner module architecture guards.
 *
 * Only keeps invariants that have no behavioral test equivalent:
 * - types.ts has no circular import on session/
 * - SpawningRunner owns registerExitHandlers singleton dispatch
 * - index.ts does not re-export common/ utilities
 * - claude/session.ts extends SpawningRunner; claude/runner.ts delegates without
 *   re-implementing registerExitHandlers (P1-1, 2026-08-16 长驻交互改造)
 *
 * Other structure checks (line counts, directory listings, export existence)
 * were removed: they are fragile against normal refactoring and provide no
 * regression coverage beyond what behavioral tests already enforce.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const runnerDir = path.resolve(__dirname, '../../src/runner');

function read(rel: string): string {
  return fs.readFileSync(path.join(runnerDir, rel), 'utf-8');
}

describe('runner structure: architecture guards', () => {
  it('types.ts has no runtime or type dependency on session/ (no circular import)', () => {
    const content = read('types.ts');
    expect(content).not.toContain("from '../session/");
    // AgentSessionReader is defined locally in types.ts
    expect(content).not.toContain('import type { AgentSessionReader }');
  });

  it('SpawningRunner owns registerExitHandlers singleton dispatch (P1-1)', () => {
    expect(read('common/spawning-runner.ts')).toContain('registerExitHandlers()');
    expect(read('common/spawning-runner.ts')).toContain('unregisterExitHandlers()');
    expect(read('common/spawning-runner.ts')).toContain('cleanupOnExit()');
  });

  it('index.ts does not re-export common/ utilities (imported directly from common/*)', () => {
    const content = read('index.ts');
    expect(content).not.toContain('createJSONLStream');
    expect(content).not.toContain('ProcessStopper');
    expect(content).not.toContain('SpawnHeartbeat');
    expect(content).not.toContain('authErrorEvent');
    expect(content).not.toContain("from './common/");
  });

  it('claude/session.ts extends SpawningRunner; runner.ts delegates lifecycle (P1-1)', () => {
    // 长驻交互改造：进程编排下沉到 ClaudeSession
    // （IS-A SpawningRunner），ClaudeRunner 薄包装委托。registerExitHandlers
    // 仍由 SpawningRunner 基类单例分发，两个文件都不得重复实现。
    const session = read('claude/session.ts');
    expect(session).toContain('extends SpawningRunner');
    // 单例分发实现不得在子类重复（registerExitCleanup/unregisterExitCleanup
    // 只存在于 SpawningRunner 基类）。
    expect(session).not.toContain('registerExitCleanup(');
    expect(session).not.toContain('unregisterExitCleanup(');

    const runner = read('claude/runner.ts');
    expect(runner).toContain('implements AgentRunner');
    expect(runner).not.toContain('registerExitCleanup(');
    expect(runner).not.toContain('unregisterExitCleanup(');
  });
});
