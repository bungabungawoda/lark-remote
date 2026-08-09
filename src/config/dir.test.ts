import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseCliArgs } from './dir.js';

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

  it('should parse version together with other flags', () => {
    const result = parseCliArgs(['--config-dir', '/tmp/foo', '--version']);
    expect(result.version).toBe(true);
    expect(result.configDir).toBe('/tmp/foo');
  });
});
