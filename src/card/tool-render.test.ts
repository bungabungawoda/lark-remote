import { describe, expect, it } from 'vitest';
import { toolHeaderText, toolBodyMd, displayWidth, HEADER_DISPLAY_MAX } from './tool-render.js';
import { createInitialRunState, reduceRunState } from './run-state.js';
import type { ToolEntry } from './run-state.js';

/**
 * s: in the real pipeline `reduceAssistantEvent` stores tool input
 * as `truncateDetail(stringifyUnknown(content.input))` — a STRING (truncated to
 * MAX_TOOL_DETAIL_CHARS=3000). `asRecord` re-`JSON.parse`s that string on EVERY
 * render (twice per tool — header `summarizeInput` + body `renderInput`). The
 * refactor caches the parsed record (computed once from the truncated
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
describe('tool-render input parse', () => {
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
  function makeTool(overrides: Partial<ToolEntry> & Pick<ToolEntry, 'name'>): ToolEntry {
    return {
      id: 't1',
      status: overrides.status ?? 'ok',
      input: overrides.input ?? {},
      ...overrides,
    };
  }

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

  it('Grep with very long pattern still fits one panel title line', () => {
    const longPattern = 'a'.repeat(60);
    const tool = makeTool({ name: 'Grep', input: { pattern: longPattern, path: 'src/' } });
    const header = toolHeaderText(tool);
    // 标题按**显示宽度**收敛（面板标题在手机上必须一行），完整 pattern 在正文里。
    // 截断是**中间省略**：保留开头（工具名）与结尾（路径/文件名）。
    expect(displayWidth(header)).toBeLessThanOrEqual(HEADER_DISPLAY_MAX);
    expect(header).toContain('…');
  });

  it('WebSearch query keeps the title within the display budget', () => {
    const longQuery = 'q'.repeat(80);
    const tool = makeTool({ name: 'WebSearch', input: { query: longQuery } });
    expect(displayWidth(toolHeaderText(tool))).toBeLessThanOrEqual(HEADER_DISPLAY_MAX);
  });

  it('long header summary is cut by display width, not char count', () => {
    const longCmd = 'x'.repeat(100);
    const tool = makeTool({ name: 'Bash', input: { command: longCmd } });
    const header = toolHeaderText(tool);
    expect(displayWidth(header)).toBeLessThanOrEqual(HEADER_DISPLAY_MAX);
    expect(header).toContain('…');
    // 半角字符按 1 计：前缀 `✅ **Bash** — ` 原样保留
    expect(header.startsWith('✅ **Bash** — xxx')).toBe(true);
  });

  it('CJK titles are cut earlier (a CJK char is two half-widths)', () => {
    const cjk = '中'.repeat(40);
    const tool = makeTool({ name: 'Bash', input: { command: cjk } });
    const header = toolHeaderText(tool);
    expect(displayWidth(header)).toBeLessThanOrEqual(HEADER_DISPLAY_MAX);
    expect(header).toContain('…');
  });

  it('keeps the tail of a long path so the filename survives', () => {
    const tool = makeTool({
      name: 'read',
      input: {
        file_path: '/home/user/notes-app/docs/notes/2026-10-19-vision-remaining.md',
      },
    });
    const header = toolHeaderText(tool);
    expect(displayWidth(header)).toBeLessThanOrEqual(HEADER_DISPLAY_MAX);
    // 中间省略：结尾的文件名必须还在（头部截断会把文件名整个切掉）
    expect(header.endsWith('remaining.md')).toBe(true);
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
  function makeTool(overrides: Partial<ToolEntry> & Pick<ToolEntry, 'name'>): ToolEntry {
    return {
      id: 't1',
      status: overrides.status ?? 'ok',
      input: overrides.input ?? {},
      ...overrides,
    };
  }

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
  function makeTool(overrides: Partial<ToolEntry> & Pick<ToolEntry, 'name'>): ToolEntry {
    return {
      id: 't1',
      status: overrides.status ?? 'ok',
      input: overrides.input ?? {},
      ...overrides,
    };
  }

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

// ============================================================================
// 信息保真 toolHint 优先渲染（runner 自愿声明，渲染层只消费不推断）
// ============================================================================

describe('tool-render toolHint (信息保真)', () => {
  function makeTool(overrides: Partial<ToolEntry> & Pick<ToolEntry, 'name'>): ToolEntry {
    return {
      id: 't1',
      status: overrides.status ?? 'ok',
      input: overrides.input ?? {},
      ...overrides,
    };
  }

  it('hint shell + unknown name renders the Bash command body', () => {
    const tool = makeTool({
      name: 'weird_custom_name',
      toolHint: 'shell',
      input: { command: 'bun test' },
    });
    const body = toolBodyMd(tool);
    expect(body).toContain('```bash');
    expect(body).toContain('bun test');
    expect(body).toContain('**Command**');
  });

  it('no hint + unknown name keeps current behavior (body empty, header summarizeInput fallback)', () => {
    const tool = makeTool({
      name: 'weird_custom_name',
      input: { command: 'bun test' },
    });
    // 回归：无 hint 时行为与现状一致——body 无结构化渲染，
    // 标题靠 summarizeInput 的 default 分支兜底（取 command）。
    expect(toolBodyMd(tool)).not.toContain('**Command**');
    expect(toolHeaderText(tool)).toContain('bun test');
  });

  it('hint file + unknown name renders file path', () => {
    const tool = makeTool({
      name: 'weird_file_tool',
      toolHint: 'file',
      input: { path: '/home/user/project/a.ts' },
    });
    expect(toolBodyMd(tool)).toContain('**File**');
    expect(toolBodyMd(tool)).toContain('/home/user/project/a.ts');
  });

  it('hint search + unknown name renders pattern', () => {
    const tool = makeTool({
      name: 'weird_search_tool',
      toolHint: 'search',
      input: { pattern: 'placeholder', path: '/home/user/project' },
    });
    expect(toolBodyMd(tool)).toContain('**Pattern**');
    expect(toolBodyMd(tool)).toContain('placeholder');
  });

  it('hint web + unknown name renders query', () => {
    const tool = makeTool({
      name: 'weird_web_tool',
      toolHint: 'web',
      input: { query: 'placeholder' },
    });
    expect(toolBodyMd(tool)).toContain('**Query**');
    expect(toolBodyMd(tool)).toContain('placeholder');
  });

  it('hint web + url input renders URL（url 优先于 query）', () => {
    const tool = makeTool({
      name: 'weird_fetch_tool',
      toolHint: 'web',
      input: { url: 'https://example.com/page' },
    });
    expect(toolBodyMd(tool)).toContain('**URL**');
    expect(toolBodyMd(tool)).toContain('https://example.com/page');
  });

  it('hint patch + unknown name renders file path（对齐规范的 Edit 语义）', () => {
    const tool = makeTool({
      name: 'weird_patch_tool',
      toolHint: 'patch',
      input: { file_path: '/home/user/project/b.ts' },
    });
    expect(toolBodyMd(tool)).toContain('**File**');
    expect(toolBodyMd(tool)).toContain('/home/user/project/b.ts');
  });

  it('header appends original title as — summary subtitle when name is mapped (C3 配套直测)', () => {
    // kind 映射后 name='Read'，原始 title='placeholder' → 标题末尾追加副标题。
    const tool = makeTool({
      name: 'Read',
      summary: 'placeholder',
      input: { path: '/home/user/project/a.ts' },
      parsedInput: { path: '/home/user/project/a.ts' },
    });
    // 标题总宽受显示预算约束（手机一行）：超宽时中间省略——开头（工具名）与
    // 结尾（副标题）保留，路径中段被压缩，完整值在正文里。
    const header = toolHeaderText(tool);
    expect(displayWidth(header)).toBeLessThanOrEqual(HEADER_DISPLAY_MAX);
    expect(header.startsWith('✅ **Read** — /home/u')).toBe(true);
    expect(header).toContain('placeholder');
  });

  it('header without summary stays unchanged (回归)', () => {
    const tool = makeTool({
      name: 'Read',
      input: { path: '/home/user/project/a.ts' },
      parsedInput: { path: '/home/user/project/a.ts' },
    });
    expect(toolHeaderText(tool)).toBe('✅ **Read** — /home/user/project/a.ts');
  });

  it('header dedupes identical summary and args (opencode title === command)', () => {
    // opencode sends title = command AND rawInput.command = command → the two
    // slots carry the same value; render it once, not `ls — ls`.
    const tool = makeTool({
      name: 'Bash',
      input: { command: 'ls' },
      parsedInput: { command: 'ls' },
      summary: 'ls',
    });
    expect(toolHeaderText(tool)).toBe('✅ **Bash** — ls');
  });
});

/**
 * DSH 工具名（snake_case）的摘要口径。
 *
 * 为什么单列一组：DSH 的工具名与 Claude/Codex 不同名（`glob`/`web_search`/
 * `todo_write`/`subagent`/`job_*`），且参数名也不同（`queries[]` 而非
 * `query`、`file_path` 而非 `path`）。缺这些映射时，摘要在 default 分支里
 * 退化成空字符串——卡片上只剩 `✅ **glob**`，用户看不到跑了什么。
 */
describe('tool-render DSH tool summaries', () => {
  function makeTool(overrides: Partial<ToolEntry> & Pick<ToolEntry, 'name'>): ToolEntry {
    return {
      id: 't1',
      status: overrides.status ?? 'ok',
      input: overrides.input ?? {},
      ...overrides,
    };
  }

  it('glob shows the pattern (not the directory)', () => {
    const tool = makeTool({ name: 'glob', input: { pattern: '**/*.ts', path: 'src' } });
    expect(toolHeaderText(tool)).toBe('✅ **glob** — **/*.ts');
  });

  it('read_image shows file_path', () => {
    const tool = makeTool({ name: 'read_image', input: { file_path: 'shot.png' } });
    expect(toolHeaderText(tool)).toBe('✅ **read_image** — shot.png');
  });

  it('pwsh shows the command', () => {
    const tool = makeTool({ name: 'pwsh', input: { command: 'Get-ChildItem' } });
    expect(toolHeaderText(tool)).toBe('✅ **pwsh** — Get-ChildItem');
  });

  it('web_search reads the queries array', () => {
    const tool = makeTool({ name: 'web_search', input: { queries: ['dsh 卡片', 'cardkit'] } });
    expect(toolHeaderText(tool)).toBe('✅ **web_search** — dsh 卡片');
  });

  it('web_fetch shows the url', () => {
    const tool = makeTool({ name: 'web_fetch', input: { url: 'https://example.com/a' } });
    expect(toolHeaderText(tool)).toBe('✅ **web_fetch** — https://example.com/a');
  });

  it('todo_write shows progress plus the in-progress item', () => {
    const tool = makeTool({
      name: 'todo_write',
      input: {
        todos: [
          { content: '读代码', status: 'completed' },
          { content: '改渲染', status: 'in_progress' },
          { content: '跑测试', status: 'pending' },
        ],
      },
    });
    expect(toolHeaderText(tool)).toBe('✅ **todo_write** — 已完成 1/3 · 改渲染');
  });

  it('todo_write without an in-progress item shows only progress', () => {
    const tool = makeTool({
      name: 'todo_write',
      input: { todos: [{ content: 'a', status: 'completed' }] },
    });
    expect(toolHeaderText(tool)).toBe('✅ **todo_write** — 已完成 1/1');
  });

  it('subagent shows the delegated description', () => {
    const tool = makeTool({ name: 'subagent', input: { description: '梳理卡片预算' } });
    expect(toolHeaderText(tool)).toBe('✅ **subagent** — 梳理卡片预算');
  });

  it('job tools show the job id', () => {
    expect(toolHeaderText(makeTool({ name: 'job_kill', input: { job_id: 'j-1' } }))).toBe(
      '✅ **job_kill** — j-1',
    );
    expect(toolHeaderText(makeTool({ name: 'job_output', input: { job_id: 'j-2' } }))).toBe(
      '✅ **job_output** — j-2',
    );
  });

  it('present shows the first delivered file', () => {
    const tool = makeTool({
      name: 'present',
      input: { files: [{ path: 'docs/a.md' }, { path: 'docs/b.md' }] },
    });
    expect(toolHeaderText(tool)).toBe('✅ **present** — docs/a.md');
  });

  it('ask_user_question shows the question count', () => {
    const tool = makeTool({
      name: 'ask_user_question',
      input: { questions: [{ question: 'a' }, { question: 'b' }] },
    });
    expect(toolHeaderText(tool)).toBe('✅ **ask_user_question** — 2 个问题');
  });

  it('web_search body renders every query', () => {
    const tool = makeTool({ name: 'web_search', input: { queries: ['a', 'b'] } });
    expect(toolBodyMd(tool)).toContain('`a` / `b`');
  });
});
