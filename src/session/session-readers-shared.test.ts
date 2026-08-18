import { describe, it, expect } from 'vitest';
import { extractContentBlocks } from './common/content-blocks.js';
import { CLAUDE_MAPPING } from './claude/session-index.js';
import { PI_MAPPING } from './pi/sessions.js';

// ─── extractContentBlocks ─────────────────────────────────────────────────────

describe('extractContentBlocks', () => {
  const claudeMapping = CLAUDE_MAPPING;

  // case 6: non-array input
  it('returns [] for non-array input (null)', () => {
    expect(extractContentBlocks(null, claudeMapping)).toEqual([]);
  });

  it('returns [] for non-array input (string)', () => {
    expect(extractContentBlocks('str', claudeMapping)).toEqual([]);
  });

  it('returns [] for non-array input (plain object)', () => {
    expect(extractContentBlocks({}, claudeMapping)).toEqual([]);
  });

  // case 7: text + thinking mixed, blank text skipped
  it('extracts text and thinking blocks in order, skipping blank text', () => {
    const content = [
      { type: 'text', text: '  hello  ' },
      { type: 'text', text: '   ' },
      { type: 'thinking', thinking: '  hmm  ' },
    ];
    expect(extractContentBlocks(content, claudeMapping)).toEqual([
      { type: 'text', content: 'hello' },
      { type: 'thinking', content: 'hmm' },
    ]);
  });

  // case 8: tool_use with input
  it('formats tool_use block with name and input', () => {
    const content = [{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }];
    const result = extractContentBlocks(content, claudeMapping);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
    expect(result[0].content).toContain('🔧 Bash:');
    expect(result[0].content).toContain('"cmd": "ls"');
  });

  // case 9: tool_use without input → serialized as {}
  it('formats tool_use block with empty object when input is missing', () => {
    const content = [{ type: 'tool_use', name: 'Read' }];
    const result = extractContentBlocks(content, claudeMapping);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
    expect(result[0].content).toContain('🔧 Read:');
    expect(result[0].content).toContain('{}');
  });

  // case 10: tool_result string content
  it('formats tool_result with string content as green', () => {
    const content = [{ type: 'tool_result', content: 'ok' }];
    const result = extractContentBlocks(content, claudeMapping);
    expect(result).toEqual([{ type: 'tool_result', content: '🟢 tool_result: ok' }]);
  });

  // case 11: tool_result with is_error
  it('formats tool_result with is_error as red', () => {
    const content = [{ type: 'tool_result', content: 'boom', is_error: true }];
    const result = extractContentBlocks(content, claudeMapping);
    expect(result).toEqual([{ type: 'tool_result', content: '🔴 tool_result: boom' }]);
  });

  // case 12: tool_result array content
  it('joins tool_result array content from .text fields', () => {
    const content = [{ type: 'tool_result', content: [{ text: 'a' }, { text: 'b' }] }];
    const result = extractContentBlocks(content, claudeMapping);
    expect(result).toEqual([{ type: 'tool_result', content: '🟢 tool_result: ab' }]);
  });

  // case 13: tool_result with blank/whitespace content → no output
  it('skips tool_result with whitespace-only content', () => {
    const content = [{ type: 'tool_result', content: '   ' }];
    expect(extractContentBlocks(content, claudeMapping)).toEqual([]);
  });

  // case 14: pi-style mapping (parameterized field names)
  it('works with pi-style mapping for tool_use', () => {
    const piMapping = PI_MAPPING;
    const content = [{ type: 'toolCall', name: 'Search', arguments: { query: 'test' } }];
    const result = extractContentBlocks(content, piMapping);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
    expect(result[0].content).toContain('🔧 Search:');
    expect(result[0].content).toContain('"query": "test"');
  });

  it('works with pi-style mapping for tool_result', () => {
    const piMapping = PI_MAPPING;
    const content = [{ type: 'toolResult', content: 'done', isError: true }];
    const result = extractContentBlocks(content, piMapping);
    expect(result).toEqual([{ type: 'tool_result', content: '🔴 tool_result: done' }]);
  });

  // case 15: long input truncation
  it('truncates tool_use content when serialized input exceeds 200 chars', () => {
    const longValue = 'x'.repeat(300);
    const content = [{ type: 'tool_use', name: 'Bash', input: { cmd: longValue } }];
    const result = extractContentBlocks(content, claudeMapping);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
    // content should end with '...' and the part after '🔧 Bash: ' should be ≤ 200 chars
    expect(result[0].content).toMatch(/🔧 Bash: .*\.\.\.$/);
    const body = result[0].content.replace('🔧 Bash: ', '');
    expect(body.length).toBeLessThanOrEqual(200);
    expect(body.endsWith('...')).toBe(true);
  });
});
