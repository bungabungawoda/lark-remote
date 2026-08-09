import { describe, expect, test } from 'vitest';
import { readJsonlLines } from '../../../src/session/common/jsonl.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * P2-37 anchor: readJsonlLines is the only jsonl helper whose `fs.openSync`
 * sits outside any try/catch, so a missing file throws ENOENT instead of
 * returning `[]` like every sibling helper (findJsonlLine -> null,
 * readLastJsonlLine -> null, readLastNJsonlLines -> [], scanJsonlLines -> [],
 * readJsonlLinesFromOffset -> []).
 *
 * Contract: readJsonlLines on a nonexistent file should return `[]`.
 * Current behavior: throws ENOENT → this test is a true RED.
 */
describe('anchor readJsonlLines error contract', () => {
  test('test_anchor_p2_37_readjsonlines_missing_file_returns_empty_array', () => {
    const nonexistentPath = join(tmpdir(), `p2-37-nonexistent-${process.pid}.jsonl`);

    // Sanity: file truly does not exist.
    expect(() => readJsonlLines(nonexistentPath)).not.toThrow();

    const result = readJsonlLines(nonexistentPath);
    expect(result).toEqual([]);
  });
});
