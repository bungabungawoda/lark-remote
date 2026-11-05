/**
 * summarizeToolInput 的行为钉子。
 *
 * 等价拆分只改结构、不改字段口径；本文件把现有口径逐条固定下来，
 * 让「抽闭包 / switch 改查表」这类重构可以在不改行为的前提下验证。
 */

import { describe, expect, it } from 'vitest';
import { asRecord, HEADER_SUMMARY_MAX, summarizeToolInput, toolKindOf } from './tool-summary.js';

describe('asRecord', () => {
  it('对象原样返回，null / 非对象字符串返回 null', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord(42)).toBeNull();
    expect(asRecord('not json')).toBeNull();
  });

  it('JSON 字符串可解析，但 JSON 标量不算对象', () => {
    expect(asRecord('{"command":"npm test"}')).toEqual({ command: 'npm test' });
    expect(asRecord('"a string"')).toBeNull();
  });
});

describe('toolKindOf 别名表', () => {
  it('同义工具名归到同一类别', () => {
    expect(toolKindOf('Bash')).toBe('shell');
    expect(toolKindOf('bash')).toBe('shell');
    expect(toolKindOf('pwsh')).toBe('shell');
    expect(toolKindOf('WebSearch')).toBe('websearch');
    expect(toolKindOf('web_search')).toBe('websearch_queries');
    expect(toolKindOf('unknown-tool')).toBeUndefined();
  });
});

describe('summarizeToolInput 已知类别', () => {
  it('shell 取 command 并压平空白', () => {
    expect(summarizeToolInput('Bash', { command: 'npm   test\n--watch' })).toBe('npm test --watch');
    expect(summarizeToolInput('pwsh', { command: 'Get-ChildItem' })).toBe('Get-ChildItem');
  });

  it('file 取 file_path，缺则回退 path', () => {
    expect(summarizeToolInput('Read', { file_path: 'src/a.ts', path: 'src/b.ts' })).toBe(
      'src/a.ts',
    );
    expect(summarizeToolInput('Write', { path: 'src/b.ts' })).toBe('src/b.ts');
    expect(summarizeToolInput('NotebookEdit', {})).toBe('');
  });

  it('grep 拼 pattern in path，并分别按 40 / 30 截断', () => {
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO in src');
    expect(summarizeToolInput('grep', { pattern: 'TODO' })).toBe('TODO');
    const longPattern = 'p'.repeat(50);
    const longPath = 'd'.repeat(40);
    const out = summarizeToolInput('Grep', { pattern: longPattern, path: longPath });
    expect(out).toBe(`${'p'.repeat(39)}… in ${'d'.repeat(29)}…`);
  });

  it('glob / ls / webfetch 各取单一字段', () => {
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(summarizeToolInput('ls', { path: '/home/user/project' })).toBe('/home/user/project');
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });

  it('websearch / websearch_queries 取 queries 首项，缺则回退 query', () => {
    expect(summarizeToolInput('WebSearch', { queries: ['first', 'second'] })).toBe('first');
    expect(summarizeToolInput('web_search', { queries: [{ path: 'a.md' }] })).toBe('a.md');
    expect(summarizeToolInput('web_search', { queries: 'single' })).toBe('single');
    expect(summarizeToolInput('WebSearch', { query: 'fallback' })).toBe('fallback');
    expect(summarizeToolInput('WebSearch', { queries: [] })).toBe('');
  });
});

describe('summarizeToolInput 按名字分支', () => {
  it('subagent 类取 description，缺则 subagent_type', () => {
    for (const name of ['Agent', 'Task', 'subagent', 'workflow']) {
      expect(summarizeToolInput(name, { description: 'review code' })).toBe('review code');
    }
    expect(summarizeToolInput('Agent', { subagent_type: 'explore' })).toBe('explore');
  });

  it('todo_write 输出完成进度与首个 in_progress 项', () => {
    expect(
      summarizeToolInput('todo_write', {
        todos: [
          { status: 'completed', content: 'a' },
          { status: 'in_progress', content: '现在  在做的事' },
          { status: 'pending', content: 'c' },
        ],
      }),
    ).toBe('已完成 1/3 · 现在 在做的事');
    expect(
      summarizeToolInput('todo_write', {
        todos: [{ status: 'completed', content: 'a' }],
      }),
    ).toBe('已完成 1/1');
    expect(summarizeToolInput('todo_write', {})).toBe('');
  });

  it('后台任务 / 展示 / 技能 / 其它分支', () => {
    expect(summarizeToolInput('job_output', { job_id: 'j1' })).toBe('j1');
    expect(summarizeToolInput('job_kill', { job_id: 'j2' })).toBe('j2');
    expect(summarizeToolInput('job_list', {})).toBe('（列出任务）');
    expect(summarizeToolInput('present', { files: ['a.md', 'b.md'] })).toBe('a.md');
    expect(summarizeToolInput('skill', { name: 'sample-skill' })).toBe('sample-skill');
    expect(summarizeToolInput('run_code', { language: 'ts' })).toBe('ts');
    expect(summarizeToolInput('terminal_send', { text: 'ls -la' })).toBe('ls -la');
    expect(summarizeToolInput('send_message', { agent_id: 'w1' })).toBe('w1');
    expect(summarizeToolInput('interrupt_agent', { description: 'stop' })).toBe('stop');
  });

  it('ask_user_question 只统计数组长度', () => {
    expect(summarizeToolInput('ask_user_question', { questions: [1, 2] })).toBe('2 个问题');
    expect(summarizeToolInput('ask_user_question', { questions: 'nope' })).toBe('');
  });
});

describe('summarizeToolInput 兜底与边界', () => {
  it('未知工具按固定顺序取第一个可用字段', () => {
    expect(summarizeToolInput('mystery', { query: 'q', command: 'c' })).toBe('c');
    expect(summarizeToolInput('mystery', { query: 'q', file_path: 'f' })).toBe('f');
    expect(summarizeToolInput('mystery', { query: 'q', url: 'u' })).toBe('q');
    expect(summarizeToolInput('mystery', { url: 'u' })).toBe('u');
    expect(summarizeToolInput('mystery', {})).toBe('');
  });

  it('非对象输入返回空串；JSON 字符串输入同样生效', () => {
    expect(summarizeToolInput('Bash', null)).toBe('');
    expect(summarizeToolInput('Bash', 'oops')).toBe('');
    expect(summarizeToolInput('Bash', '{"command":"from json"}')).toBe('from json');
  });

  it('长字段按 HEADER_SUMMARY_MAX 截断且不产生孤立代理项', () => {
    const out = summarizeToolInput('Bash', { command: '😀'.repeat(60) });
    expect(out.length).toBeLessThanOrEqual(HEADER_SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
  });
});
