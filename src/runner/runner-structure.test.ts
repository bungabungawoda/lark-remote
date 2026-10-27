import { describe, it, expect } from 'vitest';
import {
  ClaudeRunner,
  CodexAppServerRunner,
  DshRunner,
  KimiAcpRunner,
  OpencodeAcpRunner,
  PiRpcRunner,
} from './index.js';
import { AGENT_KINDS } from '../agent-kinds.js';
import type { AgentKind } from '../agent-kinds.js';
import { COMPACT_CAPABILITY } from './types.js';

describe('compact capability matrix', () => {
  /**
   * 每个 kind 的 runner 类（原型链上取 runCompact，基类实现即可）。
   * 这张表与 `COMPACT_CAPABILITY` 都是 `Record<AgentKind, …>`：新增 agent 时
   * 两处都缺项会直接编译失败，必须显式回答「能不能压缩」。
   */
  const RUNNER_PROTOTYPES: Record<AgentKind, object> = {
    claude: ClaudeRunner.prototype,
    codex: CodexAppServerRunner.prototype,
    opencode: OpencodeAcpRunner.prototype,
    pi: PiRpcRunner.prototype,
    kimi: KimiAcpRunner.prototype,
    dsh: DshRunner.prototype,
  };

  it('声明的 compact 能力与 runner 实现一一对应（禁止再靠鸭子类型静默漏实现）', () => {
    // 回归：dsh 接入时没有任何一处要求它实现 runCompact，于是 run 卡片按
    // `'runCompact' in runner` 判定为「无能力」，按钮整个不渲染、无日志、无
    // 测试失败（2026-10-17）。这条用例把「声明」和「实现」钉死在一起。
    for (const kind of AGENT_KINDS) {
      const proto = RUNNER_PROTOTYPES[kind] as Record<string, unknown>;
      const implemented = typeof proto.runCompact === 'function';
      expect(
        implemented,
        `${kind}: COMPACT_CAPABILITY=${COMPACT_CAPABILITY[kind]} but runCompact implemented=${implemented}`,
      ).toBe(COMPACT_CAPABILITY[kind]);
    }
  });
});
