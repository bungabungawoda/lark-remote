import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSessionContent } from '../../src/session/claude/sessions.js';
import { enforceCardBudget } from '../../src/card/card-budget.js';

describe('ws.use auto-resume budget bug - anchor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-auto-resume-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Anchor test: 验证修复 - readSessionContent 应该支持 maxEvents 参数，
   * 限制读取的事件数量，避免 enforceCardBudget 强制截断到 5 个面板
   *
   * 当前 BUG: 20 个事件 → enforceCardBudget → 只有 5 个面板可见
   * 期望修复: readSessionContent(maxEvents=10) → 只读 10 个事件 → 10 个面板
   *
   * RED: 当前实现没有 maxEvents 参数，读取全部 20 个事件，导致只能看到 5 个
   * GREEN: 修复后 readSessionContent 支持 maxEvents，限制为 10 个事件
   */
  it('FIX: readSessionContent should support maxEvents parameter to limit events', () => {
    const cwd = '/tmp/test-project';
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'test-session-many-events';

    // 创建 session：最后一个 user 后有 20 个 assistant 事件
    const lines: string[] = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
    ];

    lines.push(
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"last question"}]}}`,
    );

    // 20 个长 assistant 事件，每个约 2KB
    for (let i = 1; i <= 20; i++) {
      const content = `response ${i} ` + 'x'.repeat(2000);
      lines.push(
        `{"type":"assistant","message":{"id":"ma${i}","role":"assistant","content":[{"type":"text","text":"${content}"}]}}`,
      );
    }

    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    // 修复后的预期行为：限制读取为 10 个事件
    const maxEvents = 10;
    const result = readSessionContent(sessionId, cwd, { projectsDir: tmpDir, maxEvents });

    // 验证：应该只读取 10 个事件（而非 20 个）
    expect(result.events.length).toBe(10);

    // 模拟 buildAutoResumeCard 的渲染逻辑
    const elements: object[] = [];
    result.events.forEach((ev, i) => {
      elements.push({
        tag: 'collapsible_panel',
        expanded: i >= result.events.length - 2,
        header: { title: { tag: 'lark_md', content: `🤖 assistant` } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: ev.content } }],
      });
    });

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🔁 自动恢复会话' } },
      body: { elements },
    };

    // enforceCardBudget 不应该再触发极端截断
    const budgetResult = enforceCardBudget(card);

    const panelCount =
      (budgetResult.card as any).body?.elements?.filter((el: any) => el.tag === 'collapsible_panel')
        .length ?? 0;

    // 验证：10 个事件 → 10 个面板（不被截断）
    expect(panelCount).toBe(10);
    expect(budgetResult.wasTruncated).toBe(false);

    console.log('FIX VERIFIED: user can see', panelCount, 'events (not just 5)');
  });

  /**
   * Boundary: maxEvents 大于实际事件数 → 应读取全部事件
   */
  it('maxEvents greater than actual event count returns all events', () => {
    const cwd = '/tmp/test-boundary-more';
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'test-boundary-more';

    const lines: string[] = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"question"}]}}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}`,
    ];
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    // maxEvents=100 远大于实际 1 个事件
    const result = readSessionContent(sessionId, cwd, { projectsDir: tmpDir, maxEvents: 100 });
    expect(result.events.length).toBe(1);
  });

  /**
   * Boundary: maxEvents=0 → 应返回 0 个事件
   */
  it('maxEvents=0 returns zero events', () => {
    const cwd = '/tmp/test-boundary-zero';
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'test-boundary-zero';

    const lines: string[] = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"question"}]}}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}`,
    ];
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const result = readSessionContent(sessionId, cwd, { projectsDir: tmpDir, maxEvents: 0 });
    expect(result.events.length).toBe(0);
  });

  /**
   * Backward compatibility: 不传 maxEvents → 读取全部事件（向后兼容）
   */
  it('without maxEvents reads all events (backward compatible)', () => {
    const cwd = '/tmp/test-backward-compat';
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'test-backward-compat';

    const lines: string[] = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"question"}]}}`,
    ];
    for (let i = 1; i <= 15; i++) {
      lines.push(
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer ${i}"}]}}`,
      );
    }
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const result = readSessionContent(sessionId, cwd, { projectsDir: tmpDir });
    expect(result.events.length).toBe(15);
  });

  /**
   * Multi-block messages: review P2-7 统一 maxEvents 契约为「最后 N 个 event」
   * （与 codex/opencode/pi/kimi 的 slice(-maxEvents) 对齐）。旧实现取 tail 的
   * 「前 N」并在 message boundary 软截断（不拆分单消息多 block）；新实现统一为
   * 硬 slice(-maxEvents)，保留最近 N 个 event。本 anchor 同步更新为「最后 N」语义。
   */
  it('maxEvents keeps the LAST N events (review P2-7 unified contract)', () => {
    const cwd = '/tmp/test-multi-block';
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'test-multi-block';

    const lines: string[] = [
      `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"question"}]}}`,
      // 第一条 assistant：1 个 text block
      `{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"first answer"}]}}`,
      // 第二条 assistant：2 个 blocks (text + tool_use)
      `{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"second answer"},{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/x"}}]}}`,
      // 第三条 assistant：1 个 text block
      `{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"third answer"}]}}`,
    ];
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    // maxEvents=2: 保留最后 2 个 event = m2 的 tool_use + m3 的 text（硬 slice(-2)）
    const result = readSessionContent(sessionId, cwd, { projectsDir: tmpDir, maxEvents: 2 });
    expect(result.events.length).toBe(2); // 最后 2 个 event
    expect(result.events[0].type).toBe('tool_use');
    expect(result.events[1].content).toBe('third answer');
  });
});
