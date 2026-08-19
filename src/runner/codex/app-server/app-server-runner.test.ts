/**
 * Tests for the Codex App Server translator: real protocol method names and
 * parameter shapes → AgentEvents.
 */

import { describe, it, expect } from 'vitest';
import { NotificationMethod, ServerRequestMethod } from './protocol-types.js';
import { CodexAppServerTranslator } from './translator.js';
import type { AgentEvent, ApprovalRequestedEvent, ApprovalView } from '../../types.js';

describe('Codex App Server Runner', () => {
  describe('module imports', () => {
    it('imports protocol-types without error', () => {
      expect(NotificationMethod.TURN_STARTED).toBeDefined();
      expect(ServerRequestMethod.COMMAND_EXECUTION_APPROVAL).toBeDefined();
    });

    it('imports translator without error', () => {
      expect(CodexAppServerTranslator).toBeDefined();
    });
  });

  describe('translator', () => {
    describe('turn/started notification', () => {
      it('returns a TurnStartedEvent', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleNotification('turn/started', {
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'inProgress' },
        });
        expect(events).toHaveLength(1);
        const event = events[0] as { type: string; threadId: string; turnId: string };
        expect(event.type).toBe('turn_started');
        expect(event.threadId).toBe('th-aaa-111');
        expect(event.turnId).toBe('tn-111');
      });
    });

    describe('item/agentMessage/delta notification', () => {
      it('accumulates text and returns TurnDiffEvent', () => {
        const translator = new CodexAppServerTranslator();

        translator.handleNotification('turn/started', {
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'inProgress' },
        });

        const events1 = translator.handleNotification('item/agentMessage/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-1',
          delta: 'Hello, ',
        });
        expect(events1).toHaveLength(1);
        expect((events1[0] as { text: string }).text).toBe('Hello, ');

        const events2 = translator.handleNotification('item/agentMessage/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-1',
          delta: 'world!',
        });
        expect((events2[0] as { text: string }).text).toBe('Hello, world!');
      });
    });

    describe('thread/tokenUsage/updated notification', () => {
      it('tracks usage and synthesizes it in turn/completed', () => {
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('turn/started', {
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'inProgress' },
        });

        translator.handleNotification('thread/tokenUsage/updated', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          tokenUsage: {
            last: {
              inputTokens: 100,
              outputTokens: 50,
              cachedInputTokens: 10,
              totalTokens: 150,
            },
            total: {
              inputTokens: 100,
              outputTokens: 50,
              cachedInputTokens: 10,
              totalTokens: 150,
            },
            modelContextWindow: 200000,
          },
        });

        const events = translator.handleTurnCompleted({
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'completed' },
        });

        const resultEvent = events.find((e) => (e as AgentEvent).type === 'result') as
          AgentEvent | undefined;
        expect(resultEvent).toBeDefined();
        if (resultEvent && resultEvent.type === 'result') {
          expect(resultEvent.usage?.input_tokens).toBe(100);
          expect(resultEvent.usage?.output_tokens).toBe(50);
        }
      });

      it('test_anchor_appserver_token_usage_carries_model_context_window', () => {
        // 验证：thread/tokenUsage/updated 的 tokenUsage.modelContextWindow（v2 schema
        // 与 last/total 平级）透传到 result 事件的 usage.context_limit，Run 卡片据此
        // 渲染 "Context - X (Y%)"。缺失/错误会导致 app-server 模式没有百分比分母。
        // 依据：openai/codex app-server v2 协议实测 wire 形如
        // {"tokenUsage":{"last":{...},"modelContextWindow":258400,"total":{...}}}。
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('turn/started', {
          threadId: 'th-aaa-112',
          turn: { id: 'tn-112', items: [], status: 'inProgress' },
        });

        translator.handleNotification('thread/tokenUsage/updated', {
          threadId: 'th-aaa-112',
          turnId: 'tn-112',
          tokenUsage: {
            last: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            total: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            modelContextWindow: 200000,
          },
        });

        const events = translator.handleTurnCompleted({
          threadId: 'th-aaa-112',
          turn: { id: 'tn-112', items: [], status: 'completed' },
        });
        const resultEvent = events.find((e) => (e as AgentEvent).type === 'result') as
          AgentEvent | undefined;
        expect(resultEvent).toBeDefined();
        if (resultEvent && resultEvent.type === 'result') {
          expect(resultEvent.usage?.context_limit).toBe(200000);
        }
      });
    });

    describe('error notification', () => {
      it('returns an error result event', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleNotification('error', {
          threadId: 'th-aaa-555',
          turnId: 'tn-555',
          error: { message: 'Something went wrong' },
          willRetry: false,
        });
        expect(events).toHaveLength(1);
        const event = events[0] as AgentEvent;
        expect(event.type).toBe('result');
        if (event.type === 'result') {
          expect(event.subtype).toBe('error');
          expect(event.errorMessage).toBe('Something went wrong');
        }
      });

      it('does not emit a terminal result when willRetry is true', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleNotification('error', {
          threadId: 'th-aaa-555',
          turnId: 'tn-555',
          error: { message: 'transient' },
          willRetry: true,
        });
        // 服务端会重试该 turn：不能提前结束 run（否则桥与 server 状态脱节）。
        expect(events).toHaveLength(0);
      });
    });

    describe('reasoning text delta', () => {
      it('accumulates contentIndex paragraphs into a reasoning snapshot', () => {
        const translator = new CodexAppServerTranslator();
        const first = translator.handleNotification('item/reasoning/textDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-r1',
          contentIndex: 0,
          delta: 'think one',
        });
        expect(first).toHaveLength(1);
        expect((first[0] as { reasoning?: string }).reasoning).toBe('think one');

        const second = translator.handleNotification('item/reasoning/textDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-r1',
          contentIndex: 1,
          delta: 'think two',
        });
        expect((second[0] as { reasoning?: string }).reasoning).toBe('think one\nthink two');

        // item/completed 的 reasoning item 是权威内容（含 summary）。
        const completed = translator.handleNotification('item/completed', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: { type: 'reasoning', id: 'item-r1', content: ['final content'], summary: ['sum'] },
          completedAtMs: 2,
        });
        expect((completed[0] as { reasoning?: string }).reasoning).toBe('final content\nsum');
      });
    });

    describe('plan text delta', () => {
      it('accumulates plain-text plan deltas (real protocol delta is a string)', () => {
        const translator = new CodexAppServerTranslator();
        const first = translator.handleNotification('item/plan/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-p1',
          delta: 'Step 1',
        });
        expect((first[0] as { plan?: string }).plan).toBe('Step 1');

        const second = translator.handleNotification('item/plan/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-p1',
          delta: '\nStep 2',
        });
        expect((second[0] as { plan?: string }).plan).toBe('Step 1\nStep 2');
      });
    });

    describe('item-scoped streams', () => {
      it('isolates interleaved reasoning items per itemId', () => {
        const translator = new CodexAppServerTranslator();
        const r1 = translator.handleNotification('item/reasoning/textDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-r1',
          contentIndex: 0,
          delta: 'first thought',
        });
        const r2 = translator.handleNotification('item/reasoning/textDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-r2',
          contentIndex: 0,
          delta: 'second thought',
        });
        expect((r1[0] as { reasoning?: string }).reasoning).toBe('first thought');
        expect((r2[0] as { reasoning?: string }).reasoning).toBe('second thought');
        expect((r1[0] as { itemId?: string }).itemId).toBe('item-r1');
        expect((r2[0] as { itemId?: string }).itemId).toBe('item-r2');

        // item-r1 继续累积不影响 item-r2
        const r1b = translator.handleNotification('item/reasoning/textDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-r1',
          contentIndex: 1,
          delta: ' more',
        });
        expect((r1b[0] as { reasoning?: string }).reasoning).toBe('first thought\n more');
        const r2b = translator.handleNotification('item/reasoning/textDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-r2',
          contentIndex: 1,
          delta: '!',
        });
        expect((r2b[0] as { reasoning?: string }).reasoning).toBe('second thought\n!');
      });

      it('separates agentMessage items and emits receive timestamps on every turn_diff', () => {
        const translator = new CodexAppServerTranslator();
        const e1 = translator.handleNotification('item/agentMessage/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-1',
          delta: 'Hello, ',
        });
        const e2 = translator.handleNotification('item/agentMessage/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-2',
          delta: 'Done',
        });
        expect((e1[0] as { text?: string }).text).toBe('Hello, ');
        expect((e2[0] as { text?: string }).text).toBe('Done');
        expect((e1[0] as { itemId?: string }).itemId).toBe('item-1');
        expect((e2[0] as { itemId?: string }).itemId).toBe('item-2');
        expect((e1[0] as { timestamp?: string }).timestamp).toBeTruthy();
        expect((e2[0] as { timestamp?: string }).timestamp).toBeTruthy();
      });

      it('anchors command tool at item/started and completes with authoritative output', () => {
        const translator = new CodexAppServerTranslator();
        const started = translator.handleNotification('item/started', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: {
            type: 'commandExecution',
            id: 'item-c1',
            command: 'ls',
            cwd: '/home/user/project',
          },
          startedAtMs: 1,
        });
        expect((started[0] as { toolOutput?: string }).toolOutput).toBe('');
        expect((started[0] as { itemId?: string }).itemId).toBe('item-c1');

        const out = translator.handleNotification('item/commandExecution/outputDelta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-c1',
          delta: 'a.ts',
        });
        expect((out[0] as { toolOutput?: string }).toolOutput).toBe('a.ts');

        const done = translator.handleNotification('item/completed', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: {
            type: 'commandExecution',
            id: 'item-c1',
            command: 'ls',
            aggregatedOutput: 'a.ts b.ts',
            status: 'success',
          },
          completedAtMs: 2,
        });
        expect((done[0] as { toolOutput?: string }).toolOutput).toBe('a.ts b.ts');
        expect((done[0] as { complete?: boolean }).complete).toBe(true);
        expect((done[0] as { itemId?: string }).itemId).toBe('item-c1');
      });

      it('maps failed command status to tool error on completion', () => {
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('item/started', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: {
            type: 'commandExecution',
            id: 'item-c1',
            command: 'false',
            cwd: '/home/user/project',
          },
          startedAtMs: 1,
        });
        const done = translator.handleNotification('item/completed', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: {
            type: 'commandExecution',
            id: 'item-c1',
            command: 'false',
            aggregatedOutput: 'exit 1',
            status: 'failed',
          },
          completedAtMs: 2,
        });
        expect((done[0] as { toolStatus?: string }).toolStatus).toBe('error');
      });

      it('skips empty completion for a command that never started (approval-declined edge)', () => {
        const translator = new CodexAppServerTranslator();
        const done = translator.handleNotification('item/completed', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: {
            type: 'commandExecution',
            id: 'item-c1',
            command: 'rm -rf /tmp/test',
            aggregatedOutput: null,
            status: 'cancelled',
          },
          completedAtMs: 2,
        });
        // 从未 item/started 且无任何输出 → 不凭空产生工具块
        expect(done).toHaveLength(0);
      });

      it('completes a streamed agentMessage even when the final text is empty', () => {
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('item/agentMessage/delta', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          itemId: 'item-1',
          delta: 'streamed but final empty',
        });
        const done = translator.handleNotification('item/completed', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: { type: 'agentMessage', id: 'item-1', text: '', phase: 'final_answer' },
          completedAtMs: 2,
        });
        expect(done).toHaveLength(1);
        expect((done[0] as { text?: string }).text).toBe('streamed but final empty');
        expect((done[0] as { complete?: boolean }).complete).toBe(true);
      });

      it('emits authoritative agentMessage snapshot at item/completed', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleNotification('item/completed', {
          threadId: 'th-aaa-111',
          turnId: 'tn-111',
          item: { type: 'agentMessage', id: 'item-1', text: 'final answer', phase: 'final_answer' },
          completedAtMs: 4,
        });
        expect(events).toHaveLength(1);
        expect((events[0] as { text?: string }).text).toBe('final answer');
        expect((events[0] as { itemId?: string }).itemId).toBe('item-1');
        expect((events[0] as { complete?: boolean }).complete).toBe(true);
        expect((events[0] as { timestamp?: string }).timestamp).toBeTruthy();
      });
    });

    describe('turn/completed notification', () => {
      it('synthesizes result event with proper status', () => {
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('turn/started', {
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'inProgress' },
        });

        const events = translator.handleTurnCompleted({
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'completed' },
        });

        const resultEvent = events.find((e) => (e as AgentEvent).type === 'result') as
          AgentEvent | undefined;
        expect(resultEvent).toBeDefined();
        if (resultEvent && resultEvent.type === 'result') {
          expect(resultEvent.subtype).toBe('success');
        }
      });

      it('falls back to agentMessage items when no deltas were seen', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleTurnCompleted({
          threadId: 'th-aaa-111',
          turn: {
            id: 'tn-111',
            status: 'completed',
            items: [
              { type: 'agentMessage', id: 'item-1', text: 'final answer', phase: 'final_answer' },
            ],
          },
        });
        const diff = events.find((e) => e.type === 'turn_diff' && 'text' in e) as
          { text?: string } | undefined;
        expect(diff).toBeDefined();
        expect(diff?.text).toBe('final answer');
      });

      it('returns error subtype for failed status', () => {
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('turn/started', {
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'inProgress' },
        });

        const events = translator.handleTurnCompleted({
          threadId: 'th-aaa-111',
          turn: {
            id: 'tn-111',
            items: [],
            status: 'failed',
            error: { type: 'internal_error', message: 'Failed' },
          },
        });

        const resultEvent = events.find((e) => (e as AgentEvent).type === 'result') as
          AgentEvent | undefined;
        expect(resultEvent).toBeDefined();
        if (resultEvent && resultEvent.type === 'result') {
          expect(resultEvent.subtype).toBe('error');
          expect(resultEvent.errorMessage).toBe('Failed');
        }
      });

      it('returns interrupted subtype (not error) for interrupted status', () => {
        const translator = new CodexAppServerTranslator();
        translator.handleNotification('turn/started', {
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'inProgress' },
        });

        const events = translator.handleTurnCompleted({
          threadId: 'th-aaa-111',
          turn: { id: 'tn-111', items: [], status: 'interrupted' },
        });

        const resultEvent = events.find((e) => (e as AgentEvent).type === 'result') as
          AgentEvent | undefined;
        expect(resultEvent).toBeDefined();
        if (resultEvent && resultEvent.type === 'result') {
          expect(resultEvent.subtype).toBe('interrupted');
          // interrupted 不是 Agent 失败：不应带归因于 Agent 的错误文案。
          expect(resultEvent.errorMessage).toBeUndefined();
        }
      });
    });

    describe('command approval server request', () => {
      it('returns an ApprovalRequestedEvent with the JSON-RPC id', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleServerRequest(42, 'item/commandExecution/requestApproval', {
          threadId: 'th-aaa-222',
          turnId: 'tn-222',
          itemId: 'item-2',
          startedAtMs: 1,
          command: 'rm -rf /tmp/test',
          cwd: '/home/user/project',
          reason: 'Delete temporary test directory',
        });
        expect(events).toHaveLength(1);
        const event = events[0] as { type: string; kind: string; requestId: number };
        expect(event.type).toBe('approval_requested');
        expect(event.kind).toBe('command');
        expect(event.requestId).toBe(42);
        const view = (event as { view: ApprovalView }).view;
        expect(view.command).toBe('rm -rf /tmp/test');
        expect(view.commandCwd).toBe('/home/user/project');
      });
    });

    describe('permissions approval server request', () => {
      it('builds permission items from the requested profile', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleServerRequest(7, 'item/permissions/requestApproval', {
          threadId: 'th-aaa-333',
          turnId: 'tn-333',
          itemId: 'item-3',
          startedAtMs: 1,
          cwd: '/home/user/project',
          permissions: {
            fileSystem: {
              // 真实协议：read/write 是 legacy 字符串数组；entries 是结构化形式。
              read: ['/etc/hosts'],
              write: ['/home/user/project/a.txt'],
            },
            network: { enabled: true },
          },
        });
        expect(events).toHaveLength(1);
        const event = events[0] as { type: string; kind: string; view: ApprovalView };
        expect(event.type).toBe('approval_requested');
        expect(event.kind).toBe('permissions');
        expect(event.view.permissions?.items.map((i) => i.id)).toEqual([
          'fs-read:/etc/hosts',
          'fs-write:/home/user/project/a.txt',
          'net:all',
        ]);
      });
    });

    describe('file approval carries real file changes from item/started', () => {
      it('test_anchor_file_approval_carries_item_changes', () => {
        // 验证行为：translator 消费 item/started 的 fileChange item（真实协议中
        // 变更信息唯一来源），并按 itemId 关联到 fileChange 审批视图。
        // 缺失后果：真实协议下 grantRoot/reason 均为 null，卡片只剩「📄 文件变更审批」
        // 标题，用户看不到文件路径与 diff（线上已复现）。
        // 依据：真实 codex app-server 抓包（item/started 先于
        // item/fileChange/requestApproval 到达，item.id === 审批 itemId）。
        const translator = new CodexAppServerTranslator();

        translator.handleNotification('item/started', {
          threadId: 'th-aaa-333',
          turnId: 'tn-333',
          item: {
            type: 'fileChange',
            id: 'call_00_item333',
            changes: [
              {
                path: '/home/user/project/a.txt',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
              },
            ],
            status: 'inProgress',
          },
          startedAtMs: 1,
        });

        const events = translator.handleServerRequest(42, 'item/fileChange/requestApproval', {
          threadId: 'th-aaa-333',
          turnId: 'tn-333',
          itemId: 'call_00_item333',
          startedAtMs: 1,
          reason: null,
          grantRoot: null,
        });

        expect(events).toHaveLength(1);
        const event = events[0] as {
          type: string;
          kind: string;
          requestId: number;
          view: ApprovalView;
        };
        expect(event.type).toBe('approval_requested');
        expect(event.kind).toBe('file');
        expect(event.requestId).toBe(42);
        expect(event.view.fileChanges).toEqual([
          {
            path: '/home/user/project/a.txt',
            kind: 'update',
            diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
          },
        ]);
      });
    });

    describe('command approval decision space comes from the protocol', () => {
      it('test_anchor_command_approval_uses_real_available_decisions', () => {
        // 验证行为：命令审批的 availableDecisions 必须来自真实协议（字符串 +
        // 对象决策，如 acceptWithExecpolicyAmendment），对象决策的 payload
        // 存进 decisionPayloads 供响应构建使用。
        // 缺失后果：硬编码 ['accept','decline','cancel'] 与真实协议不符——
        // 服务端只列 accept/acceptWithExecpolicyAmendment/cancel 时，真实
        // 决策空间被遮蔽，且校验/响应无法覆盖 acceptWithExecpolicyAmendment。
        // 依据：codex app-server 抓包（rm 审批的 availableDecisions 为
        // ["accept", {"acceptWithExecpolicyAmendment": {...}}, "cancel"]）。
        const translator = new CodexAppServerTranslator();
        const events = translator.handleServerRequest(42, 'item/commandExecution/requestApproval', {
          threadId: 'th-aaa-222',
          turnId: 'tn-222',
          itemId: 'item-2',
          startedAtMs: 1,
          command: 'rm -rf /tmp/test',
          cwd: '/home/user/project',
          availableDecisions: [
            'accept',
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '/tmp/test'] } },
            'cancel',
          ],
        });

        expect(events).toHaveLength(1);
        const view = (events[0] as { view: ApprovalView }).view;
        expect(view.availableDecisions).toEqual([
          'accept',
          'acceptWithExecpolicyAmendment',
          'cancel',
        ]);
        expect(view.decisionPayloads?.['acceptWithExecpolicyAmendment']).toEqual({
          execpolicy_amendment: ['rm', '/tmp/test'],
        });
      });
    });

    describe('file approval out-of-order flow (approval before item/started)', () => {
      it('test_anchor_file_approval_updates_view_when_item_arrives_late', () => {
        // 验证行为：审批先于 item/started 到达时，立即出审批事件（回退空），
        // item 后到时必须补发 approval_view_updated（同 requestId）让卡片补全
        // 真实文件变更。
        // 缺失后果：grantRoot 为 null 时卡片永远空白，用户看不到文件和变更
        // （线上复现场景的乱序变体）。
        // 依据：真实协议 item/started 与审批都带 itemId，顺序不保证。
        const translator = new CodexAppServerTranslator();

        const first = translator.handleServerRequest(42, 'item/fileChange/requestApproval', {
          threadId: 'th-aaa-333',
          turnId: 'tn-333',
          itemId: 'call_00_late',
          startedAtMs: 1,
          reason: null,
          grantRoot: null,
        });
        expect(first).toHaveLength(1);
        expect((first[0] as { view: ApprovalView }).view.fileChanges).toBeUndefined();

        const updates = translator.handleNotification('item/started', {
          threadId: 'th-aaa-333',
          turnId: 'tn-333',
          item: {
            type: 'fileChange',
            id: 'call_00_late',
            changes: [
              {
                path: '/home/user/project/a.txt',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
              },
            ],
            status: 'inProgress',
          },
          startedAtMs: 2,
        });
        const upd = updates.find((e) => e.type === 'approval_view_updated') as
          { requestId: number; view: ApprovalView } | undefined;
        expect(upd).toBeDefined();
        expect(upd?.requestId).toBe(42);
        expect(upd?.view.fileChanges).toEqual([
          {
            path: '/home/user/project/a.txt',
            kind: 'update',
            diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
          },
        ]);
      });
    });

    describe('request_user_input server request', () => {
      it('test_anchor_request_user_input_surfaces_question_approval', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleServerRequest(9, 'item/tool/requestUserInput', {
          threadId: 'th-aaa-222',
          turnId: 'tn-222',
          itemId: 'item-9',
          questions: [
            {
              id: 'db',
              header: 'Setup',
              question: 'Which database?',
              isOther: false,
              isSecret: false,
              options: [
                { label: 'PostgreSQL', description: 'Robust' },
                { label: 'SQLite', description: 'Lightweight' },
              ],
            },
            {
              id: 'stack',
              header: 'Stack',
              question: 'Pick frameworks',
              isOther: true,
              isSecret: false,
              options: [{ label: 'React' }, { label: 'Vue' }],
            },
          ],
          autoResolutionMs: 120000,
        });

        expect(events).toHaveLength(1);
        const event = events[0] as unknown as ApprovalRequestedEvent;
        expect(event.type).toBe('approval_requested');
        expect(event.kind).toBe('question');
        expect(event.requestId).toBe(9);
        expect(event.threadId).toBe('th-aaa-222');
        // autoResolutionMs 必须透传为 per-request 超时（coordinator 优先使用）
        expect(event.timeoutMs).toBe(120000);
        expect(event.view.availableDecisions).toEqual([]);
        expect(event.view.questions).toEqual([
          {
            id: 'db',
            header: 'Setup',
            question: 'Which database?',
            isOther: false,
            isSecret: false,
            // Codex user_note：选项题渲染「补充说明（可选）」输入
            allowNote: true,
            options: [
              { label: 'PostgreSQL', description: 'Robust' },
              { label: 'SQLite', description: 'Lightweight' },
            ],
          },
          {
            id: 'stack',
            header: 'Stack',
            question: 'Pick frameworks',
            isOther: true,
            isSecret: false,
            allowNote: true,
            options: [{ label: 'React' }, { label: 'Vue' }],
          },
        ]);
      });

      it('test_anchor_request_user_input_null_options_is_free_text_question', () => {
        const translator = new CodexAppServerTranslator();
        const events = translator.handleServerRequest(10, 'item/tool/requestUserInput', {
          threadId: 'th-aaa-222',
          turnId: 'tn-222',
          itemId: 'item-10',
          questions: [
            {
              id: 'msg',
              header: '',
              question: 'Commit message',
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
          autoResolutionMs: null,
        });

        expect(events).toHaveLength(1);
        const event = events[0] as unknown as ApprovalRequestedEvent;
        expect(event.view.questions?.[0]?.options).toEqual([]);
        expect(event.timeoutMs).toBeUndefined();
      });
    });
  });

  describe('protocol-type constants', () => {
    it('has the correct set of notification methods', () => {
      const methods = Object.values(NotificationMethod);
      expect(methods).toContain('turn/started');
      expect(methods).toContain('turn/completed');
      expect(methods).toContain('item/agentMessage/delta');
      expect(methods).toContain('thread/tokenUsage/updated');
      expect(methods).toContain('serverRequest/resolved');
      expect(methods).toContain('error');
      expect(methods).toContain('model/rerouted');
      expect(methods).toContain('thread/settings/updated');
      expect(methods.length).toBe(22);
    });

    it('has the correct set of server request methods', () => {
      const methods = Object.values(ServerRequestMethod);
      expect(methods).toContain('item/commandExecution/requestApproval');
      expect(methods).toContain('item/fileChange/requestApproval');
      expect(methods).toContain('item/permissions/requestApproval');
      expect(methods).toContain('item/tool/requestUserInput');
      expect(methods.length).toBe(4);
    });
  });
});
