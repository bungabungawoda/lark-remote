import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findJsonlLine, readLastJsonlLine } from './jsonl.js';

describe('findJsonlLine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-iter-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. 匹配在多行中间：3 行文件 pred 匹配第 2 行 → 返回第 2 行内容
  it('returns the matching line in the middle of a multi-line file', () => {
    const filePath = join(tmpDir, 'mid.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const result = findJsonlLine(filePath, (line) => line.includes('"b"'));
    expect(result).toBe('{"b":2}');
  });

  // 2. 无匹配 → null
  it('returns null when no line matches the predicate', () => {
    const filePath = join(tmpDir, 'nomatch.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n');
    const result = findJsonlLine(filePath, (line) => line.includes('"z"'));
    expect(result).toBeNull();
  });

  // 3. 空行与纯空白行被跳过：pred 只应对非空行求值
  it('skips empty and whitespace-only lines without calling pred', () => {
    const filePath = join(tmpDir, 'blanks.jsonl');
    writeFileSync(filePath, '\n   \n{"a":1}\n');
    const pred = vi.fn((line: string) => line.includes('"a"'));
    const result = findJsonlLine(filePath, pred);
    expect(result).toBe('{"a":1}');
    expect(pred).toHaveBeenCalledTimes(1);
  });

  // 4. pred 收到的是 trim 后的行
  it('passes trim-med lines to the predicate', () => {
    const filePath = join(tmpDir, 'trim.jsonl');
    writeFileSync(filePath, '  {"a":1}  \n');
    const pred = vi.fn((line: string) => line === '{"a":1}');
    const result = findJsonlLine(filePath, pred);
    expect(result).toBe('{"a":1}');
    expect(pred).toHaveBeenCalledWith('{"a":1}');
  });

  // 5. 文件不存在 → null
  it('returns null when the file does not exist', () => {
    const result = findJsonlLine(join(tmpDir, 'nope.jsonl'), () => true);
    expect(result).toBeNull();
  });

  // 6. 无结尾换行：pred 匹配最后一行
  it('matches the last line when there is no trailing newline', () => {
    const filePath = join(tmpDir, 'notrail.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}');
    const result = findJsonlLine(filePath, (line) => line.includes('"b"'));
    expect(result).toBe('{"b":2}');
  });
});

describe('readLastJsonlLine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-iter-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 7. 常规：返回最后一个非空行
  it('returns the last non-empty line from a normal file', () => {
    const filePath = join(tmpDir, 'normal.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n');
    const result = readLastJsonlLine(filePath);
    expect(result).toBe('{"b":2}');
  });

  // 8. 无结尾换行：也能正确返回最后一行
  it('returns the last line when there is no trailing newline', () => {
    const filePath = join(tmpDir, 'notrail.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}');
    const result = readLastJsonlLine(filePath);
    expect(result).toBe('{"b":2}');
  });

  // 9. 末尾多个空行被跳过
  it('skips trailing empty lines', () => {
    const filePath = join(tmpDir, 'trailblanks.jsonl');
    writeFileSync(filePath, '{"a":1}\n\n\n');
    const result = readLastJsonlLine(filePath);
    expect(result).toBe('{"a":1}');
  });

  // 10. 空文件 → null
  it('returns null for an empty file', () => {
    const filePath = join(tmpDir, 'empty.jsonl');
    writeFileSync(filePath, '');
    const result = readLastJsonlLine(filePath);
    expect(result).toBeNull();
  });

  // 11. 文件不存在 → null
  it('returns null when the file does not exist', () => {
    const result = readLastJsonlLine(join(tmpDir, 'nope.jsonl'));
    expect(result).toBeNull();
  });
});
