/**
 * 22 种 message_type → texts / attachments / rejected 表驱动集成矩阵。
 *
 * 输入串取自 `docs/zh/architecture/inbound-message-matrix.md` §1 的实测渲染结果；
 * 这里走 connector 的分流规则（有资源 → 媒体事件；有残文或无资源 → 文本事件）
 * 再喂给装配器，断言最终 turn 结构（DoD：关键行为有表驱动矩阵测试）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stripPlaceholders } from './placeholder.js';
import { InboundTurnAssembler } from './turn-assembler.js';
import type { InboundAttachment, InboundTurn, MediaOutcome } from './turn.js';
import type { InboundResourceKind } from '../connector/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

interface Resource {
  type: InboundResourceKind;
  fileName?: string;
}

interface Row {
  msgType: string;
  content: string;
  resources: Resource[];
  /** 媒体下载结果：ok → 落盘成附件；fail → 该资源进 rejected。 */
  media?: 'ok' | 'fail';
  /** 期望的 turn.texts */
  texts: string[];
  /** 期望的附件数量 */
  attachments: number;
  /** 期望 rejected 里出现的 reason 片段 */
  rejected: string[];
}

const rows: Row[] = [
  {
    msgType: 'text',
    content: 'hello world',
    resources: [],
    texts: ['hello world'],
    attachments: 0,
    rejected: [],
  },
  {
    msgType: 'image',
    content: '![image](img_v2_a)',
    resources: [{ type: 'image' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'file',
    content: '<file key="file_v2_b" name="report.pdf"/>',
    resources: [{ type: 'file', fileName: 'report.pdf' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'post（含图）',
    content: '**T**\n\n看这张图 ![image](img_v2_c)',
    resources: [{ type: 'image' }],
    texts: ['**T**\n\n看这张图'],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'post（纯文字）',
    content: '纯文字富文本',
    resources: [],
    texts: ['纯文字富文本'],
    attachments: 0,
    rejected: [],
  },
  {
    msgType: 'media',
    content: '<video key="file_v2_d" name="1755000000.mp4" duration="80.9s"/>',
    resources: [{ type: 'video', fileName: '1755000000.mp4' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'video',
    content: '<video key="file_v2_e" name="a.mp4"/>',
    resources: [{ type: 'video', fileName: 'a.mp4' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'media（无 file_name）',
    content: '<video key="file_v2_f" duration="80.9s"/>',
    resources: [{ type: 'video' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'audio（语音）',
    content: '<audio key="file_v2_g" duration="3s"/>',
    resources: [{ type: 'audio' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'sticker（表情）',
    content: '<sticker key="file_v2_h"/>',
    resources: [{ type: 'sticker' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'merge_forward（含图子消息）',
    content:
      '<forwarded_messages>\n[2026-09-15T10:00:00+08:00] 张三:\n    hello\n    ![image](img_v2_i)\n</forwarded_messages>',
    resources: [{ type: 'image' }],
    texts: ['[2026-09-15T10:00:00+08:00] 张三:\n    hello'],
    attachments: 1,
    rejected: [],
  },
  {
    msgType: 'merge_forward（能力缺失）',
    content: '<forwarded_messages/>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持合并转发消息'],
  },
  {
    msgType: 'merge_forward（附件下不动）',
    content:
      '<forwarded_messages>\n[2026-09-15T10:00:00+08:00] 张三:\n    hello\n</forwarded_messages>',
    resources: [{ type: 'image' }],
    media: 'fail',
    texts: ['[2026-09-15T10:00:00+08:00] 张三:\n    hello'],
    attachments: 0,
    rejected: ['下载失败'],
  },
  {
    msgType: 'interactive',
    content: '[interactive card]',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持此类消息'],
  },
  {
    msgType: 'folder',
    content: '<folder key="file_v2_j" name="myfolder"/>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持文件夹消息'],
  },
  {
    msgType: 'share_chat',
    content: '<group_card id="oc_x"/>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持名片/群分享消息'],
  },
  {
    msgType: 'share_user',
    content: '<contact_card id="ou_x"/>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持名片/群分享消息'],
  },
  {
    msgType: 'location',
    content: '<location name="公司" coords="lat:1,lng:2"/>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持位置消息'],
  },
  {
    msgType: 'system',
    content: '撤回了一条消息',
    resources: [],
    texts: ['撤回了一条消息'],
    attachments: 0,
    rejected: [],
  },
  {
    msgType: 'vote',
    content: '<vote>\n午饭吃啥\n• 面\n• 饭\n</vote>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持投票消息'],
  },
  {
    msgType: 'todo',
    content: '<todo>\n[todo]\n</todo>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持待办消息'],
  },
  {
    msgType: 'video_chat',
    content: '<meeting>\n📹 周会\n</meeting>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持视频会议消息'],
  },
  {
    msgType: 'calendar',
    content: '<calendar_invite>\n📅 会议\n</calendar_invite>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持日程消息'],
  },
  {
    msgType: 'hongbao',
    content: '<hongbao text="恭喜发财"/>',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持红包消息'],
  },
  {
    msgType: '未知类型（降级态）',
    content: '[unsupported message]',
    resources: [],
    texts: [],
    attachments: 0,
    rejected: ['暂不支持此类消息'],
  },
  {
    msgType: '未知类型（带资源）',
    content: '<newcard key="v3_x"/>',
    resources: [{ type: 'file' }],
    texts: [],
    attachments: 1,
    rejected: [],
  },
];

interface Harness {
  assembler: InboundTurnAssembler;
  commits: Array<{ turn: InboundTurn; prompt: string }>;
  receipts: string[];
}

function makeAssembler(): Harness {
  const commits: Harness['commits'] = [];
  const receipts: string[] = [];
  const assembler = new InboundTurnAssembler({
    onCommit: (turn, prompt) => {
      commits.push({ turn, prompt });
    },
    onReceipt: (_ctx, text) => {
      receipts.push(text);
    },
  });
  return { assembler, commits, receipts };
}

function attachmentFor(type: InboundResourceKind, messageId: string): InboundAttachment {
  return { path: `/tmp/20260915/${type}_file`, kind: type, sourceMsgId: messageId };
}

/** 按 connector 的分流规则驱动装配器（与 connector/index.ts 的 on('message') 一致）。 */
async function drive(row: Row): Promise<Harness> {
  const h = makeAssembler();
  const messageId = `msg-${row.msgType}`;
  const stripped = stripPlaceholders(row.content);
  const hasResources = row.resources.length > 0;

  if (hasResources) {
    const outcome: MediaOutcome =
      row.media === 'fail'
        ? { attachments: [], rejected: [] }
        : {
            attachments: row.resources.map((r) => attachmentFor(r.type, messageId)),
            rejected: [],
          };
    const promise =
      row.media === 'fail'
        ? Promise.reject(new Error('Unsupported message type (234043)'))
        : Promise.resolve(outcome);
    h.assembler.ingest({
      kind: 'media',
      userId: 'u1',
      chatId: 'c1',
      messageId,
      rawContentType: row.msgType,
      outcome: promise,
    });
  }
  if (!hasResources || stripped.clean !== '') {
    h.assembler.ingest({
      kind: 'text',
      userId: 'u1',
      chatId: 'c1',
      messageId,
      rawContentType: row.msgType,
      text: stripped.clean,
      placeholders: stripped.kinds,
      unknownTags: stripped.unknownTags,
    });
  }
  await vi.advanceTimersByTimeAsync(700);
  await vi.runAllTimersAsync();
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('入站消息矩阵（22 种 msg_type → texts / attachments / rejected）', () => {
  for (const row of rows) {
    it(`${row.msgType}`, async () => {
      const h = await drive(row);

      if (row.texts.length === 0) {
        // 无用户文本 → 只回执，不起 turn（决策 2）
        expect(h.commits).toHaveLength(0);
        expect(h.receipts).toHaveLength(1);
        for (const frag of row.rejected) expect(h.receipts[0]).toContain(frag);
        if (row.attachments === 0 && row.rejected.length === 0) {
          expect(h.receipts[0]).toContain('📎 已保存');
        }
        return;
      }

      expect(h.commits).toHaveLength(1);
      const { turn, prompt } = h.commits[0];
      expect(turn.texts).toEqual(row.texts);
      expect(turn.attachments).toHaveLength(row.attachments);
      expect(turn.rejected.map((r) => r.reason)).toHaveLength(row.rejected.length);
      for (const frag of row.rejected) {
        expect(turn.rejected.map((r) => r.reason).join('；')).toContain(frag);
      }
      // prompt 绝不含结构占位符（agent 只该看到用户文本 + 附件块）
      expect(prompt).not.toContain('file_key');
      expect(prompt).not.toContain('<video key=');
      expect(prompt).not.toContain('<file key=');
      expect(prompt).not.toContain('<sticker key=');
      expect(prompt).not.toContain('![image](');
      expect(prompt).not.toContain('<group_card');
      // 附件块只在有附件时出现
      expect(prompt.includes('<attachments>')).toBe(row.attachments > 0);
      if (row.attachments > 0) {
        expect(prompt).toContain(`kind="${row.resources[0].type}"`);
      }
    });
  }
});
