/**
 * Contract tests for protocol-types.ts
 *
 * Method names and field shapes follow the real Codex app-server v2 protocol
 * (verified against `codex app-server generate-json-schema --experimental`).
 */

import { describe, it, expect } from 'vitest';
import {
  NotificationMethod,
  ServerRequestMethod,
  UNSUPPORTED_SERVER_REQUEST_METHODS,
} from './protocol-types.js';

describe('protocol-types', () => {
  describe('NotificationMethod constants', () => {
    it('has all notification methods (real v2 wire names)', () => {
      expect({ ...NotificationMethod }).toEqual({
        TURN_STARTED: 'turn/started',
        TURN_COMPLETED: 'turn/completed',
        ITEM_STARTED: 'item/started',
        ITEM_COMPLETED: 'item/completed',
        AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
        REASONING_SUMMARY_TEXT_DELTA: 'item/reasoning/summaryTextDelta',
        REASONING_SUMMARY_PART_ADDED: 'item/reasoning/summaryPartAdded',
        REASONING_TEXT_DELTA: 'item/reasoning/textDelta',
        COMMAND_EXECUTION_OUTPUT_DELTA: 'item/commandExecution/outputDelta',
        PLAN_DELTA: 'item/plan/delta',
        FILE_CHANGE_OUTPUT_DELTA: 'item/fileChange/outputDelta',
        TOKEN_USAGE_UPDATED: 'thread/tokenUsage/updated',
        SERVER_REQUEST_RESOLVED: 'serverRequest/resolved',
        ERROR: 'error',
        WARNING: 'warning',
        THREAD_STARTED: 'thread/started',
        THREAD_STATUS_CHANGED: 'thread/status/changed',
        THREAD_SETTINGS_UPDATED: 'thread/settings/updated',
        MODEL_REROUTED: 'model/rerouted',
        THREAD_COMPACTED: 'thread/compacted',
        TURN_DIFF_UPDATED: 'turn/diff/updated',
        TURN_PLAN_UPDATED: 'turn/plan/updated',
      });
    });
  });

  describe('ServerRequestMethod constants', () => {
    it('has all server request methods (real v2 wire names)', () => {
      expect({ ...ServerRequestMethod }).toEqual({
        COMMAND_EXECUTION_APPROVAL: 'item/commandExecution/requestApproval',
        FILE_CHANGE_APPROVAL: 'item/fileChange/requestApproval',
        PERMISSIONS_APPROVAL: 'item/permissions/requestApproval',
        REQUEST_USER_INPUT: 'item/tool/requestUserInput',
      });
    });
  });

  describe('UNSUPPORTED_SERVER_REQUEST_METHODS', () => {
    it('contains unsupported methods', () => {
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
      expect(UNSUPPORTED_SERVER_REQUEST_METHODS.has('item/tool/requestUserInput')).toBe(false);
    });
  });
});
