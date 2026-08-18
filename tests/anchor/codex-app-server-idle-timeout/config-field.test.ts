import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from '../../../src/config/index.js';
import { CodexConfigBuilder } from '../../../src/router/config/codex.js';

describe('Codex app-server turn idle timeout config field', () => {
  it('test_anchor_appserver_turn_idle_timeout_is_minutes_and_zero_disables', () => {
    const config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      agents: {
        codex: {
          appServer: { turnIdleTimeoutMinutes: 2 },
        },
      },
    });

    expect(config.agents?.codex?.appServer?.turnIdleTimeoutMinutes).toBe(2);

    const fields = new CodexConfigBuilder().buildFields(config);
    const field = fields.find((f) => f.key === 'agents.codex.appServer.turnIdleTimeoutMinutes');
    expect(field).toBeDefined();
    expect(field?.type).toBe('input');
    expect(field?.label).toContain('分钟');
    expect(field?.label).toContain('0');
  });
});
