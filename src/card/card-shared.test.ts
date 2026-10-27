import { describe, it, expect } from 'vitest';
import { agentDisplayName } from './card-shared.js';
import { AGENT_DISPLAY_NAMES, AGENT_KINDS } from '../agent-kinds.js';

/**
 * 用户可见 agent 显示名的单源验证（P0）：
 * - `AGENT_DISPLAY_NAMES` 是显示名的唯一数据源；
 * - dsh 接入后显示名必须是 `DSH`，不得退化成原始 kind 或 `Dsh`；
 * - 未知 kind 回退原始字符串。
 */
describe('agentDisplayName', () => {
  it('uses the single-source display name for dsh (DSH)', () => {
    expect(AGENT_DISPLAY_NAMES.dsh).toBe('DSH');
    expect(agentDisplayName('dsh')).toBe('DSH');
  });

  it('every agent kind has a non-empty display name', () => {
    for (const kind of AGENT_KINDS) {
      expect(AGENT_DISPLAY_NAMES[kind], kind).toBeTruthy();
    }
  });

  it('falls back to the raw kind for unknown values', () => {
    expect(agentDisplayName('mystery')).toBe('mystery');
  });
});
