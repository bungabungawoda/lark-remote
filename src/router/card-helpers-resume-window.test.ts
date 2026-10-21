import { describe, it, expect } from 'vitest';
import type { AgentSessionContentEvent } from '../runner/index.js';
import { buildSessionHistoryCard, pickResumeCardEvents } from './card-helpers.js';

/**
 * resume 卡的取景口径。
 *
 * 验证什么：卡片窗口按"最后 N 条"截，但必须保住最后一条用户消息与最后一条
 * assistant 正文——工具往返不能把它俩挤出卡。
 * 缺失后果：2026-10-19 自动恢复卡 5 个面板全是 bash 调用，用户看不到自己上一句、
 * 也看不到上一轮的最终答复，只能误判成"会话看不到我"，转而点"新会话"把上下文清零。
 */
function ev(type: string, content: string, minute: number): AgentSessionContentEvent {
  return {
    type,
    content,
    timestamp: new Date(Date.UTC(2026, 9, 19, 15, minute, 0)).toISOString(),
  };
}

/** 一段"上一轮问答 + 当前轮工具往返"的会话尾巴。 */
function toolHeavyTail(): AgentSessionContentEvent[] {
  return [
    ev('user', '上一轮的问题', 0),
    ev('assistant', '上一轮的最终答复', 1),
    ev('tool_use', 'bash — git status', 2),
    ev('tool_use', 'bash — rg foo', 3),
    ev('thinking', '继续排查', 4),
    ev('tool_use', 'bash — sed -n 1,20p a.ts', 5),
    ev('tool_use', 'bash — sed -n 1,20p b.ts', 6),
    ev('tool_use', 'bash — grep -n x c.ts', 7),
  ];
}

describe('pickResumeCardEvents', () => {
  it('keeps the last user message and the last assistant answer inside a tool-noise tail', () => {
    const events = toolHeavyTail();
    const picked = pickResumeCardEvents(events, 5);

    expect(picked).toHaveLength(5);
    expect(picked.map((e) => e.content)).toContain('上一轮的问题');
    expect(picked.map((e) => e.content)).toContain('上一轮的最终答复');
    // 时间顺序不变：锚点补进来也不能乱序。
    expect(picked.map((e) => e.timestamp)).toEqual(
      [...picked.map((e) => e.timestamp)].sort((a, b) => (a ?? '').localeCompare(b ?? '')),
    );
    // 新事件仍在：窗口不是"只剩问答"。
    expect(picked.at(-1)?.content).toBe('bash — grep -n x c.ts');
  });

  it('returns every event when the session is shorter than the window', () => {
    const events = toolHeavyTail().slice(0, 4);
    expect(pickResumeCardEvents(events, 5)).toEqual(events);
  });

  it('returns nothing for a zero window', () => {
    expect(pickResumeCardEvents(toolHeavyTail(), 0)).toEqual([]);
  });

  it('falls back to a plain tail when there is no user/assistant anchor', () => {
    const events = toolHeavyTail().slice(2);
    expect(pickResumeCardEvents(events, 5)).toEqual(events.slice(-5));
  });

  it('leaves the tail untouched when both anchors are already inside the window', () => {
    const events: AgentSessionContentEvent[] = [
      ev('tool_use', 'bash — pwd', 0),
      ev('user', '最后一个问题', 1),
      ev('assistant', '最后一个答复', 2),
      ev('tool_use', 'bash — ls', 3),
    ];
    expect(pickResumeCardEvents(events, 5)).toEqual(events);
  });

  it('never duplicates an anchor that is also the newest event', () => {
    const events = toolHeavyTail().concat([ev('user', '刚发的新问题', 8)]);
    const picked = pickResumeCardEvents(events, 5);
    const contents = picked.map((e) => e.content);

    expect(picked).toHaveLength(5);
    expect(new Set(contents).size).toBe(contents.length);
    expect(contents).toContain('刚发的新问题');
    expect(contents).toContain('上一轮的最终答复');
  });
});

describe('resume card rendering with the new window', () => {
  it('renders the last question and the last answer as panels, not only tool calls', () => {
    const events = toolHeavyTail();
    const card = buildSessionHistoryCard(
      {
        sessionId: 'session-x',
        cwd: '/tmp/project',
        events: pickResumeCardEvents(events, 5),
      },
      {
        agentKind: 'dsh',
        headerText: '📂 `/tmp/project`\n已恢复最近会话: **session-x**',
        title: '🔁 自动恢复会话 · DSH',
        hiddenCount: events.length - 5,
      },
    );
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('上一轮的问题');
    expect(serialized).toContain('上一轮的最终答复');
    expect(serialized).toContain('还有 3 个更早的事件未显示');
  });

  /**
   * 验证什么：会话仍有在途 turn 时，恢复卡必须显式说明"这是快照"。
   * 缺失后果：2026-10-19 用户把一张落后于实时进度的快照读成"会话卡住了"，
   * 因为没有调 turn 而点了"新会话"，把上下文清零。
   */
  it('warns that a still-running session only shows a snapshot', () => {
    const card = buildSessionHistoryCard(
      { sessionId: 'session-y', cwd: '/tmp/project', events: toolHeavyTail().slice(-2) },
      {
        agentKind: 'dsh',
        headerText: '📂 `/tmp/project`\n已恢复最近会话: **session-y**',
        title: '🔁 自动恢复会话 · DSH',
        stillRunning: true,
      },
    );
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('仍有一个 turn 在运行');
    expect(serialized).toContain('历史快照');
  });

  it('stays quiet when the session is idle', () => {
    const card = buildSessionHistoryCard(
      { sessionId: 'session-z', cwd: '/tmp/project', events: toolHeavyTail().slice(-2) },
      {
        agentKind: 'dsh',
        headerText: '📂 `/tmp/project`\n已恢复最近会话: **session-z**',
        title: '🔁 自动恢复会话 · DSH',
      },
    );

    expect(JSON.stringify(card)).not.toContain('仍有一个 turn 在运行');
  });
});

/**
 * 详情卡头部：AI 标题 与 最近输入 是两个不同的东西。
 *
 * DSH 的服务端投影同时给出 `title`（会话标题）与末轮 prompt（最近输入）；
 * 旧实现只有一个 `displayTitle`，出现「🏷️ **AI 标题**」下面却是用户那句
 * 最近输入的情况（2026-10-21）。两者不同时必须各占一段，相同（claude 的
 * aiTitle 就是 displayTitle 的来源）时保持旧文案「AI 标题」不变。
 */
describe('buildSessionHistoryCard 头部标题段', () => {
  function headerText(card: object): string {
    const body = (card as { body: { elements: Array<{ text?: { content?: string } }> } }).body;
    return body.elements.map((el) => el.text?.content ?? '').join('\n');
  }

  it('aiTitle 与 displayTitle 不同时渲染两段（标题 + 最近输入）', () => {
    const text = headerText(
      buildSessionHistoryCard(
        {
          sessionId: 'session-1',
          cwd: '/repo',
          aiTitle: '梳理待办与依赖',
          displayTitle: '修复，还有你的历史 run log 在哪看？',
          events: [],
        },
        { agentKind: 'dsh', headerText: '📂 `/repo`\n会话: **session-1**', title: '🔁 恢复会话' },
      ),
    );

    expect(text).toContain('**标题**');
    expect(text).toContain('梳理待办与依赖');
    expect(text).toContain('**最近输入**');
    expect(text).toContain('修复，还有你的历史 run log 在哪看？');
    // 同一个值不能既当标题又当最近输入。
    expect(text.match(/梳理待办与依赖/g)).toHaveLength(1);
  });

  it('aiTitle 与 displayTitle 相同时保持「AI 标题」旧文案（claude 不回归）', () => {
    const text = headerText(
      buildSessionHistoryCard(
        {
          sessionId: 'session-2',
          cwd: '/repo',
          aiTitle: '会话标题',
          displayTitle: '会话标题',
          events: [],
        },
        {
          agentKind: 'claude',
          headerText: '📂 `/repo`\n会话: **session-2**',
          title: '🔁 恢复会话',
        },
      ),
    );

    expect(text).toContain('**AI 标题**');
    expect(text).not.toContain('**最近输入**');
    expect(text.match(/会话标题/g)).toHaveLength(1);
  });

  it('只有 displayTitle 时仍是「最近输入」', () => {
    const text = headerText(
      buildSessionHistoryCard(
        {
          sessionId: 'session-3',
          cwd: '/repo',
          displayTitle: '首条用户消息',
          events: [],
        },
        { agentKind: 'dsh', headerText: '📂 `/repo`\n会话: **session-3**', title: '🔁 恢复会话' },
      ),
    );

    expect(text).toContain('**最近输入**');
    expect(text).toContain('首条用户消息');
  });
});
