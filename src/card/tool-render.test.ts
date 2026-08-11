import { describe, expect, it } from 'vitest';
import { toolHeaderText, toolBodyMd } from './tool-render.js';
import { createInitialRunState, reduceRunState } from './run-state.js';
import type { ToolEntry } from './run-state.js';

/** Construct a ToolEntry with sensible defaults, overriding only what the test needs. */
function makeTool(overrides: Partial<ToolEntry> & Pick<ToolEntry, 'name'>): ToolEntry {
  const { name, ...rest } = overrides;
  return {
    id: 't1',
    name,
    status: 'ok',
    input: {},
    ...rest,
  };
}

/**
 * P3-6 anchors: in the real pipeline `reduceAssistantEvent` stores tool input
 * as `truncateDetail(stringifyUnknown(content.input))` — a STRING (truncated to
 * MAX_TOOL_DETAIL_CHARS=3000). `asRecord` re-`JSON.parse`s that string on EVERY
 * render (twice per tool — header `summarizeInput` + body `renderInput`). The
 * P3-6 refactor caches the parsed record (computed once from the truncated
 * stored string) so render does zero parsing.
 *
 * These anchors build the tool via `reduceRunState` (the real store path, which
 * applies stringify + truncate), then render via the exported `toolHeaderText`/
 * `toolBodyMd`. They lock the OBSERVABLE behavior so the cache cannot silently
 * change what the user sees:
 *
 * 1. normal (≤ 3000 chars) input renders the correct field.
 * 2. over-cap (> 3000 chars) input renders NO input summary/body — truncation
 *    breaks the JSON, `asRecord` returns null. The cache must be computed from
 *    the TRUNCATED string to preserve this.
 * 3. non-JSON-able input falls back gracefully (no crash, no spurious field).
 * 4. rendering twice yields identical output (cache does not drift).
 *
 * All four are GREEN today; the green refactor must keep them GREEN.
 */
describe('tool-render input parse (P3-6)', () => {
  /** Store a tool_use via the real reducer and return its ToolEntry. */
  function storeTool(name: string, input: unknown, id = 'tool-1'): ToolEntry {
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    const block = state.blocks.find((b) => b.kind === 'tool');
    if (!block || block.kind !== 'tool') throw new Error('tool block not stored');
    return block.tool;
  }

  it('test_anchor_tool_input_normal_json_renders_field', () => {
    const tool = storeTool('Bash', { command: 'pwd && echo done' });
    // Header summary pulls `command`.
    expect(toolHeaderText(tool)).toBe('⏳ **Bash** — pwd && echo done');
    // Body renders the command in a bash fence.
    expect(toolBodyMd(tool)).toContain('**Command**');
    expect(toolBodyMd(tool)).toContain('pwd && echo done');
  });

  it('test_anchor_tool_input_over_cap_json_renders_no_input', () => {
    // A Bash command whose JSON.stringify exceeds MAX_TOOL_DETAIL_CHARS (3000).
    // The store path truncates the string, breaking the JSON; `asRecord` must
    // parse to null → empty header summary and empty body input.
    const longCommand = 'x'.repeat(3200);
    const tool = storeTool('Bash', { command: longCommand });
    // Header: no "—" suffix because summary is empty.
    expect(toolHeaderText(tool)).toBe('⏳ **Bash**');
    // Body: no **Command** block (renderInput returned '').
    expect(toolBodyMd(tool)).not.toContain('**Command**');
  });

  it('test_anchor_tool_input_non_json_string_falls_back_empty', () => {
    // A string input that is not JSON: `stringifyUnknown` returns it as-is
    // (typeof string → returned verbatim), truncateDetail leaves short strings
    // intact, `asRecord`'s JSON.parse fails → null. Must not crash, must render
    // no input summary/body.
    const tool = storeTool('Bash', 'not valid json {{{');
    expect(toolHeaderText(tool)).toBe('⏳ **Bash**');
    expect(toolBodyMd(tool)).not.toContain('**Command**');
  });

  it('test_anchor_tool_input_renders_identically_across_calls', () => {
    const tool = storeTool('Read', { file_path: '/repo/a.ts' });
    const header1 = toolHeaderText(tool);
    const body1 = toolBodyMd(tool);
    const header2 = toolHeaderText(tool);
    const body2 = toolBodyMd(tool);
    expect(header2).toBe(header1);
    expect(body2).toBe(body1);
    expect(header1).toBe('⏳ **Read** — /repo/a.ts');
    expect(body1).toContain('/repo/a.ts');
  });
});

// ── Direct unit tests for toolHeaderText / toolBodyMd ──
// These construct ToolEntry objects directly (no reducer) for focused
// branch-level coverage of summarizeInput, renderInput, and asRecord.

describe('toolHeaderText', () => {
  it('Grep: header shows "pattern in path"', () => {
    const tool = makeTool({ name: 'Grep', input: { pattern: 'TODO', path: 'src/' } });
    expect(toolHeaderText(tool)).toBe('✅ **Grep** — TODO in src/');
  });

  it('Glob: header shows pattern', () => {
    const tool = makeTool({ name: 'Glob', input: { pattern: '**/*.ts' } });
    expect(toolHeaderText(tool)).toBe('✅ **Glob** — **/*.ts');
  });

  it('ls: header shows path', () => {
    const tool = makeTool({ name: 'ls', input: { path: '/repo/src' } });
    expect(toolHeaderText(tool)).toBe('✅ **ls** — /repo/src');
  });

  it('WebFetch: header shows url', () => {
    const tool = makeTool({ name: 'WebFetch', input: { url: 'https://example.com' } });
    expect(toolHeaderText(tool)).toBe('✅ **WebFetch** — https://example.com');
  });

  it('WebSearch: header shows query', () => {
    const tool = makeTool({ name: 'WebSearch', input: { query: 'vitest coverage' } });
    expect(toolHeaderText(tool)).toBe('✅ **WebSearch** — vitest coverage');
  });

  it('Agent: header shows description', () => {
    const tool = makeTool({ name: 'Agent', input: { description: 'research module A' } });
    expect(toolHeaderText(tool)).toBe('✅ **Agent** — research module A');
  });

  it('Task: header shows description', () => {
    const tool = makeTool({ name: 'Task', input: { description: 'fix bug #42' } });
    expect(toolHeaderText(tool)).toBe('✅ **Task** — fix bug #42');
  });

  it('Agent: falls back to subagent_type when description is absent', () => {
    const tool = makeTool({ name: 'Agent', input: { subagent_type: 'researcher' } });
    expect(toolHeaderText(tool)).toBe('✅ **Agent** — researcher');
  });

  it('Unknown tool: falls back to command key', () => {
    const tool = makeTool({ name: 'CustomTool', input: { command: 'deploy' } });
    expect(toolHeaderText(tool)).toBe('✅ **CustomTool** — deploy');
  });

  it('Unknown tool: falls back to file_path key', () => {
    const tool = makeTool({ name: 'CustomTool', input: { file_path: '/tmp/x' } });
    expect(toolHeaderText(tool)).toBe('✅ **CustomTool** — /tmp/x');
  });

  it('Unknown tool: falls back to path key', () => {
    const tool = makeTool({ name: 'CustomTool', input: { path: '/tmp/y' } });
    expect(toolHeaderText(tool)).toBe('✅ **CustomTool** — /tmp/y');
  });

  it('Unknown tool: falls back to query key', () => {
    const tool = makeTool({ name: 'CustomTool', input: { query: 'search-term' } });
    expect(toolHeaderText(tool)).toBe('✅ **CustomTool** — search-term');
  });

  it('Unknown tool with no recognized keys: header has no summary suffix', () => {
    const tool = makeTool({ name: 'CustomTool', input: { foo: 'bar' } });
    expect(toolHeaderText(tool)).toBe('✅ **CustomTool**');
  });

  it('status running shows hourglass icon', () => {
    const tool = makeTool({ name: 'Bash', status: 'running', input: { command: 'sleep 1' } });
    expect(toolHeaderText(tool)).toBe('⏳ **Bash** — sleep 1');
  });

  it('status error shows cross icon', () => {
    const tool = makeTool({ name: 'Bash', status: 'error', input: { command: 'false' } });
    expect(toolHeaderText(tool)).toBe('❌ **Bash** — false');
  });

  it('Grep with pattern but no path: header shows pattern only', () => {
    const tool = makeTool({ name: 'Grep', input: { pattern: 'FIXME' } });
    expect(toolHeaderText(tool)).toBe('✅ **Grep** — FIXME');
  });

  it('Grep with path but no pattern: header shows empty pattern + " in path"', () => {
    const tool = makeTool({ name: 'Grep', input: { path: 'src/' } });
    // pick('pattern', 40) returns '' when pattern is absent,
    // but the switch code does `p ? "${pat} in ${p}" : pat`
    // so if path exists, it still shows " in src/"
    expect(toolHeaderText(tool)).toBe('✅ **Grep** —  in src/');
  });

  it('Grep with very long pattern truncates to 40 chars', () => {
    const longPattern = 'a'.repeat(60);
    const tool = makeTool({ name: 'Grep', input: { pattern: longPattern, path: 'src/' } });
    const header = toolHeaderText(tool);
    // pattern truncated to 40 + ellipsis
    expect(header).toContain('aaaa… in src/');
    expect(header).toBe(`✅ **Grep** — ${'a'.repeat(40)}… in src/`);
  });

  it('WebSearch query truncated to 60 chars', () => {
    const longQuery = 'q'.repeat(80);
    const tool = makeTool({ name: 'WebSearch', input: { query: longQuery } });
    expect(toolHeaderText(tool)).toBe(`✅ **WebSearch** — ${'q'.repeat(60)}…`);
  });

  it('long header summary truncated to HEADER_SUMMARY_MAX (80)', () => {
    const longCmd = 'x'.repeat(100);
    const tool = makeTool({ name: 'Bash', input: { command: longCmd } });
    expect(toolHeaderText(tool)).toBe(`✅ **Bash** — ${'x'.repeat(80)}…`);
  });

  // ── Lowercase tool names ──
  it('lowercase bash works same as Bash', () => {
    const tool = makeTool({ name: 'bash', input: { command: 'ls' } });
    expect(toolHeaderText(tool)).toBe('✅ **bash** — ls');
  });

  it('lowercase read works same as Read', () => {
    const tool = makeTool({ name: 'read', input: { file_path: '/a.ts' } });
    expect(toolHeaderText(tool)).toBe('✅ **read** — /a.ts');
  });

  it('lowercase grep works same as Grep', () => {
    const tool = makeTool({ name: 'grep', input: { pattern: 'TODO', path: 'src/' } });
    expect(toolHeaderText(tool)).toBe('✅ **grep** — TODO in src/');
  });

  it('find works same as Glob', () => {
    const tool = makeTool({ name: 'find', input: { pattern: '*.js' } });
    expect(toolHeaderText(tool)).toBe('✅ **find** — *.js');
  });

  it('lowercase edit works same as Edit', () => {
    const tool = makeTool({ name: 'edit', input: { file_path: '/b.ts' } });
    expect(toolHeaderText(tool)).toBe('✅ **edit** — /b.ts');
  });

  it('lowercase write works same as Write', () => {
    const tool = makeTool({ name: 'write', input: { file_path: '/c.ts' } });
    expect(toolHeaderText(tool)).toBe('✅ **write** — /c.ts');
  });
});

describe('toolBodyMd', () => {
  it('Grep body shows Pattern + Path fields', () => {
    const tool = makeTool({ name: 'Grep', input: { pattern: 'TODO', path: 'src/' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Pattern** `TODO`');
    expect(body).toContain('**Path** `src/`');
  });

  it('Grep body shows only Pattern when path is absent', () => {
    const tool = makeTool({ name: 'Grep', input: { pattern: 'TODO' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Pattern** `TODO`');
    expect(body).not.toContain('**Path**');
  });

  it('Glob body shows Pattern field', () => {
    const tool = makeTool({ name: 'Glob', input: { pattern: '**/*.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Pattern** `**/*.ts`');
  });

  it('ls body shows Path field', () => {
    const tool = makeTool({ name: 'ls', input: { path: '/repo/src' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Path** `/repo/src`');
  });

  it('WebFetch body shows URL', () => {
    const tool = makeTool({ name: 'WebFetch', input: { url: 'https://example.com' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**URL** https://example.com');
  });

  it('WebSearch body shows Query', () => {
    const tool = makeTool({ name: 'WebSearch', input: { query: 'vitest coverage' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Query** `vitest coverage`');
  });

  it('running status with no output shows "运行中…"', () => {
    const tool = makeTool({ name: 'Bash', status: 'running', input: { command: 'sleep 10' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('_运行中…_');
    // Should NOT contain Output or Error headings
    expect(body).not.toContain('**Output**');
    expect(body).not.toContain('**Error**');
  });

  it('error status with output shows Error heading', () => {
    const tool = makeTool({
      name: 'Bash',
      status: 'error',
      input: { command: 'false' },
      output: 'Command failed with exit code 1',
    });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Error**');
    expect(body).not.toContain('**Output**');
    expect(body).toContain('Command failed with exit code 1');
  });

  it('ok status with output shows Output heading', () => {
    const tool = makeTool({
      name: 'Bash',
      status: 'ok',
      input: { command: 'echo hi' },
      output: 'hi',
    });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Output**');
    expect(body).not.toContain('**Error**');
    expect(body).toContain('hi');
  });

  it('body exceeding BODY_TOTAL_MAX gets truncated', () => {
    // Grep body does NOT truncate Pattern/Path fields per-field (only Bash
    // command and Glob pattern are truncated). Use a very long pattern + output
    // to exceed BODY_TOTAL_MAX (2500).
    const longPattern = 'p'.repeat(1500);
    const longOutput = 'x'.repeat(1200);
    const tool = makeTool({
      name: 'Grep',
      status: 'ok',
      input: { pattern: longPattern, path: 'src/' },
      output: longOutput,
    });
    const body = toolBodyMd(tool);
    expect(body).toContain('_（body 已截断，完整内容查日志）_');
  });

  it('output exceeding OUTPUT_MAX (1200) gets truncated per field', () => {
    const longOutput = 'y'.repeat(2000);
    const tool = makeTool({
      name: 'Bash',
      status: 'ok',
      input: { command: 'echo big' },
      output: longOutput,
    });
    const body = toolBodyMd(tool);
    // Output section should be truncated to 1200 chars + ellipsis
    expect(body).toContain('y…');
    // But should NOT contain 2000 consecutive y's
    expect(body).not.toContain('y'.repeat(1300));
  });

  it('Bash body renders Command in bash fence', () => {
    const tool = makeTool({ name: 'Bash', input: { command: 'npm test' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Command**\n```bash\nnpm test\n```');
  });

  it('Read body renders File with backtick', () => {
    const tool = makeTool({ name: 'Read', input: { file_path: '/repo/a.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/repo/a.ts`');
  });

  it('Edit body renders File with backtick', () => {
    const tool = makeTool({ name: 'Edit', input: { file_path: '/repo/b.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/repo/b.ts`');
  });

  it('Write body renders File with backtick', () => {
    const tool = makeTool({ name: 'Write', input: { file_path: '/repo/c.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/repo/c.ts`');
  });

  it('NotebookEdit body renders File with backtick', () => {
    const tool = makeTool({ name: 'NotebookEdit', input: { file_path: '/repo/d.ipynb' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/repo/d.ipynb`');
  });

  it('Read with path fallback (no file_path) renders File', () => {
    const tool = makeTool({ name: 'Read', input: { path: '/alt/path.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/alt/path.ts`');
  });

  it('unknown tool renders no input section in body', () => {
    const tool = makeTool({ name: 'CustomTool', input: { command: 'deploy' } });
    const body = toolBodyMd(tool);
    // renderInput returns '' for unknown tools
    expect(body).toBe('');
  });

  it('unknown tool with output still renders Output', () => {
    const tool = makeTool({
      name: 'CustomTool',
      input: { command: 'deploy' },
      output: 'deployed!',
    });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Output**');
    expect(body).toContain('deployed!');
  });

  it('lowercase bash renders Command in bash fence', () => {
    const tool = makeTool({ name: 'bash', input: { command: 'ls -la' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Command**\n```bash\nls -la\n```');
  });

  it('lowercase grep renders Pattern + Path', () => {
    const tool = makeTool({ name: 'grep', input: { pattern: 'FIXME', path: 'lib/' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Pattern** `FIXME`');
    expect(body).toContain('**Path** `lib/`');
  });

  it('find renders Pattern field', () => {
    const tool = makeTool({ name: 'find', input: { pattern: '*.css' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**Pattern** `*.css`');
  });

  it('lowercase edit renders File', () => {
    const tool = makeTool({ name: 'edit', input: { file_path: '/e.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/e.ts`');
  });

  it('lowercase write renders File', () => {
    const tool = makeTool({ name: 'write', input: { file_path: '/f.ts' } });
    const body = toolBodyMd(tool);
    expect(body).toContain('**File** `/f.ts`');
  });

  it('no input and no output renders empty string', () => {
    const tool = makeTool({ name: 'Bash', input: {} });
    const body = toolBodyMd(tool);
    expect(body).toBe('');
  });
});

describe('asRecord edge cases (via toolHeaderText / toolBodyMd)', () => {
  it('input is a valid JSON string: parses correctly', () => {
    const tool = makeTool({ name: 'Bash', input: '{"command":"ls"}' });
    expect(toolHeaderText(tool)).toBe('✅ **Bash** — ls');
    expect(toolBodyMd(tool)).toContain('**Command**');
    expect(toolBodyMd(tool)).toContain('ls');
  });

  it('input is an invalid JSON string: header is empty, body has no input', () => {
    const tool = makeTool({ name: 'Bash', input: 'not valid json {{{' });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
    expect(toolBodyMd(tool)).not.toContain('**Command**');
  });

  it('input is null: header is empty', () => {
    const tool = makeTool({ name: 'Bash', input: null });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
    expect(toolBodyMd(tool)).not.toContain('**Command**');
  });

  it('input is undefined: header is empty', () => {
    const tool = makeTool({ name: 'Bash', input: undefined });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
    expect(toolBodyMd(tool)).not.toContain('**Command**');
  });

  it('input is a number: header is empty', () => {
    const tool = makeTool({ name: 'Bash', input: 42 });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
  });

  it('input is a boolean: header is empty', () => {
    const tool = makeTool({ name: 'Bash', input: true });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
  });

  it('input is JSON string of non-object (array): header is empty', () => {
    const tool = makeTool({ name: 'Bash', input: '[1,2,3]' });
    // Array is typeof object but not a plain record; asRecord checks p && typeof p === 'object'
    // but arrays pass the typeof check; however they are not Record<string, unknown> with string keys
    // that match the pick() function's key lookups, so no recognized fields will be found
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
  });

  it('input is JSON string of primitive: header is empty', () => {
    const tool = makeTool({ name: 'Bash', input: '"hello"' });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
  });

  it('parsedInput is used instead of input when set', () => {
    const tool = makeTool({
      name: 'Bash',
      input: '{"command":"wrong"}',
      parsedInput: { command: 'correct' },
    });
    expect(toolHeaderText(tool)).toBe('✅ **Bash** — correct');
    expect(toolBodyMd(tool)).toContain('correct');
    expect(toolBodyMd(tool)).not.toContain('wrong');
  });

  it('parsedInput null means no input (not fallback to input)', () => {
    const tool = makeTool({
      name: 'Bash',
      input: { command: 'should-be-ignored' },
      parsedInput: null,
    });
    expect(toolHeaderText(tool)).toBe('✅ **Bash**');
    expect(toolBodyMd(tool)).not.toContain('should-be-ignored');
  });

  it('parsedInput undefined falls back to input', () => {
    const tool = makeTool({
      name: 'Bash',
      input: { command: 'fallback' },
      parsedInput: undefined,
    });
    expect(toolHeaderText(tool)).toBe('✅ **Bash** — fallback');
    expect(toolBodyMd(tool)).toContain('fallback');
  });
});
