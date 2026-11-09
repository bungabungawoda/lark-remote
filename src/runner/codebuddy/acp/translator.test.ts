import { describe, it, expect } from 'vitest';
import {
  approvalCommandFrom,
  approvalReasonFrom,
  CODEBUDDY_QUESTION_METHOD,
  CodebuddyAcpTranslator,
  usageFromMeta,
} from './translator.js';

/** 构造 session/update 通知 params（ envelope 与 wire 同形）。 */
function update(update: Record<string, unknown>, sessionId = 'aaaaaaaa-1111'): unknown {
  return { sessionId, update };
}

describe('CodebuddyAcpTranslator', () => {
  it('thinking 增量从 _meta 取块身份（真机形状：事件本体无 messageId）', () => {
    const t = new CodebuddyAcpTranslator();
    const events = t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The' },
        _meta: { 'codebuddy.ai/messageId': 'msg-aaa' },
      }),
    );
    const block = (events[0] as unknown as { message: { content: Array<Record<string, unknown>> } })
      .message.content[0]!;
    expect(block.type).toBe('thinking');
    expect(block.itemId).toBe('msg-aaa');
  });

  it('tool_result 从 rawOutput 对象取 .text（真机形状：{type:text,text:Stdout…}）', () => {
    const t = new CodebuddyAcpTranslator();
    t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Bash',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'ls | wc -l' },
      }),
    );
    const events = t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { type: 'text', text: 'Stdout: 0\nExit Code: 0' },
      }),
    );
    const toolResult = events.find((e) => e.type === 'user') as {
      message: { content: Array<{ type: string; content?: unknown }> };
    };
    const block = toolResult.message.content[0]!;
    expect(block.type).toBe('tool_result');
    expect(block.content).toBe('Stdout: 0\nExit Code: 0');
  });

  it("stopReason 'refusal' 透传 _meta 里的真实错误（真机：429 配额耗尽）", () => {
    const t = new CodebuddyAcpTranslator();
    const result = t.handlePromptResponse('aaaaaaaa-1111', {
      stopReason: 'refusal',
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: 6004,
          message:
            '429 usage exceeds frequency limit, your usage will reset at 2026-11-09 15:35:32',
          data: { statusCode: 429 },
        }),
      },
    }) as {
      type: string;
      subtype?: string;
      errorMessage?: string;
    };
    expect(result.type).toBe('result');
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toContain('429 usage exceeds frequency limit');
    expect(result.errorMessage).toContain('2026-11-09');
    expect(result.errorMessage).not.toContain('/compact');
    // 其余 stopReason 不受影响（end_turn → success）
    const ok = t.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'end_turn' }) as {
      subtype?: string;
    };
    expect(ok.subtype).toBe('success');
  });

  it("stopReason 'refusal' 无上游详情时不臆测原因", () => {
    const t = new CodebuddyAcpTranslator();
    const result = t.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'refusal' }) as {
      subtype?: string;
      errorMessage?: string;
    };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toContain('refusal');
    expect(result.errorMessage).toContain('未说明原因');
    expect(result.errorMessage).not.toContain('/compact');
    expect(result.errorMessage).not.toContain('模型拒答');
  });

  it('审批视图取真字段：Bash 用 rawInput.command/description，Read 用 file_path', () => {
    const t = new CodebuddyAcpTranslator();
    const bashEvents = t.handleServerRequest(11, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      toolCall: {
        toolCallId: 'tool-bash',
        rawInput: { command: 'ls | wc -l', description: '统计目录条目' },
        _meta: { 'codebuddy.ai/toolName': 'Bash' },
      },
    }) as Array<{ view?: { command?: string; reason?: string } }>;
    const bashView = bashEvents[0]!.view!;
    // command 优先真实命令（title 是带反引号的呈现串）
    expect(bashView.command).toBe('ls | wc -l');
    expect(bashView.reason).toBe('统计目录条目');

    const readEvents = t.handleServerRequest(12, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [],
      toolCall: {
        toolCallId: 'tool-read',
        rawInput: { file_path: '/home/user/proj/a.ts', limit: 18 },
      },
    }) as Array<{ view?: { command?: string; reason?: string } }>;
    const readView = readEvents[0]!.view!;
    expect(readView.command).toBe('/home/user/proj/a.ts');
  });

  it('_meta.usage 按 turn 累加（一 turn 多次模型请求不求和会低报），result 折叠真实 flow', () => {
    const t = new CodebuddyAcpTranslator();
    // 第一次模型请求（工具轮）：cache_hit 1600 / miss 33930 / completion 115
    t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'usage_update',
        used: 0,
        size: 0,
        cost: { amount: 4.94, currency: '' },
        _meta: {
          usage: {
            prompt_tokens: 35530,
            completion_tokens: 115,
            total_tokens: 35645,
            prompt_cache_hit_tokens: 1600,
            prompt_cache_miss_tokens: 33930,
          },
        },
      }),
    );
    // 第二次模型请求（收尾轮）
    t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'usage_update',
        used: 0,
        size: 0,
        _meta: {
          usage: {
            prompt_tokens: 36108,
            completion_tokens: 360,
            total_tokens: 36468,
            prompt_cache_hit_tokens: 1700,
            prompt_cache_miss_tokens: 34408,
          },
        },
      }),
    );

    const result = t.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'end_turn' }) as {
      subtype?: string;
      usage?: Record<string, number | undefined>;
    };
    expect(result.subtype).toBe('success');
    // flow = 两次请求之和；input 只算未命中缓存的 miss 部分（不与 cacheRead 双计）
    expect(result.usage?.input_tokens).toBe(33930 + 34408);
    expect(result.usage?.output_tokens).toBe(115 + 360);
    expect(result.usage?.total_tokens).toBe(35645 + 36468);
    expect(result.usage?.cache_read_tokens).toBe(1600 + 1700);
    // used/size 恒 0 → 不产出 context_limit（水位走 jsonl 兜底）
    expect(result.usage?.context_limit).toBeUndefined();
  });

  it('C4 同时带 messageId 与 _meta → 取 messageId 优先', () => {
    const t = new CodebuddyAcpTranslator();
    const events = t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The' },
        messageId: 'msg-direct',
        _meta: { 'codebuddy.ai/messageId': 'msg-meta' },
      }),
    );
    const block = (events[0] as unknown as { message: { content: Array<Record<string, unknown>> } })
      .message.content[0]!;
    expect(block.type).toBe('thinking');
    expect(block.itemId).toBe('msg-direct');
  });

  it('G5 thought chunk 无 _meta → 无 itemId', () => {
    const t = new CodebuddyAcpTranslator();
    const events = t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The' },
      }),
    );
    const block = (events[0] as unknown as { message: { content: Array<Record<string, unknown>> } })
      .message.content[0]!;
    expect(block.type).toBe('thinking');
    expect(block.itemId).toBeUndefined();
  });

  it('G5 toolCall 无 _meta → toolName 缺席，command 回退到 title / undefined', () => {
    const t = new CodebuddyAcpTranslator();
    const withTitle = t.handleServerRequest(21, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [],
      toolCall: { toolCallId: 'tc-1', rawInput: {}, title: 'FallbackTitle' },
    }) as Array<{ view?: { command?: string } }>;
    expect(withTitle[0]!.view!.command).toBe('FallbackTitle');

    const noTitle = t.handleServerRequest(22, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [],
      toolCall: { toolCallId: 'tc-2', rawInput: {} },
    }) as Array<{ view?: { command?: string } }>;
    expect(noTitle[0]!.view!.command).toBeUndefined();
  });

  it('G5 _meta.toolName 非字符串 → 忽略（command 落到 undefined）', () => {
    const t = new CodebuddyAcpTranslator();
    const events = t.handleServerRequest(23, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [],
      toolCall: {
        toolCallId: 'tc-3',
        rawInput: {},
        _meta: { 'codebuddy.ai/toolName': 123 },
      },
    }) as Array<{ view?: { command?: string } }>;
    expect(events[0]!.view!.command).toBeUndefined();
  });

  it('E7 rawInput 全空 → command 落到 title/toolName（纯函数直测 + 审批视图）', () => {
    // 纯函数直测：回退链 title > toolName > undefined；reason 分支
    expect(approvalCommandFrom({}, 'TitleWins', 'Bash')).toBe('TitleWins');
    expect(approvalCommandFrom({}, undefined, 'Bash')).toBe('Bash');
    expect(approvalCommandFrom({}, undefined, undefined)).toBeUndefined();
    expect(approvalReasonFrom({})).toBeUndefined();
    expect(approvalReasonFrom({ description: '人话' })).toBe('人话');

    const t = new CodebuddyAcpTranslator();
    const withTitle = t.handleServerRequest(31, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [],
      toolCall: {
        toolCallId: 'tc-a',
        rawInput: {},
        title: 'TitleWins',
        _meta: { 'codebuddy.ai/toolName': 'Bash' },
      },
    }) as Array<{ view?: { command?: string } }>;
    expect(withTitle[0]!.view!.command).toBe('TitleWins');

    const toolNameOnly = t.handleServerRequest(32, 'session/request_permission', {
      sessionId: 'aaaaaaaa-1111',
      options: [],
      toolCall: {
        toolCallId: 'tc-b',
        rawInput: {},
        _meta: { 'codebuddy.ai/toolName': 'Read' },
      },
    }) as Array<{ view?: { command?: string } }>;
    expect(toolNameOnly[0]!.view!.command).toBe('Read');
  });

  it('G3(a) usageFromMeta: 只有 prompt_tokens_details.cached_tokens → cacheHit 取明细、input=prompt−明细', () => {
    const flow = usageFromMeta({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 300 },
    });
    expect(flow?.cacheRead).toBe(300);
    expect(flow?.input).toBe(700);
    expect(flow?.output).toBe(0);
  });

  it('G3(b) usageFromMeta: 无任何缓存字段 → input=prompt 原样、cacheRead=0', () => {
    const flow = usageFromMeta({
      prompt_tokens: 800,
      completion_tokens: 50,
      total_tokens: 850,
    });
    expect(flow?.input).toBe(800);
    expect(flow?.cacheRead).toBe(0);
    expect(flow?.output).toBe(50);
  });

  it('G3(c) 无 _meta.usage → 不累计、result 无 usage（走 onUsageSample 层）', () => {
    // 公开路径：基类 handleUsageUpdate 会占一个 usage 位，但 CodeBuddy flow 一个字段都不能累加
    const t = new CodebuddyAcpTranslator();
    t.handleNotification(
      'session/update',
      update({ sessionUpdate: 'usage_update', used: 0, size: 0 }),
    );
    const viaPublic = t.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'end_turn' }) as {
      usage?: Record<string, number | undefined>;
    };
    expect(viaPublic.usage?.input_tokens).toBeUndefined();
    expect(viaPublic.usage?.output_tokens).toBeUndefined();
    expect(viaPublic.usage?.cache_read_tokens).toBeUndefined();

    // 直调 onUsageSample 层：绕过基类占位，hasLiveUsage 不被点亮 → result 彻底无 usage
    const direct = new CodebuddyAcpTranslator();
    (direct as unknown as { onUsageSample(e: unknown): void }).onUsageSample({
      sessionUpdate: 'usage_update',
      used: 0,
      size: 0,
    });
    const result = direct.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'end_turn' }) as {
      usage?: Record<string, number | undefined>;
    };
    expect(result.usage).toBeUndefined();
  });

  it('G3(d) usage_update size>0 → context_limit = size', () => {
    const t = new CodebuddyAcpTranslator();
    t.handleNotification(
      'session/update',
      update({
        sessionUpdate: 'usage_update',
        used: 0,
        size: 200000,
        _meta: {
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        },
      }),
    );
    const result = t.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'end_turn' }) as {
      usage?: Record<string, number | undefined>;
    };
    expect(result.usage?.context_limit).toBe(200000);
  });

  describe('边界输入钉死（mutator 复跑补强）', () => {
    function thinkingBlock(extra: Record<string, unknown>): Record<string, unknown> {
      const t = new CodebuddyAcpTranslator();
      const events = t.handleNotification(
        'session/update',
        update({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'The' },
          ...extra,
        }),
      );
      return (
        events[0] as unknown as {
          message: { content: Array<Record<string, unknown>> };
        }
      ).message.content[0]!;
    }

    function toolResult(rawOutput: unknown): unknown {
      const t = new CodebuddyAcpTranslator();
      return (
        t as unknown as { extractToolResultContent(e: { rawOutput: unknown }): unknown }
      ).extractToolResultContent({ rawOutput });
    }

    /** 直调 onUsageSample，绕过基类 usage 占位，只观察 live usage 是否点亮。 */
    function usageAfterSamples(
      samples: Array<Record<string, unknown>>,
    ): Record<string, number | undefined> | undefined {
      const t = new CodebuddyAcpTranslator();
      for (const sample of samples) {
        (t as unknown as { onUsageSample(e: unknown): void }).onUsageSample({
          sessionUpdate: 'usage_update',
          used: 0,
          size: 0,
          ...sample,
        });
      }
      return (
        t.handlePromptResponse('aaaaaaaa-1111', { stopReason: 'end_turn' }) as {
          usage?: Record<string, number | undefined>;
        }
      ).usage;
    }

    it('thinking 块身份：空 messageId 不回退 _meta；_meta 非字符串/空串不产生 itemId', () => {
      expect(
        thinkingBlock({ messageId: '', _meta: { 'codebuddy.ai/messageId': 'msg-meta' } }).itemId,
      ).toBeUndefined();
      expect(thinkingBlock({ _meta: { 'codebuddy.ai/messageId': 123 } }).itemId).toBeUndefined();
      expect(thinkingBlock({ _meta: { 'codebuddy.ai/messageId': '' } }).itemId).toBeUndefined();
    });

    it('tool_result rawOutput：对象取 text / 字符串原样 / null 与空对象回退空串', () => {
      expect(toolResult({ type: 'text', text: 'Stdout: ok' })).toBe('Stdout: ok');
      expect(toolResult('plain output')).toBe('plain output');
      expect(toolResult(null)).toBe('');
      expect(toolResult({})).toBe('');
    });

    it('usage_update：size=1 透出 context_limit；cacheRead=0 不渲染 0 值行，=1 时透出', () => {
      const withSize = usageAfterSamples([
        {
          size: 1,
          _meta: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        },
      ]);
      expect(withSize?.context_limit).toBe(1);
      expect(withSize?.input_tokens).toBe(10);
      expect(withSize?.cache_read_tokens).toBeUndefined();

      const withCache = usageAfterSamples([
        {
          _meta: {
            usage: {
              prompt_tokens: 10,
              prompt_cache_hit_tokens: 1,
              prompt_cache_miss_tokens: 9,
              completion_tokens: 2,
              total_tokens: 12,
            },
          },
        },
      ]);
      expect(withCache?.cache_read_tokens).toBe(1);
      expect(withCache?.context_limit).toBeUndefined();
    });

    it('_meta.usage 非对象时不点亮 live usage（类型防御）', () => {
      expect(usageAfterSamples([{ _meta: { usage: 'broken' } }])).toBeUndefined();
      expect(usageAfterSamples([{ _meta: { usage: 12 } }])).toBeUndefined();
    });

    it('usageFromMeta：非有限数值按 0；全部命中缓存时 input=0', () => {
      expect(usageFromMeta({ prompt_tokens: Number.NaN })).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        total: 0,
      });
      expect(usageFromMeta({ prompt_tokens: Number.POSITIVE_INFINITY })).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        total: 0,
      });
      const allCached = usageFromMeta({ prompt_tokens: 100, prompt_cache_hit_tokens: 100 });
      expect(allCached.input).toBe(0);
      expect(allCached.cacheRead).toBe(100);
    });

    it('approvalReasonFrom：无 description 时序列化 rawInput（单键也算非空）', () => {
      expect(approvalReasonFrom({ command: 'ls' })).toBe('{"command":"ls"}');
      expect(approvalReasonFrom({})).toBeUndefined();
    });
  });
});

/**
 * 401 打标：runner 用它释放长驻连接，bridge 用它清目录/会话/runner 槽位。
 * 文本脱敏合成（不含真 token / 真代理地址）。
 */
describe('CodebuddyAcpTranslator 身份失效打标', () => {
  it('上游 _meta 里的 401 → result event 带 authFailure', () => {
    const t = new CodebuddyAcpTranslator();
    const event = t.handlePromptResponse('sess-1', {
      stopReason: 'refusal',
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: 401,
          message:
            '401 Authentication required. Please use /login command to sign in to your account',
        }),
      },
    });
    expect(event).toMatchObject({ type: 'result', subtype: 'error', authFailure: true });
  });

  it('真机回放：未登录 -32000 + category:auth → result event 带 authFailure', () => {
    const t = new CodebuddyAcpTranslator();
    const event = t.handlePromptResponse('sess-1', {
      stopReason: 'refusal',
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: -32000,
          message: 'Authentication required',
          data: {
            details:
              'Authentication required. Please use /login command to sign in to your account',
            category: 'auth',
          },
        }),
      },
    });
    expect(event).toMatchObject({
      type: 'result',
      subtype: 'error',
      authFailure: true,
      errorMessage: 'Authentication required',
    });
  });

  it('429 限流 / 正常结束不打标', () => {
    const t = new CodebuddyAcpTranslator();
    const limited = t.handlePromptResponse('sess-1', {
      stopReason: 'refusal',
      _meta: { 'codebuddy.ai/errorMessage': '{"code":6004,"message":"rate limited"}' },
    });
    expect(limited).toMatchObject({ subtype: 'error' });
    expect(limited).not.toHaveProperty('authFailure');
    expect(t.handlePromptResponse('sess-1', { stopReason: 'end_turn' })).not.toHaveProperty(
      'authFailure',
    );
  });

  it('JSON-RPC 直接抛错的 401 文本也打标', () => {
    const t = new CodebuddyAcpTranslator();
    expect(t.produceErrorResult('sess-1', '401 Unauthorized')).toMatchObject({
      subtype: 'error',
      authFailure: true,
    });
    expect(t.produceErrorResult('sess-1', 'DSH HTTP 401 for session.create')).not.toHaveProperty(
      'authFailure',
    );
  });
});

/**
 * CodeBuddy ACP 的 AskUserQuestion 走 `_codebuddy.ai/question` 反向 RPC。
 * 入参每题带 q_0… 形式的 id、题干、header、options 与 multiSelect；翻译成
 * 公共 question 审批事件后，由 runner 按序号回编 answers。
 */
describe('AskUserQuestion（_codebuddy.ai/question 反向 RPC）', () => {
  const request = (questions: unknown, sessionId = 'aaaaaaaa-1111') => ({
    sessionId,
    toolCallId: 'call-q',
    inputType: 'question',
    schema: { questions },
  });

  it('结构化问题映射为 kind:question 审批事件', () => {
    const t = new CodebuddyAcpTranslator();
    const events = t.handleServerRequest(
      17,
      CODEBUDDY_QUESTION_METHOD,
      request([
        {
          id: 'q_0',
          question: 'Which database?',
          header: 'DB',
          options: [
            { label: 'PostgreSQL', description: 'Robust' },
            { label: 'SQLite', description: 'Lightweight' },
          ],
          multiSelect: false,
        },
        {
          id: 'q_1',
          question: 'Frameworks?',
          header: 'FW',
          multiSelect: true,
          options: [{ label: 'React', description: '' }],
        },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'approval_requested',
      requestId: 17,
      kind: 'question',
      threadId: 'aaaaaaaa-1111',
      view: {
        requestId: 17,
        kind: 'question',
        availableDecisions: [],
        questions: [
          {
            id: 'q_0',
            question: 'Which database?',
            header: 'DB',
            options: [
              { label: 'PostgreSQL', description: 'Robust' },
              { label: 'SQLite', description: 'Lightweight' },
            ],
          },
          {
            id: 'q_1',
            question: 'Frameworks?',
            header: 'FW',
            multiSelect: true,
            options: [{ label: 'React' }],
          },
        ],
      },
    });
    // 空 description 不落进视图（渲染层按缺省处理）。
    const view = (events[0] as { view: { questions: Array<{ options: unknown[] }> } }).view;
    expect(view.questions[1]?.options).toEqual([{ label: 'React' }]);
  });

  it('缺 schema / 空 questions / 缺题干 → 不产事件（runner 回 cancelled）', () => {
    const t = new CodebuddyAcpTranslator();
    expect(t.handleServerRequest(18, CODEBUDDY_QUESTION_METHOD, {})).toEqual([]);
    expect(
      t.handleServerRequest(18, CODEBUDDY_QUESTION_METHOD, { schema: { questions: [] } }),
    ).toEqual([]);
    expect(
      t.handleServerRequest(18, CODEBUDDY_QUESTION_METHOD, request([{ id: 'q_0', options: [] }])),
    ).toEqual([]);
  });

  it('未知扩展方法不产事件（由基类/runner 决定兜底）', () => {
    const t = new CodebuddyAcpTranslator();
    expect(t.handleServerRequest(19, '_codebuddy.ai/other', {})).toEqual([]);
  });
});
