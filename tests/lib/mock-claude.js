#!/usr/bin/env node
/**
 * Shared mock Claude CLI for runner/session tests.
 *
 * Emulates the stream-json interactive protocol (--input-format stream-json):
 * reads JSON lines from stdin, emits system/init, and per MOCK_SCENARIO:
 *
 * - plain:        user → assistant(text) → result(success)
 * - compact:      user("/compact") → assistant(压缩摘要) → result(success)
 * - approval:     user → assistant(tool_use Bash) → control_request(can_use_tool)
 *                 → (control_response) → user(tool_result) → assistant → result
 * - approval-exit-plan: user → control_request(can_use_tool, tool_name=ExitPlanMode,
 *                 input={}) → (control_response) → result
 * - question:     user → control_request(AskUserQuestion, input.questions)
 *                 → (control_response) → result
 * - hang:         init then never respond to user messages
 * - crash:        init then exit 7 with stderr noise
 * - no-stdout:    never emit stdout (heartbeat stall tests)
 * - stale-result: --resume path: emit stale result BEFORE init, then a fresh
 *                 init; user → assistant → result
 *
 * The process stays alive between turns (stdin kept open) and exits when
 * stdin closes or SIGTERM/SIGKILL arrives — mirrors the long-lived session.
 */

import readline from 'node:readline';
import fs from 'node:fs';

const scenario = process.env.MOCK_SCENARIO || 'plain';
const sessionId = process.env.MOCK_SESSION_ID || 's1';
const cwd = process.env.MOCK_CWD || '/tmp';
const recordStdin = process.env.MOCK_RECORD_STDIN;
const marker = process.env.MOCK_MARKER;
const approvalsPerTurn = Number(process.env.MOCK_APPROVALS || '1');

if (marker) {
  fs.appendFileSync(marker, `spawn ${process.pid}\n`);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function init() {
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd,
    model: 'opus',
  });
}

function result(subtype, extra) {
  emit({
    type: 'result',
    subtype,
    session_id: sessionId,
    result: 'ok',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...extra,
  });
}

const rl = readline.createInterface({ input: process.stdin });

if (scenario === 'no-stdout') {
  // Never emit anything; keep the process alive so spawn-stage heartbeat
  // tests can observe the stall window.
  rl.on('line', () => {});
  setInterval(() => {}, 1 << 30);
} else if (scenario === 'hang') {
  // init 后不回应用户消息（模拟 turn 挂起），保持进程存活供 stop/看门狗测试。
  init();
  rl.on('line', () => {});
} else if (scenario === 'crash') {
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd, model: 'opus' });
  // 等一条用户消息再崩（模拟 turn 中途进程崩溃），避免与 stdin 写入竞态。
  rl.on('line', () => {
    process.stderr.write('authentication failed\n');
    process.exit(7);
  });
} else if (scenario === 'stale-result') {
  // --resume replay: the previous turn's result arrives before init.
  result('success', { result: 'stale previous turn' });
  init();
  rl.on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'resumed reply' }] },
    });
    result('success', { result: 'resumed reply' });
  });
} else if (scenario === 'compact') {
  // /compact 是 CLI 本地 slash 命令：收到后跑压缩并输出摘要文本，turn 以
  // 普通 result 收尾（对齐真实 claude 2.1.233 stream-json 实测行为）。
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Conversation compacted' }] },
    });
    result('success', { result: 'compacted' });
  });
} else if (scenario === 'approval') {
  init();
  // 真实 claude 行为：一次只发一个 control_request，等响应后才继续下一个
  // 工具调用（不能一次把 N 个请求全发出来，否则「允许所有」的自动放行
  // 无法在第二个请求翻译前生效）。
  let current = 0;
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      const response = ev.response?.response;
      const allowed = response?.behavior === 'allow';
      const toolId = `tool-${current}`;
      emit({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: allowed ? 'command output' : 'denied',
              is_error: !allowed,
            },
          ],
        },
      });
      emit({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: allowed ? 'allowed and done' : 'denied, stopping' },
          ],
        },
      });
      if (current >= approvalsPerTurn) {
        result('success');
      } else {
        emitNextRequest();
      }
      return;
    }
    if (ev.type !== 'user') return;
    current = 0;
    emit({
      type: 'assistant',
      message: { content: [] },
    });
    emitNextRequest();
  });

  function emitNextRequest() {
    current++;
    emit({
      type: 'control_request',
      request_id: `req-${current}`,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: `cmd-${current}`, description: `Command ${current}` },
      },
    });
  }
} else if (scenario === 'approval-exit-plan') {
  // ExitPlanMode：通知型工具，input 为空对象，plan 内容不进 tool input。
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      const allowed = ev.response?.response?.behavior === 'allow';
      emit({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: allowed ? 'exiting plan mode' : 'plan kept' }],
        },
      });
      result('success');
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'assistant',
      message: { content: [] },
    });
    emit({
      type: 'control_request',
      request_id: 'req-exit-plan',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'ExitPlanMode',
        input: {},
        description: '已按计划准备好实施方案，请审批',
      },
    });
  });
} else if (scenario === 'approval-then-question') {
  // accept_all 后紧跟 AskUserQuestion：验证「允许所有」不会把提问也自动放行。
  init();
  let phase = 0; // 0=等 Bash 审批响应，1=等提问响应
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      if (phase === 0) {
        phase = 1;
        emit({
          type: 'control_request',
          request_id: 'req-q-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Pick a color',
                  options: [{ label: 'Red' }, { label: 'Blue' }],
                },
              ],
            },
          },
        });
        return;
      }
      if (phase === 1) {
        const answers = ev.response?.response?.updatedInput?.answers;
        emit({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `answers: ${JSON.stringify(answers)}` }] },
        });
        result('success', { result: 'answered' });
        return;
      }
      return;
    }
    if (ev.type !== 'user') return;
    phase = 0;
    emit({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'cmd-1', description: 'Command 1' },
      },
    });
  });
} else if (scenario === 'unknown-subtype') {
  // 未知 control_request subtype：协议层应 deny 兜底，mock 收到响应才结束 turn。
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'unknown subtype denied' }] },
      });
      result('success', { result: 'done' });
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'control_request',
      request_id: 'req-unknown-1',
      request: { subtype: 'mystery_subtype', tool_name: 'Bash', input: {} },
    });
  });
} else if (scenario === 'pre-init-assistant') {
  // --resume 历史重放：init 之前出现 assistant 内容（不只 result），必须丢弃。
  emit({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'STALE_REPLAY' }] },
  });
  init();
  rl.on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'fresh reply' }] },
    });
    result('success', { result: 'fresh reply' });
  });
} else if (scenario === 'question-dup') {
  // 两个问题文本相同：answers 字典会互相覆盖，协议层应拒绝该请求而非上抛卡片。
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'duplicate question denied' }] },
      });
      result('success', { result: 'done' });
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'control_request',
      request_id: 'req-dup-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [
            { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
            { question: 'Pick one', options: [{ label: 'C' }, { label: 'D' }] },
          ],
        },
      },
    });
  });
} else if (scenario === 'question-no-options') {
  // 零选项问题：answers 无法作答，协议层应拒绝该请求（deny 兜底）。
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'no-options question denied' }] },
      });
      result('success', { result: 'done' });
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'control_request',
      request_id: 'req-noopts-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [{ question: 'Pick one', options: [] }],
        },
      },
    });
  });
} else if (scenario === 'question') {
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'control_response') {
      const answers = ev.response?.response?.updatedInput?.answers;
      emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `answers: ${JSON.stringify(answers)}` }] },
      });
      result('success', { result: 'answered' });
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'control_request',
      request_id: 'req-q-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Pick a color',
              header: 'Color',
              options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
            },
            {
              question: 'Pick toppings',
              header: 'Toppings',
              multiSelect: true,
              options: [{ label: 'Cheese' }, { label: 'Bacon' }],
            },
          ],
        },
      },
    });
  });
} else {
  // plain (default): each user message gets a reply; stays alive between turns.
  init();
  rl.on('line', (line) => {
    if (recordStdin) fs.appendFileSync(recordStdin, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type !== 'user') return;
    emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    result('success', { result: 'hello' });
  });
}

// `readline` keeps the stdin flowing; the process stays alive until stdin
// closes or a signal kills it (long-lived session semantics).
