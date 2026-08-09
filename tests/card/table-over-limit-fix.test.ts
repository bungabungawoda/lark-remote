import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState, finishRun } from '../../src/card/run-state.js';
import { renderRunCard } from '../../src/card/run-renderer.js';
import { countMarkdownTables, FEISHU_MAX_TABLES } from '../../src/card/text-truncate.js';

/**
 * Test anchor: markdown tables in text blocks are truncated to FEISHU_MAX_TABLES
 * to avoid triggering Feishu ErrCode 11310 (card table number over limit).
 *
 * Key insight (2026-08-07): collapsible_panel does NOT shield markdown tables
 * from Feishu's 11310 table count limit. Tables inside lark_md text are still
 * counted regardless of container. The fix is to truncate excess tables
 * directly in the text content before rendering.
 */
describe('table-over-limit fix', () => {
  it('test_anchor_countMarkdownTables_various_separators', () => {
    // Standard separator
    expect(countMarkdownTables('|---|---|')).toBe(1);
    // Separator with spaces
    expect(countMarkdownTables('| --- | --- |')).toBe(1);
    // Separator with alignment
    expect(countMarkdownTables('|:---|:---:|')).toBe(1);
    // Multiple separators = multiple tables
    expect(countMarkdownTables('|---|---|---|\n|---|---|')).toBe(2);
    // No separator line
    expect(countMarkdownTables('| cell | cell |')).toBe(0);
    // Empty
    expect(countMarkdownTables('')).toBe(0);
  });

  it('test_anchor_text_block_with_6_markdown_tables_truncated_to_5', () => {
    // Build a RunState with a text block containing 6 markdown tables
    // (exceeds FEISHU_MAX_TABLES=5, triggers table truncation to avoid 11310)

    let state = createInitialRunState('run-table-test');

    // Create content with EXACTLY 6 markdown tables to exceed FEISHU_MAX_TABLES=5
    const contentWith6Tables = `## 设计方案

### 方案一

| 组件 | 状态 |
|---|---|
| A | 🟢 |

### 方案二

| 模块 | 风险 |
|---|---|
| M1 | 低 |

### 方案三

| 层级 | 技术 |
|---|---|
| 前端 | React |

### 方案四

| 阶段 | 任务 |
|---|---|
| 1 | 准备 |

### 方案五

| 类型 | 值 |
|---|---|
| X | Y |

### 方案六

| 选项 | 结果 |
|---|---|
| OK | 是 |

### 总结

推荐方案二。`;

    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: contentWith6Tables }] },
    });

    // === Running state: text block is wrapped in collapsible_panel ===
    const runningCard = renderRunCard(state) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const runningElements = runningCard.body?.elements ?? [];

    // The text block must be wrapped in collapsible_panel
    const outputPanelsInRunning = runningElements.filter(
      (el) =>
        el.tag === 'collapsible_panel' &&
        (
          (el as { header?: { title?: { content?: string } } }).header?.title?.content ?? ''
        ).includes('💬'),
    );
    expect(outputPanelsInRunning.length).toBeGreaterThanOrEqual(1);
    // Panel is expanded (running state, visible output)
    expect((outputPanelsInRunning[0] as { expanded?: boolean }).expanded).toBe(true);

    // Table truncation: 6 tables → only 5 remain, oldest 1 removed
    const panelContent = JSON.stringify(outputPanelsInRunning[0]);
    // Newest 5 tables (方案二 through 方案六) should be present
    expect(panelContent).toContain('方案二');
    expect(panelContent).toContain('方案六');
    // Oldest table (方案一) should be removed
    expect(panelContent).not.toContain('方案一');
    // Hint about omitted tables
    expect(panelContent).toContain('前 1 个表格已省略');
    // Summary text should remain
    expect(panelContent).toContain('推荐方案二');

    // === Terminal (done) state: same truncation logic applies ===
    state = finishRun(state, 'done', { resultSubtype: 'success' });
    const doneCard = renderRunCard(state) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const doneElements = doneCard.body?.elements ?? [];
    const doneJson = JSON.stringify(doneCard);

    // Newest 5 tables still present in done state
    expect(doneJson).toContain('方案二');
    expect(doneJson).not.toContain('方案一');

    // In done state, text IS wrapped in collapsible_panel
    const outputPanelsInDone = doneElements.filter(
      (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('方案二'),
    );
    expect(outputPanelsInDone.length).toBe(1);
    // Panel is expanded (always expanded in terminal state for full visibility)
    expect((outputPanelsInDone[0] as { expanded?: boolean }).expanded).toBe(true);
  });

  it('test_anchor_text_block_with_few_tables_stays_intact', () => {
    // Text with only 3 markdown tables (under FEISHU_MAX_TABLES=5).
    // No truncation needed.
    let state = createInitialRunState('run-few-tables');

    const contentWith3Tables = `## 对比

| A | B |
|---|---|
| 1 | 2 |

| C | D |
|---|---|
| 3 | 4 |

| E | F |
|---|---|
| 5 | 6 |`;

    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: contentWith3Tables }] },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });

    const card = renderRunCard(state) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const elements = card.body?.elements ?? [];
    const json = JSON.stringify(card);

    // All 3 tables should be present (no truncation)
    expect(json).toContain('对比');
    // No truncation hint should appear (tables are within limit)
    expect(json).not.toContain('个表格已省略');

    // Text IS wrapped in collapsible_panel (to protect tables)
    const textPanel = elements.find(
      (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('对比'),
    );
    expect(textPanel).toBeDefined();
    // Panel is expanded (always expanded in terminal state)
    expect((textPanel as { expanded?: boolean }).expanded).toBe(true);
  });

  it('test_anchor_6_tables_truncated_in_rendered_card', () => {
    // Regression test: 6 markdown tables must be truncated to FEISHU_MAX_TABLES
    // in the rendered card to avoid Feishu ErrCode 11310.
    let state = createInitialRunState('run-6-tables');

    const contentWith6Tables = `## npx vs pnpx

| Feature | npx | pnpx |
|---|---|---|
| PM | npm | pnpm |

| Behavior | DL | Store |
|---|---|---|
| a | b | c |

| Lockfile | None | Temp |
|---|---|---|
| a | b | c |

| .npmrc | Proj | Global |
|---|---|---|
| a | b | c |

| Phantom | Allow | No |
|---|---|---|
| a | b | c |

| Compat | Most | Strict |
|---|---|---|
| a | b | c |

**Conclusion**: pnpx requires stricter package.json.`;

    // Verify we actually have 6 tables
    expect(countMarkdownTables(contentWith6Tables)).toBe(6);

    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: contentWith6Tables }] },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });

    const card = renderRunCard(state) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const json = JSON.stringify(card);

    // Must fit in card budget
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);

    // Rendered card must have at most FEISHU_MAX_TABLES tables
    expect(countMarkdownTables(json)).toBeLessThanOrEqual(FEISHU_MAX_TABLES);

    // Newest 5 tables (Behavior through Compat) should be present
    expect(json).toContain('Behavior');
    expect(json).toContain('Compat');
    // Oldest table (Feature | npx | pnpx header) should be removed
    expect(json).not.toContain('Feature');
    // "npx" still appears in "pnpx" text, so check the full header row instead
    expect(json).not.toContain('| PM | npm | pnpm |');
    // Hint about omitted tables
    expect(json).toContain('前 1 个表格已省略');

    // Conclusion text should remain
    expect(json).toContain('pnpx requires stricter');

    // Text IS wrapped in collapsible_panel
    const panel = (card.body?.elements ?? []).find(
      (el) => el.tag === 'collapsible_panel' && json.includes('Behavior'),
    );
    expect(panel).toBeDefined();
    // Panel is expanded for full visibility
    expect((panel as { expanded?: boolean }).expanded).toBe(true);
  });
});
