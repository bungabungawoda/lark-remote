/**
 * Anchor Test: ClaudeRunner extends SpawningRunner (R16)
 *
 * Behavior verified (①):
 *   ClaudeRunner is a subclass of SpawningRunner. The spawn orchestration
 *   surface — `run()`, `stop()`, `killOrphan()`, and the `isRunning` getter —
 *   is INHERITED from the base class, not duplicated inside ClaudeRunner.
 *   A fresh instance reports `isRunning === false` because no child process
 *   has been spawned yet.
 *
 * What goes wrong if missing/incorrect (②):
 *   If ClaudeRunner merely `implements IAgentRunner` (current state) instead
 *   of `extends SpawningRunner`, the ~150 lines of spawn orchestration remain
 *   duplicated in src/runner/claude/runner.ts. The "deep module" deletion
 *   promised by the SpawningRunner deep-module refactor
 *   does not happen, and the four sibling runners (kimi/pi/codex/opencode)
 *   cannot follow the same collapse pattern.
 *
 * Spec basis (③):
 *   SpawningRunner deep-module refactor —
 *   "子类只覆盖 3 个 hook：buildArgv(opts) / translate(rawEvent, ctx) /
 *    validateConfig()；concrete run() / stop() / killOrphan() / isRunning
 *    由 base 提供。"
 *
 * Anti-Goodhart note: this is a genuine behavioral contract (instanceof
 * check on the prototype chain), not a tautology. No spawn, no logger mock,
 * no fixture — the test only verifies the class hierarchy and inherited
 * method presence on a fresh instance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { ClaudeRunner } from '../../../src/runner/index.js';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';

const PID_DIR = '/tmp/r16-claude-base-test';

describe('R16: ClaudeRunner extends SpawningRunner', () => {
  afterEach(() => {
    // Defensive: ClaudeRunner constructor does not write the pid file, but
    // if a future change does, we don't want to leak state across runs.
    try {
      fs.rmSync(PID_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('test_anchor_claude_runner_extends_spawning_runner', () => {
    const runner = new ClaudeRunner({ workspace: 'test', binary: 'fake-claude', pidDir: PID_DIR });

    // Core contract: ClaudeRunner IS-A SpawningRunner. Today this is RED
    // because ClaudeRunner `implements IAgentRunner` and does not extend
    // SpawningRunner — spawn orchestration is duplicated, not inherited.
    expect(runner).toBeInstanceOf(SpawningRunner);

    // Inherited public methods must exist on the instance. These would
    // resolve via the prototype chain once ClaudeRunner extends the base.
    expect(typeof runner.killOrphan).toBe('function');
    expect(typeof runner.stop).toBe('function');
    expect(typeof runner.run).toBe('function');

    // Inherited getter: a fresh instance with no spawned process must
    // report not-running. Verifies the base-class getter is wired through.
    expect(runner.isRunning).toBe(false);
  });
});
