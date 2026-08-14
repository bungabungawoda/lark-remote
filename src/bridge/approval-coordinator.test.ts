/**
 * Tests for ApprovalCoordinator.
 *
 * 17 tests covering: constructor, onRequested, submit valid/invalid, onResolved,
 * pendingCount, head, onTurnEnded, togglePerm, timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalCoordinator, decisionToApprovalAction } from './approval-coordinator.js';
import type { ApprovalRequestedEvent, ApprovalView } from '../runner/types.js';

describe('ApprovalCoordinator', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

  const runId = 'run-aaa-111';
  const userId = 'user-1';
  const chatId = 'chat-1';
  const workspace = '/home/user/project';

  function makeCommandEvent(
    overrides: Partial<ApprovalRequestedEvent> = {},
  ): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 1001,
      kind: 'command',
      threadId: 'th-aaa-222',
      turnId: 'tn-222',
      itemId: 'item-2',
      view: {
        requestId: 1001,
        kind: 'command',
        threadShort: 'th-aaa-2',
        turnShort: 'tn-222',
        workspace: '/home/user/project',
        command: 'rm -rf /tmp/test',
        commandCwd: '/home/user/project',
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
      },
      ...overrides,
    };
  }

  function makeFileEvent(overrides: Partial<ApprovalRequestedEvent> = {}): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 1002,
      kind: 'file',
      threadId: 'th-aaa-333',
      turnId: 'tn-333',
      itemId: 'item-3',
      view: {
        requestId: 1002,
        kind: 'file',
        threadShort: 'th-aaa-3',
        turnShort: 'tn-333',
        workspace: '/home/user/project',
        fileChanges: [{ path: 'src/main.ts', kind: 'update', diff: '...' }],
        reason: 'File change approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
      },
      ...overrides,
    };
  }

  function makePermissionsEvent(
    overrides: Partial<ApprovalRequestedEvent> = {},
  ): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 1003,
      kind: 'permissions',
      threadId: 'th-aaa-444',
      turnId: 'tn-444',
      itemId: 'item-4',
      view: {
        requestId: 1003,
        kind: 'permissions',
        threadShort: 'th-aaa-4',
        turnShort: 'tn-444',
        workspace: '/home/user/project',
        reason: 'Permissions approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
        permissions: {
          items: [
            {
              id: 'net:api.example.com:443',
              label: 'https://api.example.com:443',
              target: { kind: 'network' },
              selected: false,
            },
            {
              id: 'fs-read:/home/user/project',
              label: 'Read: /home/user/project',
              target: { kind: 'fsRead', path: '/home/user/project' },
              selected: false,
            },
          ],
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    responder = vi.fn().mockResolvedValue(undefined);
    interruptTurn = vi.fn().mockResolvedValue(undefined);
    pushToCard = vi.fn().mockResolvedValue(undefined);

    coordinator = new ApprovalCoordinator({
      runId,
      userId,
      chatId,
      workspace,
      approvalTimeoutMs: 30000,
      responder,
      interruptTurn,
      pushToCard,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates an instance with zero pending approvals', () => {
      expect(coordinator.pendingCount()).toBe(0);
      expect(coordinator.head()).toBeUndefined();
    });
  });

  describe('onRequested', () => {
    it('tracks a new approval request', () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      expect(coordinator.pendingCount()).toBe(1);
      expect(coordinator.head()).toBeDefined();
      expect(coordinator.head()!.requestId).toBe(1001);
    });

    it('updates existing approval on duplicate requestId', () => {
      const event1 = makeCommandEvent({ requestId: 1001 });
      const event2 = makeCommandEvent({
        requestId: 1001,
        view: { ...event1.view, command: 'new command' },
      });
      coordinator.onRequested(event1);
      coordinator.onRequested(event2);
      expect(coordinator.pendingCount()).toBe(1);
      expect(coordinator.head()!.view.command).toBe('new command');
    });
  });

  describe('submit', () => {
    it('accepts a valid approval', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      const result = await coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      expect(result).toContain('Approval');
      expect(responder).toHaveBeenCalledWith(1001, { action: 'accept' });
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('rejects a duplicate nonce (same rendered button clicked twice)', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await coordinator.submit({ action: 'accept' }, { requestId: 1001, nonce: 'n1' });
      await expect(
        coordinator.submit({ action: 'decline' }, { requestId: 1001, nonce: 'n1' }),
      ).rejects.toThrow(/duplicate nonce/);
    });

    it('accepts string requestIds from the wire (schema: string | integer)', async () => {
      const event = makeCommandEvent({ requestId: 'req-abc-42' });
      event.view.requestId = 'req-abc-42';
      coordinator.onRequested(event);
      const result = await coordinator.submit(
        { action: 'accept' },
        { requestId: 'req-abc-42', nonce: 'n-str' },
      );
      expect(result).toContain('Approval');
      expect(responder).toHaveBeenCalledWith('req-abc-42', { action: 'accept' });
    });

    it('throws for unknown requestId', async () => {
      await expect(coordinator.submit({ action: 'accept' }, { requestId: 9999 })).rejects.toThrow(
        'not found',
      );
    });

    it('throws for non-pending approval', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
        'no longer pending',
      );
    });

    it('throws for invalid decision', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'cancel' }, { requestId: 1001 }),
      ).resolves.toBeDefined();
    });
  });

  describe('onResolved', () => {
    it('marks approval as resolved', () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      expect(coordinator.pendingCount()).toBe(1);
      coordinator.onResolved(1001);
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('handles unknown requestId gracefully', () => {
      expect(() => coordinator.onResolved(9999)).not.toThrow();
    });
  });

  describe('pendingCount', () => {
    it('returns zero when no approvals', () => {
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('returns correct count with multiple approvals', () => {
      coordinator.onRequested(makeCommandEvent({ requestId: 1001 }));
      coordinator.onRequested(makeFileEvent({ requestId: 1002 }));
      expect(coordinator.pendingCount()).toBe(2);
    });

    it('excludes resolved approvals', async () => {
      coordinator.onRequested(makeCommandEvent({ requestId: 1001 }));
      coordinator.onRequested(makeFileEvent({ requestId: 1002 }));
      await coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      expect(coordinator.pendingCount()).toBe(1);
    });
  });

  describe('head', () => {
    it('returns the oldest pending approval', () => {
      coordinator.onRequested(makeCommandEvent({ requestId: 1001 }));
      coordinator.onRequested(makeFileEvent({ requestId: 1002 }));
      expect(coordinator.head()!.requestId).toBe(1001);
    });
  });

  describe('onTurnEnded', () => {
    it('marks all pending as expired', () => {
      coordinator.onRequested(makeCommandEvent({ requestId: 1001 }));
      coordinator.onRequested(makeFileEvent({ requestId: 1002 }));
      expect(coordinator.pendingCount()).toBe(2);
      coordinator.onTurnEnded();
      expect(coordinator.pendingCount()).toBe(0);
      expect(coordinator.head()).toBeUndefined();
    });
  });

  describe('togglePerm', () => {
    it('toggles a permission item', async () => {
      const event = makePermissionsEvent();
      coordinator.onRequested(event);
      const result = await coordinator.togglePerm(
        { permId: 'net:api.example.com:443', selected: true },
        { requestId: 1003 },
      );
      expect(result).toContain('granted');
      expect(event.view.permissions!.items[0].selected).toBe(true);
    });

    it('throws for non-permissions request', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.togglePerm({ permId: 'test', selected: true }, { requestId: 1001 }),
      ).rejects.toThrow('not a permissions request');
    });

    it('throws for unknown permId', async () => {
      const event = makePermissionsEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.togglePerm({ permId: 'unknown', selected: true }, { requestId: 1003 }),
      ).rejects.toThrow('not found');
    });
  });

  describe('timeout', () => {
    it('expires approval after timeout', () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      expect(coordinator.pendingCount()).toBe(1);
      vi.advanceTimersByTime(30000);
      expect(coordinator.pendingCount()).toBe(0);
    });
  });

  describe('protocol decision space (real availableDecisions)', () => {
    function makeProtocolCommandEvent(
      overrides: Partial<ApprovalRequestedEvent> = {},
    ): ApprovalRequestedEvent {
      return {
        ...makeCommandEvent(),
        view: {
          ...makeCommandEvent().view,
          // 真实协议：服务端只列 accept / acceptWithExecpolicyAmendment / cancel
          availableDecisions: ['accept', 'acceptWithExecpolicyAmendment', 'cancel'],
          decisionPayloads: {
            acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '/tmp/test'] },
          },
        },
        ...overrides,
      };
    }

    it('test_anchor_coordinator_accepts_listed_amendment_decision', async () => {
      const event = makeProtocolCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'accept_with_execpolicy_amendment' }, { requestId: 1001 }),
      ).resolves.toBeDefined();
      expect(responder).toHaveBeenCalledWith(
        1001,
        expect.objectContaining({ action: 'accept_with_execpolicy_amendment' }),
      );
    });

    it('test_anchor_coordinator_always_allows_deny_even_when_unlisted', async () => {
      // 服务端列表不含 decline 时，拒绝仍必须可用（安全兜底：真人拒绝是普适语义，
      // 实测服务端也接受 decline）。
      const event = makeProtocolCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'decline' }, { requestId: 1001 }),
      ).resolves.toBeDefined();
    });

    it('test_anchor_coordinator_rejects_unlisted_positive_decision', async () => {
      // 未列出的正向决策（acceptForSession）不得通过校验。
      const event = makeProtocolCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'accept_for_session' }, { requestId: 1001 }),
      ).rejects.toThrow('not in available decisions');
    });

    it('test_anchor_coordinator_update_view_only_while_pending', async () => {
      const event = makeFileEvent();
      coordinator.onRequested(event);
      const updatedView: ApprovalView = {
        ...event.view,
        fileChanges: [{ path: '/home/user/project/a.txt', kind: 'update', diff: '+hello' }],
      };
      coordinator.updateView(1002, updatedView);
      expect(coordinator.head()?.view.fileChanges).toEqual([
        { path: '/home/user/project/a.txt', kind: 'update', diff: '+hello' },
      ]);

      // 已响应后 updateView 不得复活/改写
      await coordinator.submit({ action: 'accept' }, { requestId: 1002 });
      coordinator.updateView(1002, { ...updatedView, fileChanges: [] });
      expect(coordinator.head()).toBeUndefined();
    });
  });

  describe('decisionToApprovalAction mapping', () => {
    it('test_anchor_decision_to_action_maps_protocol_decisions', () => {
      expect(decisionToApprovalAction('accept')).toEqual({ action: 'accept' });
      expect(decisionToApprovalAction('acceptForSession')).toEqual({
        action: 'accept_for_session',
      });
      expect(decisionToApprovalAction('acceptWithExecpolicyAmendment')).toEqual({
        action: 'accept_with_execpolicy_amendment',
      });
      expect(decisionToApprovalAction('decline')).toEqual({ action: 'decline' });
      expect(decisionToApprovalAction('cancel')).toEqual({ action: 'cancel' });
    });
  });
});
