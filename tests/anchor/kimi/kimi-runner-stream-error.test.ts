/**
 * Anchor Test: KimiRunner completion 有超时保护
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const kimiRunnerPath = path.join(process.cwd(), 'src/runner/kimi/runner.ts');

describe('KimiRunner completion timeout guard', () => {
  it('test_anchor_kimi_completion_has_timeout_race', () => {
    const source = fs.readFileSync(kimiRunnerPath, 'utf-8');

    // Check for Promise.race with timeout pattern
    const hasTimeoutGuard = source.includes('Promise.race') && source.includes('timeout');

    expect(hasTimeoutGuard).toBe(true);
  });
});
