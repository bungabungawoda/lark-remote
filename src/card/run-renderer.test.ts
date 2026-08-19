import { describe, expect, it } from 'vitest';
import {
  createInitialRunState,
  finishRun,
  reduceRunState,
  type RunBlock,
  type RunState,
} from './run-state.js';
import { renderRunCard } from './run-renderer.js';

describe('renderRunCard', () => {
  it('test_anchor_approval_area_renders_v2_buttons_without_v1_action_container', () => {
    let state = createInitialRunState('run-approval');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 42,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 42,
        kind: 'command',
        command: 'ls -la',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);

    const card = renderRunCard(state) as { schema: string; body?: { elements?: object[] } };
    expect(card.schema).toBe('2.0');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('命令审批');
    expect(serialized).toContain('ls -la');
    expect(serialized).toContain('approval.respond');
    // 200861 铁律：禁止 tag:"action" 容器
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    // approval_resolved 清除审批区域
    state = reduceRunState(state, {
      type: 'approval_resolved',
      requestId: 42,
      outcome: 'resolved',
    } as never);
    const cleared = JSON.stringify(renderRunCard(state));
    expect(cleared).not.toContain('命令审批');
  });

  it('test_anchor_claude_command_approval_renders_allow_all_button_v2', () => {
    let state = createInitialRunState('run-claude-approval');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 43,
      kind: 'command',
      threadId: 'th-claude-1',
      turnId: 'tn-claude-1',
      itemId: 'item-claude-1',
      view: {
        requestId: 43,
        kind: 'command',
        command: 'git push',
        commandCwd: '/home/user/project',
        // Claude「允许所有」专属决策（acceptAll：允许当前并自动放行后续）
        availableDecisions: ['accept', 'decline', 'acceptAll'],
      },
    } as never);

    const card = renderRunCard(state) as { schema: string };
    expect(card.schema).toBe('2.0');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('命令审批');
    expect(serialized).toContain('允许所有');
    expect(serialized).toContain('approval.respond');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_command_approval_neutralizes_backticks', () => {
    // review P2-2：命令里的反引号会提前终止 lark_md 行内代码 span，奇数次
    // 反引号极易触发 11311 解析错误导致整卡失败——必须中和后再展示。
    let state = createInitialRunState('run-claude-approval-backtick');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 46,
      kind: 'command',
      threadId: 'th-claude-3',
      turnId: 'tn-claude-3',
      itemId: 'item-claude-3',
      view: {
        requestId: 46,
        kind: 'command',
        command: 'echo `id`; ls -la',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'acceptAll'],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('echo ·id·; ls -la');
    expect(serialized).not.toContain('echo `id`');
  });

  it('test_anchor_exit_plan_mode_approval_renders_tool_kind_v2', () => {
    // ExitPlanMode：kind:'tool'，渲染「📋 计划审批」+ 工具名 + reason，
    // 不落入 command 槽位显示无意义 `{}`，且无「允许所有」按钮。
    let state = createInitialRunState('run-exit-plan');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 47,
      kind: 'tool',
      threadId: 'th-plan-1',
      turnId: 'tn-plan-1',
      itemId: 'item-plan-1',
      view: {
        requestId: 47,
        kind: 'tool',
        toolName: 'ExitPlanMode',
        reason: '已按计划准备好实施方案，请审批',
        availableDecisions: ['accept', 'decline'],
      },
    } as never);

    const card = renderRunCard(state) as { schema: string };
    expect(card.schema).toBe('2.0');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('计划审批');
    expect(serialized).toContain('ExitPlanMode');
    expect(serialized).toContain('实施方案');
    expect(serialized).not.toContain('{}');
    expect(serialized).not.toContain('允许所有');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    // approval_resolved 清除审批区域
    state = reduceRunState(state, {
      type: 'approval_resolved',
      requestId: 47,
      outcome: 'resolved',
    } as never);
    expect(JSON.stringify(renderRunCard(state))).not.toContain('计划审批');
  });

  it('test_anchor_ask_user_question_renders_options_v2_without_v1_container', () => {
    let state = createInitialRunState('run-question');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 44,
      kind: 'question',
      threadId: 'th-q-1',
      turnId: 'tn-q-1',
      itemId: 'item-q-1',
      view: {
        requestId: 44,
        kind: 'question',
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
          {
            question: 'Pick toppings',
            header: 'Toppings',
            multiSelect: true,
            options: [{ label: 'Cheese' }, { label: 'Bacon' }],
            selected: ['Cheese'],
          },
        ],
        availableDecisions: [],
      },
    } as never);

    const card = renderRunCard(state) as { schema: string };
    expect(card.schema).toBe('2.0');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('需要你回答');
    expect(serialized).toContain('Pick a color');
    expect(serialized).toContain('Red');
    expect(serialized).toContain('Pick toppings');
    expect(serialized).toContain('approval.answer');
    // 多选已勾选 → 出现提交按钮
    expect(serialized).toContain('approval.answerSubmit');
    // review P3-4：单选问题提供自定义答案（Other）输入
    expect(serialized).toContain('approval.answerCustom');
    expect(serialized).toContain('自定义答案');
    expect(serialized).toContain('"tag":"input"');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_ask_user_question_option_row_left_button_right_description_with_distinct_icons', () => {
    // UI 整改：每个选项一行（column_set），左按钮右描述，按钮固定宽度保证
    // 列对齐；单选/多选图标区分（单选 ⚪/🔵，多选 ⬜/☑️）。
    let state = createInitialRunState('run-question-ui');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 50,
      kind: 'question',
      threadId: 'th-ui-1',
      turnId: 'tn-ui-1',
      itemId: 'item-ui-1',
      view: {
        requestId: 50,
        kind: 'question',
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [{ label: 'Red' }, { label: 'Blue', description: 'Cool color' }],
            selected: ['Red'],
          },
          {
            question: 'Pick toppings',
            header: 'Toppings',
            multiSelect: true,
            options: [{ label: 'Cheese' }, { label: 'Bacon' }],
            selected: ['Cheese'],
          },
        ],
        availableDecisions: [],
      },
    } as never);

    const card = renderRunCard(state) as { schema: string };
    expect(card.schema).toBe('2.0');
    const serialized = JSON.stringify(card);
    // 每个选项一行 column_set（左按钮右描述）
    expect(serialized).toContain('"tag":"column_set"');
    expect(serialized).toContain('"width":"100px"');
    expect(serialized).toContain('"width":"weighted"');
    // 单选图标：已选 🔵、未选 ⚪
    expect(serialized).toContain('🔵 Red');
    expect(serialized).toContain('⚪ Blue');
    // 多选图标：已选 ☑️、未选 ⬜
    expect(serialized).toContain('☑️ Cheese');
    expect(serialized).toContain('⬜ Bacon');
    // 按钮文案与提交按钮保留
    expect(serialized).toContain('取消选择');
    expect(serialized).toContain('approval.answerSubmit');
    // 200861 铁律：不得出现 V1 action 容器
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_ask_user_question_custom_answer_selection_visible', () => {
    // review P3：自定义答案（Other）的选中态必须可见——选项按钮无法表示
    // 自由文本，单独展示已选文本，避免「点了没反应」的困惑。
    let state = createInitialRunState('run-question-custom');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 45,
      kind: 'question',
      threadId: 'th-q-2',
      turnId: 'tn-q-2',
      itemId: 'item-q-2',
      view: {
        requestId: 45,
        kind: 'question',
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [{ label: 'Red' }, { label: 'Blue' }],
            selected: ['自定义紫色'],
          },
        ],
        availableDecisions: [],
      },
    } as never);

    const card = renderRunCard(state) as { schema: string };
    expect(card.schema).toBe('2.0');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('✍️ 自定义答案：自定义紫色');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_ask_user_question_free_text_renders_input_without_options', () => {
    // 自由文本题（Codex options:null / Pi extension input）：options 为空时
    // 不渲染选项行，渲染题面 + 输入框（placeholder 透传）+ 提交走 answerCustom。
    let state = createInitialRunState('run-question-free-text');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 60,
      kind: 'question',
      threadId: 'th-q-ft',
      turnId: 'tn-q-ft',
      itemId: 'item-q-ft',
      view: {
        requestId: 60,
        kind: 'question',
        questions: [
          {
            question: 'Commit message',
            placeholder: 'feat: ...',
            options: [],
          },
        ],
        availableDecisions: [],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('需要你回答');
    expect(serialized).toContain('Commit message');
    expect(serialized).toContain('feat: ...');
    expect(serialized).toContain('approval.answerCustom');
    expect(serialized).toContain('"tag":"input"');
    // 无选项 → 不渲染选项行按钮
    expect(serialized).not.toContain('"cmd":"approval.answer"');
    expect(serialized).not.toContain('"option":"');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_ask_user_question_free_text_echoes_answered_text', () => {
    // 多题场景：自由文本题已答后（selected 有值）卡片回显已答文本，
    // 避免 input_value 不跨卡保留导致「答了看不到」。
    let state = createInitialRunState('run-question-free-text-echo');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 64,
      kind: 'question',
      threadId: 'th-q-ft-echo',
      turnId: 'tn-q-ft-echo',
      itemId: 'item-q-ft-echo',
      view: {
        requestId: 64,
        kind: 'question',
        questions: [
          {
            question: 'Commit message',
            options: [],
            selected: ['feat: ask-user-question'],
          },
          {
            question: 'Pick a color',
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
        ],
        availableDecisions: [],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('✍️ 已答：feat: ask-user-question');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_ask_user_question_note_input_gated_by_allowNote', () => {
    // Codex user_note：allowNote=true 渲染「补充说明（可选）」输入 + 已填回显；
    // 未设置（Claude/Kimi/Pi）不渲染。
    let withNote = createInitialRunState('run-question-note');
    withNote = reduceRunState(withNote, {
      type: 'approval_requested',
      requestId: 65,
      kind: 'question',
      threadId: 'th-q-note',
      turnId: 'tn-q-note',
      itemId: 'item-q-note',
      view: {
        requestId: 65,
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            allowNote: true,
            note: '先验证 PostgreSQL 17 兼容性',
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          },
        ],
        availableDecisions: [],
      },
    } as never);
    const withNoteSerialized = JSON.stringify(renderRunCard(withNote));
    expect(withNoteSerialized).toContain('approval.answerNote');
    expect(withNoteSerialized).toContain('补充说明（可选）');
    expect(withNoteSerialized).toContain('📝 先验证 PostgreSQL 17 兼容性');
    expect(withNoteSerialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    let withoutNote = createInitialRunState('run-question-no-note');
    withoutNote = reduceRunState(withoutNote, {
      type: 'approval_requested',
      requestId: 66,
      kind: 'question',
      threadId: 'th-q-no-note',
      turnId: 'tn-q-no-note',
      itemId: 'item-q-no-note',
      view: {
        requestId: 66,
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          },
        ],
        availableDecisions: [],
      },
    } as never);
    expect(JSON.stringify(renderRunCard(withoutNote))).not.toContain('approval.answerNote');
  });

  it('test_anchor_ask_user_question_input_names_unique_when_other_and_note_coexist', () => {
    // 2026-08-19 线上 P0：单选选项题同时渲染 Other 输入 + Note 输入，二者 name
    // 均为 answer-custom-0-0 → 飞书 ErrCode 11310 拒绝整卡，提问卡静默失败致
    // run 挂起。回归：name 必须按 cmd 区分，同一题多个 input 互不重复。
    const cases = [
      {
        name: 'single-select-options-other-and-note',
        questions: [
          {
            question: 'Which database?',
            allowNote: true,
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          },
        ],
      },
      {
        name: 'multi-select-options-note',
        questions: [
          {
            question: 'Pick toppings',
            multiSelect: true,
            allowNote: true,
            options: [{ label: 'Cheese' }, { label: 'Bacon' }],
            selected: ['Cheese'],
          },
        ],
      },
      {
        name: 'free-text',
        questions: [
          {
            question: 'Commit message',
            placeholder: 'feat: ...',
            options: [],
          },
        ],
      },
    ];

    for (const c of cases) {
      let state = createInitialRunState(`run-q-unique-${c.name}`);
      state = reduceRunState(state, {
        type: 'approval_requested',
        requestId: 70,
        kind: 'question',
        threadId: 'th-q-unique',
        turnId: 'tn-q-unique',
        itemId: 'item-q-unique',
        view: { requestId: 70, kind: 'question', questions: c.questions, availableDecisions: [] },
      } as never);
      const serialized = JSON.stringify(renderRunCard(state));
      // 提取所有 input 元素的 name，断言互不重复（避免 11310）。
      const names: string[] = [];
      const re = /"tag":"input","name":"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(serialized)) !== null) names.push(m[1]);
      const unique = new Set(names);
      expect(names.length).toBe(unique.size);
      expect(names.length).toBeGreaterThan(0);
    }
  });

  it('test_anchor_ask_user_question_other_input_gated_by_isOther', () => {
    // Other 输入按 isOther !== false 显隐：Kimi form 会丢弃非声明选项值，
    // 翻译时置 isOther=false 隐藏输入；未设置（Claude）保持默认显示。
    let hidden = createInitialRunState('run-question-no-other');
    hidden = reduceRunState(hidden, {
      type: 'approval_requested',
      requestId: 61,
      kind: 'question',
      threadId: 'th-q-no-other',
      turnId: 'tn-q-no-other',
      itemId: 'item-q-no-other',
      view: {
        requestId: 61,
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            isOther: false,
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          },
        ],
        availableDecisions: [],
      },
    } as never);
    const hiddenSerialized = JSON.stringify(renderRunCard(hidden));
    expect(hiddenSerialized).not.toContain('approval.answerCustom');

    let shown = createInitialRunState('run-question-other-default');
    shown = reduceRunState(shown, {
      type: 'approval_requested',
      requestId: 62,
      kind: 'question',
      threadId: 'th-q-other',
      turnId: 'tn-q-other',
      itemId: 'item-q-other',
      view: {
        requestId: 62,
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          },
        ],
        availableDecisions: [],
      },
    } as never);
    const shownSerialized = JSON.stringify(renderRunCard(shown));
    expect(shownSerialized).toContain('approval.answerCustom');
    expect(shownSerialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_ask_user_question_renders_skip_button_via_approval_respond', () => {
    // 提问卡底部统一「⏭️ 跳过回答」：走现有 approval.respond + decision=decline，
    // runner 按协议映射跳过语义（Claude deny / Codex 空 answers / Kimi decline /
    // Pi cancelled|confirmed:false）。
    let state = createInitialRunState('run-question-skip');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 63,
      kind: 'question',
      threadId: 'th-q-skip',
      turnId: 'tn-q-skip',
      itemId: 'item-q-skip',
      view: {
        requestId: 63,
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          },
        ],
        availableDecisions: [],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('跳过回答');
    expect(serialized).toContain('approval.respond');
    expect(serialized).toContain('"decision":"decline"');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_concurrent_approvals_render_all_slots_and_resolve_independently', () => {
    // review P2-3 回归：同一 turn 内并发两个审批时，后到者不得顶掉先到者的
    // 按钮（单槽曾导致第一个审批的 UI 消失，只能等 5 分钟自动 cancel）。
    let state = createInitialRunState('run-approval-2');
    const request = (id: number, command: string) =>
      ({
        type: 'approval_requested',
        requestId: id,
        kind: 'command',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        itemId: `item-${id}`,
        view: {
          requestId: id,
          kind: 'command',
          command,
          commandCwd: '/home/user/project',
          availableDecisions: ['accept', 'decline', 'cancel'],
        },
      }) as never;

    state = reduceRunState(state, request(1, 'git push'));
    state = reduceRunState(state, request(2, 'rm -rf /tmp/x'));

    let serialized = JSON.stringify(renderRunCard(state));
    // 两个审批的命令都在卡片上，各自有按钮
    expect(serialized).toContain('git push');
    expect(serialized).toContain('rm -rf /tmp/x');
    expect((serialized.match(/approval\.respond/g) ?? []).length).toBeGreaterThanOrEqual(4);

    // 第一个审批解决后，只剩第二个的 UI
    state = reduceRunState(state, {
      type: 'approval_resolved',
      requestId: 1,
      outcome: 'resolved',
    } as never);
    serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).not.toContain('git push');
    expect(serialized).toContain('rm -rf /tmp/x');
  });

  it('test_anchor_interrupted_with_expired_approval_renders_timeout_reason', () => {
    // 2026-08-14 事故回归：审批 5 分钟无人响应→自动 cancel→turn interrupted。
    // 终态必须如实展示「审批超时未响应，已自动取消」，而不是归因于 Agent 出错，
    // 也不是泛化的「已被用户终止」（用户实际没有主动终止）。
    let state = createInitialRunState('run-approval-expired');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 11,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-11',
      view: {
        requestId: 11,
        kind: 'command',
        command: 'rm -rf /tmp/x',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    state = reduceRunState(state, { type: 'approval_expired', requestId: 11 } as never);
    const interrupted = finishRun(state, 'interrupted');

    const json = JSON.stringify(renderRunCard(interrupted));
    expect(json).toContain('审批超时未响应');
    expect(json).not.toContain('运行出错');
  });

  it('test_anchor_expired_then_resolved_still_renders_timeout_reason', () => {
    // 2026-08-15 事故回归：真实协议顺序是 requested → expired（桥侧 timer）
    // → resolved（cancel 送达后 server 回 serverRequest/resolved）→ result。
    // approval_resolved 会把审批条目从 approvals 移除，过期原因必须独立于
    // 该条目存活到终态渲染，否则卡片误报「已被用户终止」。
    let state = createInitialRunState('run-approval-expired-resolved');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 12,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-12',
      view: {
        requestId: 12,
        kind: 'command',
        command: 'rm -rf /tmp/y',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    state = reduceRunState(state, { type: 'approval_expired', requestId: 12 } as never);
    state = reduceRunState(state, {
      type: 'approval_resolved',
      requestId: 12,
      outcome: 'resolved',
    } as never);
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'interrupted',
      session_id: 's1',
    } as never);
    const interrupted = finishRun(state, 'interrupted');

    const json = JSON.stringify(renderRunCard(interrupted));
    expect(json).toContain('审批超时未响应');
    expect(json).not.toContain('已被用户终止');
    expect(json).not.toContain('运行出错');
  });

  it('test_anchor_approval_cancelled_renders_cancelled_copy', () => {
    // 用户在审批卡上主动点「取消/拒绝」与「审批超时」「手动 /stop」是三种
    // 不同的中断来源。approval_cancelled 必须渲染独立文案，不得归入
    // 「已被用户终止」或「审批超时未响应」。
    let state = createInitialRunState('run-approval-cancelled');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 13,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-13',
      view: {
        requestId: 13,
        kind: 'command',
        command: 'rm -rf /tmp/z',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    const interrupted = finishRun(state, 'interrupted', {
      interruptedReason: 'approval_cancelled',
    } as never);

    const json = JSON.stringify(renderRunCard(interrupted));
    expect(json).toContain('已取消审批');
    expect(json).not.toContain('已被用户终止');
    expect(json).not.toContain('审批超时未响应');
  });

  it('test_anchor_pending_approval_title_shows_waiting_for_approval', () => {
    // 2026-08-14 UX：审批等待期间命令工具未 completed，footer 停在 tool_running，
    // 标题此前显示「调用工具」。必须改为「等待审批」，提示当前在等人工决策。
    let state = createInitialRunState('run-approval-title');
    state = reduceRunState(state, {
      type: 'turn_diff',
      toolOutput: 'npm view lark-remote version',
      itemId: 'item-c1',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-14T00:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 1,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-c1',
      view: {
        requestId: 1,
        kind: 'command',
        command: 'npm view lark-remote version',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);

    const json = JSON.stringify(renderRunCard(state));
    expect(json).toContain('等待审批');
    expect(json).toContain('✋');
    expect(json).not.toContain('调用工具');
  });

  it('test_anchor_pending_approval_status_row_shows_waiting_not_tool_running', () => {
    // 标题已显示「等待审批」时，状态行不得再写「工具调用中」，避免自相矛盾。
    let state = createInitialRunState('run-approval-status');
    state = reduceRunState(state, {
      type: 'turn_diff',
      toolOutput: 'npm view lark-remote version',
      itemId: 'item-c1',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-14T00:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 2,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-c1',
      view: {
        requestId: 2,
        kind: 'command',
        command: 'npm view lark-remote version',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);

    const json = JSON.stringify(renderRunCard(state));
    expect(json).toContain('等待审批中');
    expect(json).not.toContain('工具调用中');
  });

  it('test_anchor_expired_approval_does_not_show_waiting_title', () => {
    // 审批已过期（按钮已隐藏，run 即将被中断）：不再显示「等待审批」，
    // 标题回退到工具调用，直到 interrupted 终态到达。
    let state = createInitialRunState('run-approval-expired-title');
    state = reduceRunState(state, {
      type: 'turn_diff',
      toolOutput: 'npm view lark-remote version',
      itemId: 'item-c1',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-14T00:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 3,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-c1',
      view: {
        requestId: 3,
        kind: 'command',
        command: 'npm view lark-remote version',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    state = reduceRunState(state, { type: 'approval_expired', requestId: 3 } as never);

    const json = JSON.stringify(renderRunCard(state));
    expect(json).not.toContain('等待审批');
    expect(json).toContain('调用工具');
  });

  it('test_anchor_resolved_approval_restores_tool_running_title', () => {
    // 用户已处理审批：标题恢复「调用工具」，不再停留在「等待审批」。
    let state = createInitialRunState('run-approval-resolved-title');
    state = reduceRunState(state, {
      type: 'turn_diff',
      toolOutput: 'npm view lark-remote version',
      itemId: 'item-c1',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-14T00:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 4,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-c1',
      view: {
        requestId: 4,
        kind: 'command',
        command: 'npm view lark-remote version',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    state = reduceRunState(state, {
      type: 'approval_resolved',
      requestId: 4,
      outcome: 'resolved',
    } as never);

    const json = JSON.stringify(renderRunCard(state));
    expect(json).not.toContain('等待审批');
    expect(json).toContain('调用工具');
  });

  it('test_anchor_terminal_state_takes_precedence_over_pending_approval_title', () => {
    // 终态优先：即使审批仍 pending，interrupted 终态标题必须显示「已中断」。
    let state = createInitialRunState('run-approval-terminal-prec');
    state = reduceRunState(state, {
      type: 'turn_diff',
      toolOutput: 'npm view lark-remote version',
      itemId: 'item-c1',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-14T00:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 5,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-c1',
      view: {
        requestId: 5,
        kind: 'command',
        command: 'npm view lark-remote version',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    const interrupted = finishRun(state, 'interrupted');

    const json = JSON.stringify(renderRunCard(interrupted));
    expect(json).toContain('已中断');
    expect(json).not.toContain('等待审批');
  });

  it('test_anchor_file_approval_renders_change_details_with_diff', () => {
    // 验证行为：文件变更审批区域必须渲染真实变更详情——路径 + diff 内容。
    // 缺失后果：用户只看到「📄 文件变更审批」标题，无法判断将改动什么文件、
    // 改动什么内容（线上真实协议下 grantRoot/reason 为 null，diff 来自
    // item/started 的 changes[]）。
    // 依据：真实 codex app-server 抓包 + 用户报告。
    let state = createInitialRunState('run-approval-file');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 43,
      kind: 'file',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 43,
        kind: 'file',
        fileChanges: [
          {
            path: '/home/user/project/a.txt',
            kind: 'update',
            diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
          },
        ],
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('文件变更审批');
    expect(serialized).toContain('/home/user/project/a.txt');
    expect(serialized).toContain('+hello');
    // 200861 铁律：禁止 tag:"action" 容器
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_file_approval_diff_budget_omits_overflow', () => {
    // 验证行为：文件审批区对 diff 总量设预算（避免多文件大 diff 把卡片顶爆
    // 28KB——估算函数不计审批区，这是既有缺口）；超预算的 diff 显示省略提示。
    // 缺失后果：多个大 diff 同时渲染时卡片超限被飞书拒绝（ErrCode 11310）。
    // 依据：run-card 28KB 预算红线 + tool-render OUTPUT_MAX/BODY_TOTAL_MAX 先例。
    let state = createInitialRunState('run-approval-budget');
    const bigDiff = 'a'.repeat(1500);
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 44,
      kind: 'file',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 44,
        kind: 'file',
        fileChanges: [
          { path: '/home/user/project/a.ts', kind: 'update', diff: bigDiff },
          { path: '/home/user/project/b.ts', kind: 'update', diff: bigDiff },
          { path: '/home/user/project/c.ts', kind: 'update', diff: bigDiff },
        ],
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('/home/user/project/a.ts');
    expect(serialized).toMatch(/diff 已省略/);
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_approval_view_updated_rerenders_changes', () => {
    // 验证行为：乱序流下审批先出空卡，approval_view_updated 到达后卡片必须
    // 原地补全文件与 diff。
    // 缺失后果：item/started 晚到时卡片永远空白，用户无法判断将改动什么。
    // 依据：真实协议 item/started 与审批顺序不保证（审批先到变体）。
    let state = createInitialRunState('run-approval-update');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 50,
      kind: 'file',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 50,
        kind: 'file',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    expect(JSON.stringify(renderRunCard(state))).not.toContain('/home/user/project/a.txt');

    state = reduceRunState(state, {
      type: 'approval_view_updated',
      requestId: 50,
      view: {
        requestId: 50,
        kind: 'file',
        fileChanges: [
          {
            path: '/home/user/project/a.txt',
            kind: 'update',
            diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
          },
        ],
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);
    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('/home/user/project/a.txt');
    expect(serialized).toContain('+hello');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_command_approval_renders_protocol_decision_buttons', () => {
    // 验证行为：命令审批按真实 availableDecisions 渲染按钮——acceptForSession
    // （允许本次会话）与 acceptWithExecpolicyAmendment（允许并记住命令）仅在
    // 协议列出时出现；拒绝按钮始终存在（安全兜底）。
    // 缺失后果：硬编码按钮只给允许/拒绝，服务端列出的持久化决策无法表达。
    // 依据：codex app-server 抓包 availableDecisions 形状。
    let state = createInitialRunState('run-approval-btns');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 51,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 51,
        kind: 'command',
        command: 'rm -rf /tmp/test',
        commandCwd: '/home/user/project',
        availableDecisions: [
          'accept',
          'acceptForSession',
          'acceptWithExecpolicyAmendment',
          'cancel',
        ],
      },
    } as never);

    const serialized = JSON.stringify(renderRunCard(state));
    expect(serialized).toContain('acceptForSession');
    expect(serialized).toContain('acceptWithExecpolicyAmendment');
    expect(serialized).toContain('"decision":"decline"');
    // 200861 铁律
    expect(serialized).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_running_card_is_v2_and_stop_is_bound_to_run', () => {
    const card = renderRunCard(createInitialRunState('run-7')) as {
      schema?: string;
      config: Record<string, unknown>;
      body?: { elements?: Array<Record<string, unknown>> };
    };

    // CardKit 2.0: schema is '2.0', stop uses behaviors callback
    expect(card.schema).toBe('2.0');
    const json = JSON.stringify(card);
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"run-7"');
    // New session button is always present
    expect(json).toContain('"cmd":"new-session"');
  });

  it('test_anchor_terminal_card_has_no_running_controls_and_fits_utf8_budget', () => {
    let state = createInitialRunState('run-8');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '中😀'.repeat(20_000) }] },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });
    const card = renderRunCard(state) as {
      body?: { elements?: Array<{ tag: string }> };
    };

    // 2.0: no stop button in terminal state
    const json = JSON.stringify(card);
    expect(json).not.toContain('"cmd":"stop"');
    // New session button is always present, even in terminal state
    expect(json).toContain('"cmd":"new-session"');
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThan(30_000);
  });

  it('test_anchor_tool_collapse_running_vs_terminal_behavior', () => {
    // Running state with 4 tools: each tool is independent (new design)
    // All 4 tools shown individually, with the last one expanded
    let state = createInitialRunState('run-tools');
    for (let index = 0; index < 4; index++) {
      state = reduceRunState(state, {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `tool-${index}`,
              name: `Tool${index}`,
              input: {},
            },
          ],
        },
      });
    }
    const runningJson = JSON.stringify(renderRunCard(state));
    // Each tool is independent - all 4 shown individually
    expect(runningJson).toContain('Tool0');
    expect(runningJson).toContain('Tool1');
    expect(runningJson).toContain('Tool2');
    expect(runningJson).toContain('Tool3');
    // Collapsed format is not used
    expect(runningJson).not.toContain('个工具调用（已折叠）');

    // Terminal states: all tools shown individually (not collapsed)
    const expected = {
      done: '已完成',
      error: '出错',
      interrupted: '已中断',
      idle_timeout: '已超时',
    } as const;
    for (const [terminal, title] of Object.entries(expected)) {
      const terminalState = finishRun(
        createInitialRunState(`run-${terminal}`),
        terminal as keyof typeof expected,
        terminal === 'error' ? { errorMsg: 'boom' } : {},
      );
      const serialized = JSON.stringify(renderRunCard(terminalState));
      expect(serialized).toContain(title);
      expect(serialized).not.toContain('"cmd":"stop"');
      expect(serialized).not.toContain('正在思考');
    }
  });

  // RED (Round 2): All block types must have timestamp in panel header (parentheses)
  it('test_anchor_all_block_types_timestamp_in_panel_header', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-all-ts');
      // Thinking block
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:00:00.000Z',
        message: { content: [{ type: 'thinking', thinking: '思考内容' }] },
      });
      // Tool block
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:01:00.000Z',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      });
      // Tool result
      state = reduceRunState(state, {
        type: 'user',
        timestamp: '2026-07-19T10:02:00.000Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      });
      // Text block
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '输出内容' }] },
      });

      const serialized = JSON.stringify(renderRunCard(state));

      // All block timestamps must be in panel header right side (parentheses)
      // Thinking: `💭 **思考完成** (2026-07-19 18:00)`
      expect(serialized).toMatch(/💭 \*\*思考完成\*\* \(2026-07-19 18:00\)/);
      // Tool: `✅ **Bash** — ls (2026-07-19 18:02)` - shows completion time (tool result timestamp)
      expect(serialized).toMatch(/✅ \*\*Bash\*\* — ls \(2026-07-19 18:02\)/);
      // Text: `💬 **输出** (2026-07-19 18:03)`
      expect(serialized).toMatch(/💬 \*\*输出\*\* \(2026-07-19 18:03\)/);
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  // RED (Round 1): text block timestamp must be in panel header `💬 **输出** (ts)`,
  // not in content body as `_ts_\n\ncontent`
  it('test_anchor_text_block_timestamp_in_panel_header', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-text-ts');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '完成了' }] },
      });

      const serialized = JSON.stringify(renderRunCard(state));
      // Text block must have panel header with timestamp in parentheses
      expect(serialized).toContain('💬 **输出** (2026-07-19 18:03)');
      // Old format `_ts_` in body must NOT appear for text blocks
      expect(serialized).not.toContain('_2026-07-19 18:03_');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  it('renders local timestamps for thinking, response, and tools', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-timestamps');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-06-20T10:00:00.000Z',
        message: { content: [{ type: 'thinking', thinking: '分析问题' }] },
      });
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-06-20T10:01:00.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      });
      state = reduceRunState(state, {
        type: 'user',
        timestamp: '2026-06-20T10:02:00.000Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
        },
      });
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-06-20T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '完成了' }] },
      });

      const serialized = JSON.stringify(renderRunCard(state));
      // Thinking timestamp in panel header (right side)
      expect(serialized).toContain('思考完成** (2026-06-20 18:00)');
      // Tool timestamp in panel header
      expect(serialized).toContain('Read');
      expect(serialized).toContain('2026-06-20 18:02');
      // Text block timestamp is in panel header format (not `_ts_` in body)
      expect(serialized).toContain('💬 **输出** (2026-06-20 18:03)');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  it('interleaves thinking blocks with text and tools in time order', () => {
    // Build state: thinking → text → thinking → tool → text
    let state = createInitialRunState('run-interleave');
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:00:00.000Z',
      message: { content: [{ type: 'thinking', thinking: '第一轮思考' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:01:00.000Z',
      message: { content: [{ type: 'text', text: '第一段文本' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:02:00.000Z',
      message: { content: [{ type: 'thinking', thinking: '第二轮思考' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:03:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:04:00.000Z',
      message: { content: [{ type: 'text', text: '第二段文本' }] },
    });

    const card = renderRunCard(state) as { body?: { elements?: object[] } };
    const elements = card.body?.elements ?? [];

    // Get content that includes our test strings
    const allJson = JSON.stringify(elements);

    // Should contain all our test content markers
    expect(allJson).toContain('第一轮思考');
    expect(allJson).toContain('第一段文本');
    expect(allJson).toContain('第二轮思考');
    expect(allJson).toContain('Read');
    expect(allJson).toContain('第二段文本');
  });

  it('respects showThinking false by filtering thinking from interleaved output', () => {
    let state = createInitialRunState('run-no-thinking');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hidden' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'visible text' }] },
    });

    const card = renderRunCard(state, { showThinking: false }) as { elements: object[] };
    const serialized = JSON.stringify(card);

    expect(serialized).not.toContain('hidden');
    expect(serialized).toContain('visible text');
  });

  it('test_probe_token_stats_use_K_units', () => {
    // Test that done state renders token stats in K units (e.g., 120K instead of 120,000)
    let state = createInitialRunState('run-token');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 120000,
      compactCount: 2,
      cacheReadTokens: 80000,
      cacheCreationTokens: 20000,
    });
    const card = renderRunCard(state) as {
      body?: { elements?: Array<{ text?: { content?: string } }> };
    };
    const json = JSON.stringify(card);

    // Context length should be in K units
    expect(json).toContain('120K');
    expect(json).not.toContain('120,000');
    // Compact count in new format
    expect(json).toContain('Compact - 2次');
    // Token stats should use K units
    // Input = contextLength + cacheRead = 120K + 80K = 200K
    expect(json).toContain('Input token - 200K');
    // Output estimate = 10% of contextLength = 12K
    expect(json).toContain('Output token - 12K');
    // Cache percentage = 80000 / (120000 + 80000) = 40%
    expect(json).toContain('Cached token - 80K (40%)');
  });

  it('test_anchor_done_card_uses_real_input_output_tokens_when_present', () => {
    // Bug: codex run card showed "Output token - 2K" (10% estimate of
    // contextLength) instead of the real output_tokens. When the
    // run state carries real inputTokens/outputTokens (threaded from the
    // codex ResultEvent.usage), the done card MUST render the real values.
    let state = createInitialRunState('run-codex-real');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 20000,
      inputTokens: 18000,
      outputTokens: 200,
      cacheReadTokens: 8000,
    });
    const card = renderRunCard(state) as {
      body?: { elements?: Array<{ text?: { content?: string } }> };
    };
    const json = JSON.stringify(card);

    // Real output (200), NOT the 10% estimate from contextLength.
    expect(json).toContain('Output token - 200');
    expect(json).not.toMatch(/Output token - \d+K/);
    // Real input (18000 → "18K"), NOT contextLength+cache (28000 → "28K").
    expect(json).toContain('Input token - 18K');
    expect(json).not.toContain('Input token - 28K');
    // Unified ccusage cache% = cacheRead / (input + cacheRead)
    // = 8000 / (18000 + 8000) = 30.8% ≈ 31%.
    expect(json).toContain('Cached token - 8K (31%)');
  });

  it('test_anchor_done_card_threads_cache_creation_and_total_tokens', () => {
    // cacheCreationTokens must reach formatUsageStats (renders "Cache create"),
    // and totalTokens must be threaded so the done card uses max(total, sum)
    // (folds extra such as opencode reasoning). Here sum4 = 240+3+0+100 = 343
    // but totalTokens = 393, so Total must be 393 (not 343).
    let state = createInitialRunState('run-extras');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      inputTokens: 240,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 100,
      totalTokens: 393,
    });
    const json = JSON.stringify(renderRunCard(state));
    expect(json).toContain('Cache create - 100');
    expect(json).toContain('Total token - 393');
  });

  it('test_anchor_done_card_threads_cumulative_input_output', () => {
    // Session-cumulative total/input/output (read from jsonl, threaded via FinishMeta
    // -> RunState -> formatUsageStats) must render as "· 累计 X" on the
    // Total/Input/Output lines. Per-turn values stay as-is; cache line must
    // NOT carry a cumulative suffix.
    let state = createInitialRunState('run-cum');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 31235,
      inputTokens: 677,
      outputTokens: 376,
      cacheReadTokens: 30182,
      cacheCreationTokens: 0,
      totalTokens: 31235,
      cumulativeTotalTokens: 50000,
      cumulativeInputTokens: 46630,
      cumulativeOutputTokens: 3319,
    });
    const json = JSON.stringify(renderRunCard(state));
    // Per-turn unchanged.
    expect(json).toContain('Input token - 677');
    expect(json).toContain('Output token - 376');
    // Cumulative appended (50000 -> 50K, 46630 -> 47K, 3319 -> 3K).
    expect(json).toContain('累计 50K');
    expect(json).toContain('累计 47K');
    expect(json).toContain('累计 3K');
    // Cache line: verify format without 累计 suffix.
    expect(json).toContain('Cached token - 30K (98%)');
  });

  it('done 卡：Cached 与 Cache create 行带 session 累计后缀', () => {
    // renderRunCard 必须把 state.cumulativeCacheReadTokens /
    // cumulativeCacheCreationTokens 透传给 formatUsageStats，否则 Cached /
    // Cache create 行不带 "· 累计 X"。bridge 已把这两个字段塞进 finishRun meta，
    // 缺口仅在渲染器（usage 对象漏传 cumulativeCacheRead/Creation）。
    let state = createInitialRunState('run-cache-cum');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 31235,
      inputTokens: 677,
      outputTokens: 376,
      cacheReadTokens: 30182,
      cacheCreationTokens: 2000,
      totalTokens: 31235,
      cumulativeInputTokens: 5100,
      cumulativeCacheReadTokens: 10000,
      cumulativeCacheCreationTokens: 2500,
    });
    const json = JSON.stringify(renderRunCard(state));
    // Cached 行：累计命中量 + 累计命中率
    // （cumCacheRead / (cumInput + cumCacheRead) = 10000 / (5100+10000) ≈ 66%）
    expect(json).toContain('Cached token - 30K (98%) · 累计 10K (66%)');
    // Cache create 行：累计创建量（2500 -> 3K）
    expect(json).toContain('Cache create - 2K · 累计 3K');
  });

  it('renders app-server turn_diff streaming snapshots (text/reasoning/plan/tool/file)', () => {
    let state = createInitialRunState('run-appserver-stream');
    // turn_started 记录操作类型
    state = reduceRunState(state, {
      type: 'turn_started',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      operationKind: 'turn',
    } as never);
    expect(state.operationKind).toBe('turn');

    // 推理快照（替换语义，不重复追加）
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'thinking…',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'thinking…more',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    } as never);
    expect(state.blocks.filter((b) => b.kind === 'thinking')).toHaveLength(1);
    const thinkingBlock = state.blocks.find((b) => b.kind === 'thinking');
    expect(thinkingBlock?.kind === 'thinking' ? thinkingBlock.itemId : undefined).toBe('item-r1');
    expect(thinkingBlock?.kind === 'thinking' ? thinkingBlock.timestamp : undefined).toBe(
      '2026-08-12T10:00:00.000Z',
    );

    // 文本快照（替换语义）
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-1',
      text: 'Hello, ',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:02:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-1',
      text: 'Hello, world!',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:03:00.000Z',
    } as never);
    const textBlocks = state.blocks.filter((b) => b.kind === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].content).toBe('Hello, world!');
    expect(textBlocks[0].timestamp).toBe('2026-08-12T10:02:00.000Z');

    // 工具输出快照（固定 tool block，替换语义）
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: 'out1',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:04:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: 'out1out2',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:05:00.000Z',
    } as never);
    const toolBlocks = state.blocks.filter((b) => b.kind === 'tool');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0].tool.output).toBe('out1out2');
    expect(toolBlocks[0].tool.startedAt).toBe('2026-08-12T10:04:00.000Z');

    // plan 快照（替换语义）
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-p1',
      plan: 'Step 1\nStep 2',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:06:00.000Z',
    } as never);
    expect(state.plan).toBe('Step 1\nStep 2');

    // 文件变更快照（替换语义）
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-f1',
      fileChanges: [{ path: '/home/user/project/a.txt', kind: 'update', diff: '@@ +1\n+hi' }],
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:07:00.000Z',
    } as never);
    const fileBlocks = state.blocks.filter((b) => b.kind === 'file_change');
    expect(fileBlocks).toHaveLength(1);
    expect(fileBlocks[0].path).toBe('/home/user/project/a.txt');
    expect(fileBlocks[0].timestamp).toBe('2026-08-12T10:07:00.000Z');

    const json = JSON.stringify(renderRunCard(state));
    expect(json).toContain('thinking…more');
    expect(json).toContain('Hello, world!');
    expect(json).toContain('Step 1');
    expect(json).toContain('/home/user/project/a.txt');
  });

  it('renders app-server interleaved items in real chronology (thinking→text→thinking→command→text)', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-interleave');
      const reduce = (e: unknown) => {
        state = reduceRunState(state, e as never);
      };

      // reasoning item 1 流式（首个块）
      reduce({
        type: 'turn_diff',
        itemId: 'item-r1',
        reasoning: 'first thought',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        timestamp: '2026-08-12T10:00:00.000Z',
      });
      // agentMessage item 1 流式（文本到达，旧思考折叠）
      reduce({
        type: 'turn_diff',
        itemId: 'item-1',
        text: 'Hello, world!',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        timestamp: '2026-08-12T10:01:00.000Z',
      });
      // reasoning item 2 交错开始（必须出现在底部，而不是钉在顶部）
      reduce({
        type: 'turn_diff',
        itemId: 'item-r2',
        reasoning: 'wait, rethink…',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        timestamp: '2026-08-12T10:02:00.000Z',
      });

      // 流式中的新思考必须在底部（index 2）且 active
      expect(state.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'thinking']);
      const streamingThinking = state.blocks[2];
      expect(streamingThinking.kind === 'thinking' ? streamingThinking.itemId : undefined).toBe(
        'item-r2',
      );
      expect(streamingThinking.kind === 'thinking' ? streamingThinking.active : undefined).toBe(
        true,
      );

      // command item：started 锚点 + 输出 delta
      reduce({
        type: 'turn_diff',
        itemId: 'item-c1',
        toolOutput: '',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        timestamp: '2026-08-12T10:03:00.000Z',
      });
      reduce({
        type: 'turn_diff',
        itemId: 'item-c1',
        toolOutput: ' M src/a.ts',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        timestamp: '2026-08-12T10:04:00.000Z',
      });
      // 第二个 agentMessage
      reduce({
        type: 'turn_diff',
        itemId: 'item-2',
        text: 'Done.',
        threadId: 'th-aaa-111',
        turnId: 'tn-111',
        timestamp: '2026-08-12T10:05:00.000Z',
      });

      // 真实时序：块顺序必须与事件到达顺序一致，流式中的思考在底部
      expect(state.blocks.map((b) => b.kind)).toEqual([
        'thinking',
        'text',
        'thinking',
        'tool',
        'text',
      ]);
      const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
      expect(thinkingBlocks).toHaveLength(2);
      expect(thinkingBlocks[0].itemId).toBe('item-r1');
      expect(thinkingBlocks[0].active).toBe(false);
      expect(thinkingBlocks[1].itemId).toBe('item-r2');
      // 最终文本到达后思考折叠；流式期间的 active 状态在上面的中间断言
      expect(thinkingBlocks[1].active).toBe(false);
      const toolBlocks = state.blocks.filter((b) => b.kind === 'tool');
      expect(toolBlocks[0].tool.id).toBe('item-c1');
      expect(toolBlocks[0].tool.output).toBe(' M src/a.ts');

      const json = JSON.stringify(renderRunCard(state));
      // 问题一回归：所有内容组件都有时间标记
      expect(json).toContain('思考完成** (2026-08-12 18:02)');
      expect(json).toContain('💬 **输出** (2026-08-12 18:01)');
      // 流式中的 command 块：标题取 startedAt（18:03）
      expect(json).toContain('**command** (2026-08-12 18:03)');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  it('app-server authoritative completion replaces the item block in place and stamps timestamps', () => {
    let state = createInitialRunState('run-authority');
    // 流式草稿
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'streamed draft',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    } as never);
    // item/completed 权威内容：原地替换、置 inactive、打 completedAt
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'final authoritative',
      complete: true,
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    } as never);

    const thinking = state.blocks[0];
    expect(thinking.kind).toBe('thinking');
    expect(state.blocks).toHaveLength(1);
    if (thinking.kind === 'thinking') {
      expect(thinking.content).toBe('final authoritative');
      expect(thinking.active).toBe(false);
      expect(thinking.timestamp).toBe('2026-08-12T10:00:00.000Z');
      expect(thinking.completedAt).toBe('2026-08-12T10:01:00.000Z');
    }

    // 工具同理：started → delta → completed（状态 ok + completedAt）
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: 'partial',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:02:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: 'aggregated output',
      complete: true,
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:03:00.000Z',
    } as never);
    const tool = state.blocks.find((b) => b.kind === 'tool');
    expect(tool?.kind === 'tool' ? tool.tool.status : undefined).toBe('ok');
    expect(tool?.kind === 'tool' ? tool.tool.completedAt : undefined).toBe(
      '2026-08-12T10:03:00.000Z',
    );
    expect(tool?.kind === 'tool' ? tool.tool.startedAt : undefined).toBe(
      '2026-08-12T10:02:00.000Z',
    );
  });

  it('moves a same-item streaming update to the bottom when later items were appended (protocol-violation fallback)', () => {
    let state = createInitialRunState('run-continuation');
    const reduce = (e: unknown) => {
      state = reduceRunState(state, e as never);
    };
    // 正常：reasoning item-r1 流式
    reduce({
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'first thought',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    });
    // 文本 item 追加
    reduce({
      type: 'turn_diff',
      itemId: 'item-1',
      text: 'Hello, world!',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    });
    // 同一 reasoning item 继续收到 delta（违反 item 生命周期）：
    // 流式更新必须出现在卡片底部，而不是钉在顶部刷新
    reduce({
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'first thought + more',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:02:00.000Z',
    });

    expect(state.blocks.map((b) => b.kind)).toEqual(['text', 'thinking']);
    const thinking = state.blocks[1];
    expect(thinking.kind === 'thinking' ? thinking.content : undefined).toBe(
      'first thought + more',
    );
    expect(thinking.kind === 'thinking' ? thinking.active : undefined).toBe(true);
    // 权威完成不移动位置：块已在末尾，原地收尾
    reduce({
      type: 'turn_diff',
      itemId: 'item-r1',
      reasoning: 'first thought + more',
      complete: true,
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:03:00.000Z',
    });
    expect(state.blocks.map((b) => b.kind)).toEqual(['text', 'thinking']);
  });

  it('keeps multiple command items as separate tool blocks', () => {
    let state = createInitialRunState('run-two-tools');
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: 'out one',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c2',
      toolOutput: 'out two',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    } as never);
    const tools = state.blocks.filter((b) => b.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0].kind === 'tool' ? tools[0].tool.id : undefined).toBe('item-c1');
    expect(tools[1].kind === 'tool' ? tools[1].tool.id : undefined).toBe('item-c2');
  });

  it('isolates fileChange items per item (two items → two blocks)', () => {
    let state = createInitialRunState('run-two-files');
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-f1',
      fileChanges: [{ path: '/home/user/project/a.txt', kind: 'update', diff: '+a' }],
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-f2',
      fileChanges: [{ path: '/home/user/project/b.txt', kind: 'update', diff: '+b' }],
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    } as never);
    const files = state.blocks.filter((b) => b.kind === 'file_change');
    expect(files).toHaveLength(2);
    expect(files[0].kind === 'file_change' ? files[0].itemId : undefined).toBe('item-f1');
    expect(files[1].kind === 'file_change' ? files[1].itemId : undefined).toBe('item-f2');
  });

  it('corrects plan content with turn/completed authority in place', () => {
    let state = createInitialRunState('run-plan-authority');
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-p1',
      plan: 'Step 1 draft',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-p1',
      plan: 'Step 1\nStep 2 final',
      complete: true,
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    } as never);
    const plans = state.blocks.filter((b) => b.kind === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0].kind === 'plan' ? plans[0].content : undefined).toBe('Step 1\nStep 2 final');
    expect(plans[0].kind === 'plan' ? plans[0].active : undefined).toBe(false);
    expect(plans[0].kind === 'plan' ? plans[0].completedAt : undefined).toBe(
      '2026-08-12T10:01:00.000Z',
    );
  });

  it('marks failed commands as tool error status on authoritative completion', () => {
    let state = createInitialRunState('run-tool-error');
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: '',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:00:00.000Z',
    } as never);
    state = reduceRunState(state, {
      type: 'turn_diff',
      itemId: 'item-c1',
      toolOutput: 'partial output',
      complete: true,
      toolStatus: 'error',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      timestamp: '2026-08-12T10:01:00.000Z',
    } as never);
    const tool = state.blocks.find((b) => b.kind === 'tool');
    expect(tool?.kind === 'tool' ? tool.tool.status : undefined).toBe('error');
    expect(tool?.kind === 'tool' ? tool.tool.completedAt : undefined).toBe(
      '2026-08-12T10:01:00.000Z',
    );
  });

  it('hides the approval area once the run is terminal (coordinator already released)', () => {
    let state = createInitialRunState('run-approval-terminal');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 42,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 42,
        kind: 'command',
        command: 'ls -la',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    } as never);

    const running = JSON.stringify(renderRunCard(state));
    expect(running).toContain('命令审批');

    state = finishRun(state, 'done');
    const done = JSON.stringify(renderRunCard(state));
    expect(done).not.toContain('命令审批');
    expect(done).not.toContain('approval.respond');
  });
});

// CardKit 2.0 renderer — renderRunCard coverage (2.0 path
// is the production default for streaming run cards).
describe('renderRunCard (CardKit 2.0)', () => {
  type Card2 = {
    schema?: string;
    body?: {
      elements?: Array<
        { tag?: string; tabs?: Array<{ id?: string; label?: string }> } & Record<string, unknown>
      >;
    };
  };

  function render2(state: ReturnType<typeof createInitialRunState>): Card2 {
    return renderRunCard(state) as Card2;
  }

  it('produces schema 2.0 with inline content (no tabs for streaming) and no 1.x action container (regression: 200861)', () => {
    const card = render2(createInitialRunState('run-2-001'));
    const json = JSON.stringify(card);
    expect(card.schema).toBe('2.0');
    // No tabs in streaming mode - content is inline
    expect(card.body?.elements?.find((e) => e.tag === 'tabs')).toBeUndefined();
    // 200861 铁律：2.0 卡片禁止混入 1.x `tag:"action"` 容器
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('running card has stop button with 2.0 behaviors bound to runId', () => {
    const card = render2(createInitialRunState('run-2-stop'));
    const json = JSON.stringify(card);
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"run-2-stop"');
    expect(json).toContain('"type":"callback"');
  });

  it('terminal (done) card has no stop button but has new-session button', () => {
    const state = finishRun(createInitialRunState('run-2-done'), 'done', {
      resultSubtype: 'success',
    });
    const card = render2(state);
    const json = JSON.stringify(card);
    expect(json).not.toContain('"cmd":"stop"');
    // New session button is always present
    expect(json).toContain('"cmd":"new-session"');
    // Status text uses div + lark_md (not 1.x tag component which is unsupported in 2.0)
    expect(json).toContain('"tag":"div"');
    expect(json).toContain('已完成');
  });

  it('compact button shows on every terminal state for a normal turn (incl. abnormal exits)', () => {
    const terminals = ['done', 'error', 'interrupted', 'idle_timeout'] as const;
    for (const terminal of terminals) {
      let state = createInitialRunState('run-compact-terminal');
      state = reduceRunState(state, {
        type: 'turn_started',
        threadId: 'th-aaa-1',
        turnId: 'tn-1',
        operationKind: 'turn',
      } as never);
      state = finishRun(state, terminal, {
        resultSubtype: terminal === 'error' ? 'error' : 'success',
        errorMsg: terminal === 'error' ? 'boom' : undefined,
      });
      const json = JSON.stringify(renderRunCard(state));
      expect(json).toContain('"cmd":"codex.compact"');
      expect(json).toContain('"cmd":"new-session"');
    }
  });

  it('done + error subtype still shows compact button (approval-cancelled run)', () => {
    let state = createInitialRunState('run-done-error');
    state = reduceRunState(state, {
      type: 'turn_started',
      threadId: 'th-aaa-1',
      turnId: 'tn-1',
      operationKind: 'turn',
    } as never);
    state = finishRun(state, 'done', { resultSubtype: 'error' });
    const json = JSON.stringify(renderRunCard(state));
    expect(json).toContain('"cmd":"codex.compact"');
  });

  it('compaction card never shows compact button (no recursive compact)', () => {
    let state = createInitialRunState('run-compaction');
    state = reduceRunState(state, {
      type: 'turn_started',
      threadId: 'th-aaa-1',
      turnId: 'tn-1',
      operationKind: 'compaction',
    } as never);
    state = finishRun(state, 'done', { resultSubtype: 'success' });
    const json = JSON.stringify(renderRunCard(state));
    expect(json).not.toContain('"cmd":"codex.compact"');
  });

  it('claude stream-json run (no turn_started) shows compact button on terminal state', () => {
    // claude 走 stream-json，从不发射 turn_started → operationKind 恒 undefined。
    // 回归：2026-08-19 缺陷——shouldShowCompactButton 以 operationKind==='turn'
    // 作门控，claude 终态卡永远拿不到 Compact 按钮（只有 resume 卡有）。能力
    // 门控改为 compactSupported 后，bridge 传 runner 有 runCompact → 按钮出现。
    let state = createInitialRunState('run-claude-compact');
    state = finishRun(state, 'done', { resultSubtype: 'success' });
    expect(state.operationKind).toBeUndefined();
    const json = JSON.stringify(renderRunCard(state, { compactSupported: true }));
    expect(json).toContain('"cmd":"codex.compact"');
    expect(json).toContain('"cmd":"new-session"');
  });

  it('claude run card hides compact button when runner lacks runCompact', () => {
    let state = createInitialRunState('run-claude-no-cap');
    state = finishRun(state, 'done', { resultSubtype: 'success' });
    const json = JSON.stringify(renderRunCard(state, { compactSupported: false }));
    expect(json).not.toContain('"cmd":"codex.compact"');
    expect(json).toContain('"cmd":"new-session"');
  });

  it('running turn has no compact button yet', () => {
    let state = createInitialRunState('run-running');
    state = reduceRunState(state, {
      type: 'turn_started',
      threadId: 'th-aaa-1',
      turnId: 'tn-1',
      operationKind: 'turn',
    } as never);
    const json = JSON.stringify(renderRunCard(state));
    expect(json).not.toContain('"cmd":"codex.compact"');
  });

  it('compact card shows post-compact context, pre-compact watermark and compact count', () => {
    let state = createInitialRunState('run-compact-stats');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 4777,
      compactPreContextLength: 20430,
      compactCount: 1,
    });
    const json = JSON.stringify(renderRunCard(state));
    // formatTokenK rounds to nearest K: 4777 -> 5K, 20430 -> 20K
    expect(json).toContain('Context - 5K（压缩前 20K）');
    expect(json).toContain('Compact - 1次');
  });

  it('header title is agent-aware via options.agentKind', () => {
    // Initial state has footer='thinking', so header shows "思考中"
    const state = createInitialRunState('run-agent');

    // Default: no agentKind → 'Claude'
    const defaultJson = JSON.stringify(renderRunCard(state));
    expect(defaultJson).toContain('Claude · 思考中');

    // Explicit claude
    const claudeJson = JSON.stringify(renderRunCard(state, { agentKind: 'claude' }));
    expect(claudeJson).toContain('Claude · 思考中');

    // Codex (renderer is already agent-aware)
    const codexJson = JSON.stringify(renderRunCard(state, { agentKind: 'codex' }));
    expect(codexJson).toContain('Codex · 思考中');
    expect(codexJson).not.toContain('Claude');

    // Opencode
    const opencodeJson = JSON.stringify(renderRunCard(state, { agentKind: 'opencode' }));
    expect(opencodeJson).toContain('Opencode · 思考中');

    // Terminal state uses different label
    const doneState = finishRun(state, 'done', { resultSubtype: 'success' });
    const doneJson = JSON.stringify(renderRunCard(doneState, { agentKind: 'codex' }));
    expect(doneJson).toContain('Codex · 已完成');
  });

  it('terminal done card displays compact count from state', () => {
    let state = createInitialRunState('run-compact');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      compactCount: 2,
    });
    const json = JSON.stringify(renderRunCard(state));
    expect(json).toMatch(/Compact\s+-\s+2次/);
  });

  it('result event transitions to finalizing (non-terminal) - stop button still shows', () => {
    // 进程退出是唯一终态触发源：result 事件只进入非终态 finalizing，
    // 停止按钮仍显示（showStop = running || finalizing）。
    // 缺失会让用户在进程仍存活（等后台任务）时丢失停止按钮。
    let state = createInitialRunState('run-2');
    state = reduceRunState(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'run-2',
    });
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'success',
      session_id: 'run-2',
      total_cost_usd: 0.01,
    });
    // 验证进入 finalizing 非终态（不是 done）
    expect(state.terminal).toBe('finalizing');

    // finalizing 仍显示停止按钮（进程未退出，用户可 /stop）
    const json = JSON.stringify(render2(state));
    expect(json).toContain('"cmd":"stop"');
  });

  it('does not duplicate tool calls in main content and tools section', () => {
    // Regression: CardKit 2.0 flat layout was rendering tools twice —
    // once as a markdown list ("**工具调用:**\n- ⏳ Agent\n- ✅ Bash -- …")
    // in buildMainContent, and again as collapsible panels in buildToolsContent.
    // In flat layout, buildToolsContent already renders all tools (with
    // collapse strategy), so buildMainContent must NOT emit tool summaries.
    let state = createInitialRunState('run-dup-tools');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '开始工作' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2', is_error: false },
        ],
      },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: false }],
      },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pwd' } }],
      },
    });

    const json = JSON.stringify(render2(state));

    // Tool names must appear (rendered by buildToolsContent)
    expect(json).toContain('Bash');
    expect(json).toContain('Read');

    // The duplicate markdown list header from buildMainContent must NOT appear
    expect(json).not.toContain('**工具调用:**');
  });

  it('does not duplicate tool calls in terminal state either', () => {
    // Same regression check for finalized (done) cards
    let state = createInitialRunState('run-dup-done');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '完成' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
      },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });

    const json = JSON.stringify(render2(state));
    expect(json).toContain('Bash');
    expect(json).not.toContain('**工具调用:**');
  });

  it('degrades thinking: keeps last 2 + omission hint when budget exceeded', () => {
    // Build a RunState directly (bypassing reduceRunState's internal truncation)
    // with enough content to trigger the 28KB budget exceeded fallback.
    // - 7 thinking blocks with large content
    // - 5 tool calls with large output
    // - Large text content
    const state = {
      runId: 'run-degrade-thinking',
      terminal: 'done' as const,
      footer: null,
      blocks: [] as RunBlock[],
      sessionId: 's1',
      resultSubtype: 'success' as const,
    };

    // Add 7 thinking blocks (exceeds the 2 that should be kept in degradation)
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-07-04T10:0${i}:00.000Z`,
      });
    }

    // Add 5 tool blocks with large output
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-d-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-07-04T10:10:00.000Z',
          completedAt: '2026-07-04T10:11:00.000Z',
        },
      });
    }

    // Add large text content that must be preserved in degradation
    state.blocks.push({
      kind: 'text',
      content: '这是重要的文本输出，必须完整保留。' + 'T'.repeat(8000),
      timestamp: '2026-07-04T10:30:00.000Z',
    });

    // Render the card (budget check happens inside)
    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Verify the card triggered budget exceeded (should be much smaller than 28KB)
    expect(cardBytes).toBeLessThan(28_000);

    // Test expectations for the degraded behavior (will fail in RED):
    // 1. Should contain the last 2 thinking blocks (思考6 and 思考7)
    expect(json).toContain('思考6');
    expect(json).toContain('思考7');

    // 2. Should NOT contain the earlier thinking blocks (思考1-思考5)
    expect(json).not.toContain('思考1');
    expect(json).not.toContain('思考2');
    expect(json).not.toContain('思考3');
    expect(json).not.toContain('思考4');
    expect(json).not.toContain('思考5');

    // 3. Should contain omission hint for early thinking
    expect(json).toMatch(/5 个早期思考已省略/);

    // 4. Text content must be preserved intact
    expect(json).toContain('这是重要的文本输出，必须完整保留。');

    // 5. Tools: last 3 tool panels preserved in degraded mode (new design)
    // The card should have the last 3 tool panels individually (chronologically)
    // Each tool is rendered as: ✅ **Bash** — cmdN (timestamp)
    expect(json).toContain('**Bash** — cmd2');
    expect(json).toContain('**Bash** — cmd3');
    expect(json).toContain('**Bash** — cmd4');
    // Should have omit hint for earlier tools (2 omitted: cmd0, cmd1)
    expect(json).toMatch(/另外 2 个工具调用已省略/);
    // Old one-line summary format should NOT appear
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // 6. CardKit 2.0 schema compliance — no V1 action container
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('extreme fallback: degrades further when even degraded card exceeds 28KB', () => {
    // Build a massive RunState that exceeds 28KB even after degraded rendering.
    // Degraded path: last 2 thinking (each truncated to REASONING_BYTES=4500) +
    // text (truncated to TEXT_BYTES=10000) + tool summary + summary.
    // Total degraded ≈ 9KB thinking + 10KB text + overhead ≈ 23KB — still fits.
    // To force extreme fallback, we add MULTIPLE large text blocks that each
    // survive as separate markdown divs after truncation.
    const state: RunState = {
      runId: 'run-extreme',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-extreme',
      resultSubtype: 'success',
    };

    // 20 thinking blocks with 5KB content each
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'X'.repeat(5000),
        active: false,
        timestamp: `2026-07-04T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    // 20 tool blocks with 5KB output each
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-ext-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'O'.repeat(5000),
          status: 'ok',
          startedAt: '2026-07-04T11:00:00.000Z',
          completedAt: '2026-07-04T11:01:00.000Z',
        },
      });
    }

    // Multiple text blocks interleaved with tools — groupBlocks merges consecutive
    // text, so we alternate with tool blocks to create many separate text groups.
    // Each text block will be individually truncated to TEXT_BYTES in buildMainContent.
    // 3 text blocks * ~10KB each = ~30KB text in degraded path = exceeds 28KB.
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '文本块' + (i + 1) + ':关键输出尾部信息必须保留' + 'T'.repeat(12000),
        timestamp: `2026-07-04T12:0${i}:00.000Z`,
      });
      // Insert a tool between text blocks to prevent groupBlocks merging them
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-sep-' + i,
          name: 'Write',
          input: { file_path: 'out' + i + '.txt' },
          output: 'written',
          status: 'ok',
          startedAt: '2026-07-04T12:10:00.000Z',
          completedAt: '2026-07-04T12:10:05.000Z',
        },
      });
    }
    // Final text block (no trailing tool)
    // Important: extreme fallback truncates TEXT to 5KB from END,
    // so we must put the critical content at the END, not the beginning.
    state.blocks.push({
      kind: 'text',
      content: 'F'.repeat(12000) + '最终关键输出尾部信息，截断后仍保留',
      timestamp: '2026-07-04T13:00:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Card must fit within 28KB budget (extreme fallback should ensure this)
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // Extreme fallback keeps only the last 1 thinking block
    expect(json).toContain('思考20');
    // Earlier thinking blocks are omitted (20 - 1 = 19 earlier blocks)
    expect(json).toMatch(/19 个早期思考已省略/);

    // Text is truncated to 5KB tail in extreme fallback, but the critical
    // tail content must survive in at least the last text block
    expect(json).toContain('最终关键输出尾部信息，截断后仍保留');

    // Extreme fallback: keeps last 1 tool panel chronologically
    // Since Write tools were added after Bash tools, Write is the last tool
    expect(json).toContain('Write');
    expect(json).toMatch(/另外 \d+ 个工具调用已省略/);
    // Old one-line summary should NOT appear
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // CardKit 2.0 schema compliance
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('budget boundary: complete rendering when card fits within 28KB', () => {
    // Build a small RunState that fits comfortably within 28KB
    // All thinking blocks and tool details should be preserved (no degradation)
    const state: RunState = {
      runId: 'run-small',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-small',
      resultSubtype: 'success',
    };

    // 2 small thinking blocks
    state.blocks.push({
      kind: 'thinking',
      content: '分析用户需求',
      active: false,
      timestamp: '2026-07-04T10:00:00.000Z',
    });
    state.blocks.push({
      kind: 'thinking',
      content: '设计解决方案',
      active: false,
      timestamp: '2026-07-04T10:01:00.000Z',
    });

    // 2 small tool calls
    state.blocks.push({
      kind: 'tool',
      tool: {
        id: 'tool-s-1',
        name: 'Read',
        input: { file_path: 'a.ts' },
        output: 'const x = 1;',
        status: 'ok',
        startedAt: '2026-07-04T10:02:00.000Z',
        completedAt: '2026-07-04T10:02:30.000Z',
      },
    });
    state.blocks.push({
      kind: 'tool',
      tool: {
        id: 'tool-s-2',
        name: 'Bash',
        input: { command: 'echo hello' },
        output: 'hello',
        status: 'ok',
        startedAt: '2026-07-04T10:03:00.000Z',
        completedAt: '2026-07-04T10:03:10.000Z',
      },
    });

    // Small text content
    state.blocks.push({
      kind: 'text',
      content: '这是正常的输出文本。',
      timestamp: '2026-07-04T10:04:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);

    // Both thinking blocks are preserved (not degraded)
    expect(json).toContain('分析用户需求');
    expect(json).toContain('设计解决方案');

    // No omission hint (all thinking shown)
    expect(json).not.toMatch(/\d+ 个早期思考已省略/);

    // Tool details are preserved (not just a one-line summary)
    expect(json).toContain('Read');
    expect(json).toContain('Bash');
    expect(json).toContain('const x = 1;');
    expect(json).toContain('hello');

    // No tool summary line (tools rendered individually, not as summary)
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // Text content preserved
    expect(json).toContain('这是正常的输出文本。');
  });

  it('compatibility: small cards are unaffected by degradation logic', () => {
    // Minimal state — just a running card with a single text block
    let state = createInitialRunState('run-compat');
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-07-04T10:00:00.000Z',
      message: { content: [{ type: 'text', text: 'Hello from Claude!' }] },
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);

    // Card is small — should be under 28KB without any degradation
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);

    // Content fully preserved
    expect(json).toContain('Hello from Claude!');

    // No degradation artifacts
    expect(json).not.toMatch(/\d+ 个早期思考已省略/);
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // Running state has stop button
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"run-compat"');

    // CardKit 2.0 schema compliance
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  // RED test: degraded card must still have new-session button
  it('degraded card has new-session button even when budget exceeded', () => {
    // Build a RunState that exceeds 28KB to trigger degraded rendering
    const state: RunState = {
      runId: 'run-degraded-buttons',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's1',
      resultSubtype: 'success',
    };

    // Add multiple large thinking blocks (triggers degraded path)
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-07-14T10:0${i}:00.000Z`,
      });
    }

    // Add large tool outputs
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-d-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-07-14T10:10:00.000Z',
          completedAt: '2026-07-14T10:11:00.000Z',
        },
      });
    }

    // Add large text content
    state.blocks.push({
      kind: 'text',
      content: '重要输出必须保留。' + 'T'.repeat(8000),
      timestamp: '2026-07-14T10:30:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Must be under budget after degradation
    expect(cardBytes).toBeLessThan(28_000);

    // Degraded path must preserve the new-session button
    expect(json).toContain('"cmd":"new-session"');
  });

  // RED test: extreme fallback card must still have new-session button
  it('extreme fallback card has new-session button even when budget exceeded', () => {
    // Build an even larger state to trigger extreme fallback
    const state: RunState = {
      runId: 'run-extreme-buttons',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-extreme',
      resultSubtype: 'success',
    };

    // 20 thinking blocks with 5KB each
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'X'.repeat(5000),
        active: false,
        timestamp: `2026-07-14T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    // Large text blocks
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '文本块' + (i + 1) + ':关键信息' + 'T'.repeat(12000),
        timestamp: `2026-07-14T12:0${i}:00.000Z`,
      });
    }

    state.blocks.push({
      kind: 'text',
      content: 'F'.repeat(12000) + '最终关键输出尾部信息',
      timestamp: '2026-07-14T13:00:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Must fit in budget
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // Extreme fallback must preserve new-session button
    expect(json).toContain('"cmd":"new-session"');
  });

  // =========================================================================
  // Text block: terminal state uses collapsible_panel (to protect tables from 11310)
  // =========================================================================
  describe('text block: terminal state uses collapsible_panel', () => {
    it('done state text block IS wrapped in collapsible_panel (to protect tables)', () => {
      // Output is wrapped in collapsible_panel (expanded) to protect markdown tables
      // from being counted toward 11310 limit (5 tables max per card).
      let state = createInitialRunState('run-text-unfold');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '这是重要输出' }] },
      });
      state = finishRun(state, 'done', { resultSubtype: 'success' });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const elements = card.body?.elements ?? [];
      const json = JSON.stringify(card);

      // Content must be visible
      expect(json).toContain('这是重要输出');

      // Find the element containing the text content - should be in collapsible_panel
      const textElement = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('这是重要输出'),
      );

      // Text MUST be inside a collapsible_panel in terminal state (to protect tables from 11310)
      expect(textElement).toBeDefined();
      expect((textElement as Record<string, unknown>)?.expanded).toBe(true);
    });

    it('done state text block uses notation font size inside panel', () => {
      let state = createInitialRunState('run-text-fontsize');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '正常字号输出' }] },
      });
      state = finishRun(state, 'done', { resultSubtype: 'success' });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };

      // Find the collapsible_panel containing the text
      const elements = card.body?.elements ?? [];
      const textPanel = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('正常字号输出'),
      );

      // Must exist inside collapsible_panel
      expect(textPanel).toBeDefined();

      // Inside panel, text uses notation size
      const panelElements = (textPanel as Record<string, unknown>)?.elements as Array<
        Record<string, unknown>
      >;
      const textDiv = panelElements?.find((el) => el.tag === 'div');
      const textObj = (textDiv as Record<string, unknown>)?.text as Record<string, unknown>;
      expect(textObj?.text_size).toBe('notation');
    });

    it('done state text block shows timestamp in panel header', () => {
      const oldTz = process.env.TZ;
      process.env.TZ = 'Asia/Shanghai';
      try {
        let state = createInitialRunState('run-text-ts-prefix');
        state = reduceRunState(state, {
          type: 'assistant',
          timestamp: '2026-07-19T10:03:00.000Z',
          message: { content: [{ type: 'text', text: '输出内容' }] },
        });
        state = finishRun(state, 'done', { resultSubtype: 'success' });

        const json = JSON.stringify(renderRunCard(state));

        // Timestamp should appear in panel header (not as content prefix)
        expect(json).toContain('💬 **输出** (2026-07-19 18:03)');
        // Old prefix format should NOT appear
        expect(json).not.toContain('_2026-07-19 18:03_');
      } finally {
        if (oldTz === undefined) delete process.env.TZ;
        else process.env.TZ = oldTz;
      }
    });

    it('running state text block still uses collapsible_panel with expanded=true', () => {
      let state = createInitialRunState('run-text-running');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '流式输出' }] },
      });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const elements = card.body?.elements ?? [];

      // Find the collapsible_panel containing the text
      const panelElement = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('流式输出'),
      );

      // Running state: text must be in a collapsible_panel
      expect(panelElement).toBeDefined();
      // And it must be expanded (visible)
      expect((panelElement as Record<string, unknown>)?.expanded).toBe(true);
    });

    it('GREEN: finalizing state text block also uses collapsible_panel (like done)', () => {
      // Finalizing: result received, process not yet exited. Output is complete, uses panel.
      let state = createInitialRunState('run-text-finalizing');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '等待退出' }] },
      });
      state = reduceRunState(state, {
        type: 'result',
        subtype: 'success',
        session_id: 'run-text-finalizing',
        total_cost_usd: 0.01,
      });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const elements = card.body?.elements ?? [];

      // finalizing state: text MUST be in a collapsible_panel (to protect tables)
      const textPanel = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('等待退出'),
      );
      expect(textPanel).toBeDefined();
      expect((textPanel as Record<string, unknown>)?.expanded).toBe(true);
    });

    it('degraded path also uses collapsible_panel in terminal state', () => {
      // Build a large state that triggers degraded rendering
      const state: RunState = {
        runId: 'run-degrade-text',
        terminal: 'done',
        footer: null,
        blocks: [],
        sessionId: 's-degrade',
        resultSubtype: 'success',
      };

      // Many thinking blocks to trigger budget exceeded
      for (let i = 0; i < 7; i++) {
        state.blocks.push({
          kind: 'thinking',
          content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
          active: false,
          timestamp: `2026-07-04T10:0${i}:00.000Z`,
        });
      }
      // Many tool blocks
      for (let i = 0; i < 5; i++) {
        state.blocks.push({
          kind: 'tool',
          tool: {
            id: 'tool-dt-' + i,
            name: 'Bash',
            input: { command: 'cmd' + i },
            output: 'o'.repeat(3500),
            status: 'ok',
            startedAt: '2026-07-04T10:10:00.000Z',
            completedAt: '2026-07-04T10:11:00.000Z',
          },
        });
      }
      // Text block
      state.blocks.push({
        kind: 'text',
        content: '重要输出必须可见',
        timestamp: '2026-07-04T10:30:00.000Z',
      });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const json = JSON.stringify(card);

      // Must fit in budget (degraded)
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);

      // Text content must be visible
      expect(json).toContain('重要输出必须可见');

      // Text MUST be in a collapsible_panel (to protect tables from 11310)
      const elements = card.body?.elements ?? [];
      const textPanel = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('重要输出必须可见'),
      );
      expect(textPanel).toBeDefined();
    });
  });
});
