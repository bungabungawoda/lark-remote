/**
 * Anchor Test: KimiRunner stderr 监听器
 *
 * Bug: spawn 创建了 stderr pipe 但没有监听器，导致错误信息丢失
 *
 * The stderr handler lives in src/runner/common/spawning-runner.ts (the base
 * class) instead of src/runner/kimi/runner.ts. All 5 runners (claude/codex/opencode/pi/
 * kimi) inherit the same stderr accumulation behavior from the base class.
 *
 * This anchor was updated to grep the base class file because:
 *   1. The kimi/runner.ts file no longer contains the stderr handler
 *      (it inherits from base)
 *   2. The base class is where the behavior actually lives for all 5
 *      runners — pinning it here ensures any future refactor that moves
 *      stderr handling out of the base class will fail this anchor.
 *   3. The behavior contract (stderr 'data' listener exists somewhere in
 *      the runner stack) is preserved — only the source file location
 *      changed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const spawningRunnerPath = path.join(process.cwd(), 'src/runner/common/spawning-runner.ts');

describe('KimiRunner stderr handling (via SpawningRunner base class)', () => {
  it('test_anchor_kimi_stderr_on_data_listener_exists_in_source', () => {
    const source = fs.readFileSync(spawningRunnerPath, 'utf-8');

    // Check for stderr.on with any quote style — the handler now lives in
    // the base class so all 5 runners (claude/codex/opencode/pi/kimi)
    // inherit identical stderr accumulation behavior.
    const hasStderrHandler =
      source.includes('stderr.on') ||
      source.includes('proc.stderr.on') ||
      source.includes('proc.stderr?.on');

    expect(hasStderrHandler).toBe(true);
  });
});
