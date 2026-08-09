import { describe, expect, it } from 'vitest';
import { renderBashCard, type BashState } from './bash-renderer.js';

function makeState(overrides: Partial<BashState> = {}): BashState {
  return {
    runId: 'bash-run-1',
    terminal: 'running',
    output: '',
    stderr: '',
    exitCode: null,
    command: 'echo hello',
    ...overrides,
  };
}

describe('renderBashCard stop button', () => {
  it('test_anchor_running_bash_card_has_stop_button_bound_to_runId', () => {
    const card = renderBashCard(makeState({ runId: 'bash-run-1' }), {}) as {
      schema?: string;
      body?: {
        elements?: Array<{ tag: string; behaviors?: Array<{ value?: Record<string, string> }> }>;
      };
    };

    // CardKit 2.0: uses schema '2.0' and behaviors callback
    expect(card.schema).toBe('2.0');
    const button = card.body?.elements?.find((element) => element.tag === 'button');
    expect(button?.behaviors?.[0]?.value).toEqual({ cmd: 'stop', runId: 'bash-run-1' });
  });

  it('test_anchor_terminal_bash_card_has_no_stop_button', () => {
    for (const terminal of ['done', 'error', 'interrupted'] as const) {
      const card = renderBashCard(makeState({ terminal }), {}) as {
        body?: {
          elements?: Array<{ tag: string; behaviors?: Array<{ value?: { cmd?: string } }> }>;
        };
      };
      // 2.0: no stop button in terminal state (no button with stop cmd)
      const hasStopButton = card.body?.elements?.some(
        (element) => element.tag === 'button' && element.behaviors?.[0]?.value?.cmd === 'stop',
      );
      expect(hasStopButton).toBe(false);
    }
  });
});

// CardKit 2.0 renderer — renderBashCard2 coverage (2.0 path
// is the production default for streaming bash cards).
describe('renderBashCard2 (CardKit 2.0)', () => {
  type Card2 = {
    schema?: string;
    body?: {
      elements?: Array<
        { tag?: string; tabs?: Array<{ id?: string; label?: string }> } & Record<string, unknown>
      >;
    };
  };

  function render2(state: BashState): Card2 {
    return renderBashCard(state) as Card2;
  }

  it('produces schema 2.0 with inline output (no tabs for streaming) and no 1.x action container (regression: 200861)', () => {
    const card = render2(makeState({ output: 'hello', stderr: 'warn' }));
    const json = JSON.stringify(card);
    expect(card.schema).toBe('2.0');
    // No tabs in streaming mode - content is inline
    expect(card.body?.elements?.find((e) => e.tag === 'tabs')).toBeUndefined();
    // 200861 铁律：2.0 卡片禁止混入 1.x `tag:"action"` 容器
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('running card has stop button with 2.0 behaviors bound to runId', () => {
    const json = JSON.stringify(render2(makeState({ runId: 'bash-2-stop' })));
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"bash-2-stop"');
    expect(json).toContain('"type":"callback"');
  });

  it('terminal (done, exit 0) card has no stop button, status div, and exit-code footer', () => {
    const card = render2(makeState({ terminal: 'done', exitCode: 0, output: 'ok' }));
    const json = JSON.stringify(card);
    expect(json).not.toContain('"cmd":"stop"');
    // Status text uses div + lark_md (not 1.x tag component which is unsupported in 2.0)
    expect(json).toContain('"tag":"div"');
    expect(json).toContain('成功');
    // Exit code footer
    expect(json).toContain('退出码: 0');
  });

  it('interrupted card surfaces 已手动终止', () => {
    const json = JSON.stringify(render2(makeState({ terminal: 'interrupted', exitCode: null })));
    expect(json).toContain('已手动终止');
  });
});
