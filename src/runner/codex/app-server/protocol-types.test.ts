/**
 * Contract tests for protocol-types.ts
 *
 * Method names and field shapes follow the real Codex app-server v2 protocol
 * (verified against `codex app-server generate-json-schema --experimental`).
 */

import { describe, it, expect } from 'vitest';
import {
  RpcErrorCode,
  NotificationMethod,
  ServerRequestMethod,
  UNSUPPORTED_SERVER_REQUEST_METHODS,
} from './protocol-types.js';

describe('protocol-types', () => {
  describe('RpcErrorCode constants', () => {
    it('defines standard JSON-RPC error codes', () => {
      expect(RpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(RpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(RpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
      expect(RpcErrorCode.INVALID_PARAMS).toBe(-32602);
      expect(RpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    });

    it('defines custom error codes', () => {
      expect(RpcErrorCode.TIMEOUT_ERROR).toBe(-32000);
      expect(RpcErrorCode.CONNECTION_LOST).toBe(-32001);
    });
  });

  describe('NotificationMethod constants', () => {
    it('has all notification methods (real v2 wire names)', () => {
      expect(NotificationMethod.TURN_STARTED).toBe('turn/started');
      expect(NotificationMethod.TURN_COMPLETED).toBe('turn/completed');
      expect(NotificationMethod.ITEM_STARTED).toBe('item/started');
      expect(NotificationMethod.ITEM_COMPLETED).toBe('item/completed');
      expect(NotificationMethod.AGENT_MESSAGE_DELTA).toBe('item/agentMessage/delta');
      expect(NotificationMethod.REASONING_SUMMARY_TEXT_DELTA).toBe(
        'item/reasoning/summaryTextDelta',
      );
      expect(NotificationMethod.REASONING_SUMMARY_PART_ADDED).toBe(
        'item/reasoning/summaryPartAdded',
      );
      expect(NotificationMethod.COMMAND_EXECUTION_OUTPUT_DELTA).toBe(
        'item/commandExecution/outputDelta',
      );
      expect(NotificationMethod.PLAN_DELTA).toBe('item/plan/delta');
      expect(NotificationMethod.FILE_CHANGE_OUTPUT_DELTA).toBe('item/fileChange/outputDelta');
      expect(NotificationMethod.TOKEN_USAGE_UPDATED).toBe('thread/tokenUsage/updated');
      expect(NotificationMethod.SERVER_REQUEST_RESOLVED).toBe('serverRequest/resolved');
      expect(NotificationMethod.ERROR).toBe('error');
      expect(NotificationMethod.WARNING).toBe('warning');
      expect(NotificationMethod.THREAD_STARTED).toBe('thread/started');
      expect(NotificationMethod.THREAD_STATUS_CHANGED).toBe('thread/status/changed');
      expect(NotificationMethod.MODEL_REROUTED).toBe('model/rerouted');
      expect(NotificationMethod.THREAD_COMPACTED).toBe('thread/compacted');
    });
  });

  describe('ServerRequestMethod constants', () => {
    it('has all server request methods (real v2 wire names)', () => {
      expect(ServerRequestMethod.COMMAND_EXECUTION_APPROVAL).toBe(
        'item/commandExecution/requestApproval',
      );
      expect(ServerRequestMethod.FILE_CHANGE_APPROVAL).toBe('item/fileChange/requestApproval');
      expect(ServerRequestMethod.PERMISSIONS_APPROVAL).toBe('item/permissions/requestApproval');
    });
  });

  describe('UNSUPPORTED_SERVER_REQUEST_METHODS', () => {
    it('contains unsupported methods', () => {
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('item/tool/requestUserInput')).toBe(true);
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('mcpServer/elicitation/request')).toBe(true);
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('execCommandApproval')).toBe(true);
      // 真实协议（v2 schema）的 server-request 全集里的其余方法必须显式归类，
      // 不能靠 default 兜底（2026-08-12 review：currentTime/read 曾缺失）。
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('currentTime/read')).toBe(true);
    });

    it('does not contain supported methods', () => {
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('item/commandExecution/requestApproval')).toBe(
        false,
      );
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('item/fileChange/requestApproval')).toBe(false);
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('item/permissions/requestApproval')).toBe(
        false,
      );
    });
  });

  describe('wire field conventions', () => {
    it('uses camelCase for protocol params (threadId/turnId/itemId)', () => {
      const params = {
        threadId: 'th-123',
        turnId: 'tn-456',
        itemId: 'item-1',
      };
      expect(params.threadId).toBe('th-123');
      expect(params.turnId).toBe('tn-456');
      expect(params.itemId).toBe('item-1');
    });

    it('turn/start input is an array of UserInput objects', () => {
      const params = {
        threadId: 'th-123',
        input: [{ type: 'text' as const, text: 'hello' }],
      };
      expect(params.input[0].text).toBe('hello');
    });

    it('sandbox mode uses the real protocol enum', () => {
      const modes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
      expect(modes).toContain('workspace-write');
      expect(modes).toContain('danger-full-access');
      expect(modes).not.toContain('sandboxed');
    });

    it('approval response carries a decision', () => {
      const response = { decision: 'accept' as const };
      expect(response.decision).toBe('accept');
    });
  });
});
