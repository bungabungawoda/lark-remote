import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseCliArgs, printVersion } from './dir.js';

describe('parseCliArgs version flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should set version for -v', () => {
    expect(parseCliArgs(['-v']).version).toBe(true);
  });

  it('should set version for --version', () => {
    expect(parseCliArgs(['--version']).version).toBe(true);
  });

  it('should not set version when absent', () => {
    expect(parseCliArgs([]).version).toBeUndefined();
  });

  it('should parse version together with other flags', () => {
    const result = parseCliArgs(['--config-dir', '/tmp/foo', '--version']);
    expect(result.version).toBe(true);
    expect(result.configDir).toBe('/tmp/foo');
  });
});

describe('parseCliArgs update flag', () => {
  it('should set update for --update', () => {
    expect(parseCliArgs(['--update']).update).toBe(true);
  });

  it('should not set update when absent', () => {
    expect(parseCliArgs([]).update).toBeUndefined();
  });

  it('should parse --update together with --config-dir', () => {
    const result = parseCliArgs(['--config-dir', '/tmp/foo', '--update']);
    expect(result.update).toBe(true);
    expect(result.configDir).toBe('/tmp/foo');
  });
});

describe('printVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should print lark-remote <version> to stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printVersion();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^lark-remote \d+\.\d+\.\d+\n$/));
  });
});
