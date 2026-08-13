import { describe, it, expect } from 'vitest';
import { getConfigBuilder, listRegisteredAgents, sortAgentsByAvailability } from './index.js';
import { ClaudeConfigBuilder } from './claude.js';
import { CodexConfigBuilder } from './codex.js';
import { OpencodeConfigBuilder } from './opencode.js';
import { PiConfigBuilder } from './pi.js';
import { KimiConfigBuilder } from './kimi.js';
import { buildConfigCardFromTabs, type ConfigTab } from './common/render.js';
import type { AppConfig } from '../../config/index.js';
import { AppConfigSchema } from '../../config/index.js';

/** Build a minimal valid AppConfig for testing. */
function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    ...overrides,
  });
}

describe('router/config registry', () => {
  it('listRegisteredAgents returns all 5 agent kinds', () => {
    const agents = listRegisteredAgents();
    expect(agents).toContain('claude');
    expect(agents).toContain('codex');
    expect(agents).toContain('opencode');
    expect(agents).toContain('pi');
    expect(agents).toContain('kimi');
    expect(agents).toHaveLength(5);
  });

  it('getConfigBuilder returns the correct builder class for each agent', () => {
    expect(getConfigBuilder('claude')).toBeInstanceOf(ClaudeConfigBuilder);
    expect(getConfigBuilder('codex')).toBeInstanceOf(CodexConfigBuilder);
    expect(getConfigBuilder('opencode')).toBeInstanceOf(OpencodeConfigBuilder);
    expect(getConfigBuilder('pi')).toBeInstanceOf(PiConfigBuilder);
    expect(getConfigBuilder('kimi')).toBeInstanceOf(KimiConfigBuilder);
  });
});

describe('sortAgentsByAvailability', () => {
  it('keeps original order when every agent is available', () => {
    const input = listRegisteredAgents();
    expect(sortAgentsByAvailability(input, () => true)).toEqual(input);
  });

  it('sinks unavailable agents to the bottom, preserving order within both groups', () => {
    const availability: Record<string, boolean | undefined> = {
      claude: true,
      codex: false,
      pi: true,
      opencode: false,
      kimi: true,
    };
    const sorted = sortAgentsByAvailability(listRegisteredAgents(), (k) => availability[k]);
    expect(sorted).toEqual(['claude', 'pi', 'kimi', 'codex', 'opencode']);
  });

  it('sinks an unavailable leading agent to the bottom', () => {
    const sorted = sortAgentsByAvailability(['claude', 'codex', 'pi'], (k) => k !== 'claude');
    expect(sorted).toEqual(['codex', 'pi', 'claude']);
  });

  it('treats undefined availability as not unavailable (keeps in place)', () => {
    const input = listRegisteredAgents();
    expect(sortAgentsByAvailability(input, () => undefined)).toEqual(input);
  });

  it('does not mutate the input array', () => {
    const input = listRegisteredAgents();
    const snapshot = [...input];
    sortAgentsByAvailability(input, (k) => k === 'kimi');
    expect(input).toEqual(snapshot);
  });
});

describe('router/config common/render', () => {
  it('buildConfigCardFromTabs produces schema 2.0 structure', () => {
    const config = makeConfig();
    const tabs: ConfigTab[] = [
      {
        id: 'test-tab',
        label: 'Test Section',
        fields: [
          { key: 'test.toggle', label: 'Toggle', type: 'boolean' },
          { key: 'test.select', label: 'Select', type: 'select', options: ['a', 'b'] },
          { key: 'test.input', label: 'Input', type: 'input' },
        ],
      },
    ];
    const card = buildConfigCardFromTabs(tabs, config);

    expect(card).toHaveProperty('schema', '2.0');
    expect(card).toHaveProperty('config');
    expect(card).toHaveProperty('header');
    expect(card).toHaveProperty('body');
    expect((card as { body: { elements: unknown[] } }).body.elements).toBeDefined();
  });

  it('buildConfigCardFromTabs includes save button with callback behavior', () => {
    const config = makeConfig();
    const tabs: ConfigTab[] = [
      {
        id: 'tab1',
        label: 'Section',
        fields: [{ key: 'test.toggle', label: 'Toggle', type: 'boolean' }],
      },
    ];
    const card = buildConfigCardFromTabs(tabs, config) as {
      body: { elements: unknown[] };
    };
    const elements = card.body.elements;
    // Last element should be the save button
    const lastElement = elements[elements.length - 1] as {
      tag: string;
      behaviors: Array<{ type: string; value: { cmd: string } }>;
    };
    expect(lastElement.tag).toBe('button');
    expect(lastElement.behaviors[0].value.cmd).toBe('config.save');
  });

  it('200861 iron law: no V1 action container in rendered config card', () => {
    const config = makeConfig();
    const tabs: ConfigTab[] = [
      {
        id: 'tab1',
        label: 'Agent',
        fields: [
          { key: 'test.toggle', label: 'Toggle', type: 'boolean' },
          { key: 'test.select', label: 'Select', type: 'select', options: ['a', 'b', 'c'] },
          { key: 'test.input', label: 'Input', type: 'input' },
        ],
      },
    ];
    const card = buildConfigCardFromTabs(tabs, config);
    const json = JSON.stringify(card);
    // 200861: CardKit 2.0 cards must NOT contain V1 `tag:"action"` containers
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('boolean field renders toggle button with callback behavior', () => {
    const config = makeConfig();
    const tabs: ConfigTab[] = [
      {
        id: 'tab1',
        label: 'Section',
        fields: [{ key: 'output.showThinking', label: 'Show Thinking', type: 'boolean' }],
      },
    ];
    const card = buildConfigCardFromTabs(tabs, config) as {
      body: { elements: unknown[] };
    };
    // Find the column_set element (boolean field)
    const columnSet = card.body.elements.find(
      (e) => (e as { tag?: string }).tag === 'column_set',
    ) as {
      columns: Array<{
        elements: Array<{
          tag?: string;
          behaviors?: Array<{ type: string; value: { cmd: string; key: string } }>;
        }>;
      }>;
    };
    expect(columnSet).toBeDefined();
    // Second column should contain a button
    const button = columnSet.columns[1].elements[0] as {
      tag: string;
      behaviors: Array<{ type: string; value: { cmd: string; key: string } }>;
    };
    expect(button.tag).toBe('button');
    expect(button.behaviors[0].value.cmd).toBe('config.toggle');
    expect(button.behaviors[0].value.key).toBe('output.showThinking');
  });

  it('select field renders select_static with callback behavior', () => {
    const config = makeConfig();
    const tabs: ConfigTab[] = [
      {
        id: 'tab1',
        label: 'Section',
        fields: [
          {
            key: 'claude.model',
            label: 'Model',
            type: 'select',
            options: ['opus', 'sonnet'],
          },
        ],
      },
    ];
    const card = buildConfigCardFromTabs(tabs, config) as {
      body: { elements: unknown[] };
    };
    const columnSet = card.body.elements.find(
      (e) => (e as { tag?: string }).tag === 'column_set',
    ) as {
      columns: Array<{
        elements: Array<{
          tag?: string;
          behaviors?: Array<{ type: string; value: { cmd: string; key: string } }>;
        }>;
      }>;
    };
    const select = columnSet.columns[1].elements[0] as {
      tag: string;
      behaviors: Array<{ type: string; value: { cmd: string; key: string } }>;
    };
    expect(select.tag).toBe('select_static');
    expect(select.behaviors[0].value.cmd).toBe('config.set');
    expect(select.behaviors[0].value.key).toBe('claude.model');
  });

  it('input field renders input with callback behavior', () => {
    const config = makeConfig();
    const tabs: ConfigTab[] = [
      {
        id: 'tab1',
        label: 'Section',
        fields: [{ key: 'custom.field', label: 'Custom', type: 'input' }],
      },
    ];
    const card = buildConfigCardFromTabs(tabs, config) as {
      body: { elements: unknown[] };
    };
    const columnSet = card.body.elements.find(
      (e) => (e as { tag?: string }).tag === 'column_set',
    ) as {
      columns: Array<{
        elements: Array<{
          tag?: string;
          name?: string;
          behaviors?: Array<{ type: string; value: { cmd: string; key: string } }>;
        }>;
      }>;
    };
    const input = columnSet.columns[1].elements[0] as {
      tag: string;
      name: string;
      behaviors: Array<{ type: string; value: { cmd: string; key: string } }>;
    };
    expect(input.tag).toBe('input');
    expect(input.name).toBe('custom.field');
    expect(input.behaviors[0].value.cmd).toBe('config.input');
  });
});

describe('ClaudeConfigBuilder', () => {
  it('buildFields returns model and effort fields', () => {
    const builder = new ClaudeConfigBuilder();
    const config = makeConfig();
    const fields = builder.buildFields(config);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('claude.model');
    expect(keys).toContain('claude.effort');
    // Should have model select + custom model input + effort select
    expect(fields.length).toBeGreaterThanOrEqual(2);
  });

  it('handleFieldChange returns the change as-is (no dependent fields)', () => {
    const builder = new ClaudeConfigBuilder();
    const config = makeConfig();
    const patches = builder.handleFieldChange('claude.model', 'sonnet', config);
    expect(patches).toEqual([{ key: 'claude.model', value: 'sonnet' }]);
  });
});
