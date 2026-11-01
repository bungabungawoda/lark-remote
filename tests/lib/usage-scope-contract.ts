/**
 * 跨 reader 的 usage scope 契约断言。
 *
 * 每个 agent 的 session 格式不同（claude jsonl / pi jsonl / kimi wire /
 * opencode export / dsh session-page），但卡片上的三个 scope 必须一致：
 * - flow（Input/Output）= 末个 turn 内所有模型请求之和
 * - context = 末次采样水位（不求和）
 * - cumulative = 整个会话之和
 *
 * 各 reader 的回归测试用同一个断言函数，避免“每个 agent 各写一套期望值”
 * 把错误语义固化成测试基线。
 */
import { expect } from 'vitest';
import type { AgentSessionUsage } from '../../src/session-contract.js';

export interface RunUsageScopeExpectation {
  flowInput: number;
  flowOutput: number;
  contextLength: number;
  cumulativeInput: number;
  cumulativeOutput: number;
}

export function expectRunUsageScope(
  usage: AgentSessionUsage | undefined,
  expected: RunUsageScopeExpectation,
): void {
  expect(usage).toBeDefined();
  expect(usage!.inputTokens).toBe(expected.flowInput);
  expect(usage!.outputTokens).toBe(expected.flowOutput);
  expect(usage!.contextLength).toBe(expected.contextLength);
  expect(usage!.cumulativeInputTokens).toBe(expected.cumulativeInput);
  expect(usage!.cumulativeOutputTokens).toBe(expected.cumulativeOutput);
  // 「本 run ≤ 累计」是硬不变量；违反说明两侧 scope 混用。
  expect(usage!.inputTokens).toBeLessThanOrEqual(usage!.cumulativeInputTokens!);
  expect(usage!.outputTokens).toBeLessThanOrEqual(usage!.cumulativeOutputTokens!);
}
