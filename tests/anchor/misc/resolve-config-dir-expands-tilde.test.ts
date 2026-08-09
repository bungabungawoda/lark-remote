import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { resolveConfigDir } from '../../../src/config/dir.js';

describe('P2-33 resolveConfigDir tilde expansion', () => {
  it('test_anchor_resolve_config_dir_expands_tilde', () => {
    // "~/foo/bar" should expand to <homedir>/foo/bar, not <cwd>/~/foo/bar
    expect(resolveConfigDir('~/.lr2')).toBe(path.join(os.homedir(), '.lr2'));
    expect(resolveConfigDir('~/foo/bar')).toBe(path.join(os.homedir(), 'foo/bar'));
    // bare "~" should be homedir
    expect(resolveConfigDir('~')).toBe(os.homedir());
  });
});
