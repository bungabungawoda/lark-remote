import { describe, it, expect } from 'vitest';
import { MAX_FILE_UPLOAD_SIZE } from './file-limits.js';

describe('file-limits', () => {
  it('should export MAX_FILE_UPLOAD_SIZE as 30MB', () => {
    expect(MAX_FILE_UPLOAD_SIZE).toBe(30 * 1024 * 1024);
  });
});
