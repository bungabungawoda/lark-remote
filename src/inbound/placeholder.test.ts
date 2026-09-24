/**
 * 占位符剥离表驱动测试。
 *
 * 输入串直接取自 `docs/zh/architecture/inbound-message-matrix.md` §1 的
 * `@larksuite/channel@0.7.1` 实测渲染结果（22 种 message_type + post
 * 顶层附件区 / 合并转发抓取失败态两个增量变体）。
 * 这是 B1（P0 安全）的守护测试：任何以占位符开头的消息都不能被当成命令判据。
 */
import { describe, it, expect } from 'vitest';
import { stripPlaceholders, isDownloadablePlaceholder } from './placeholder.js';

describe('stripPlaceholders 全类型矩阵（matrix §1 实测渲染串）', () => {
  const cases: Array<{
    name: string;
    raw: string;
    clean: string;
    kinds: string[];
  }> = [
    { name: 'text', raw: 'hello world', clean: 'hello world', kinds: [] },
    {
      name: 'image',
      raw: '![image](img_v2_a)',
      clean: '',
      kinds: ['image'],
    },
    {
      name: 'file',
      raw: '<file key="file_v2_b" name="report.pdf"/>',
      clean: '',
      kinds: ['file'],
    },
    {
      name: 'post（含图）',
      raw: '**T**\n\n看这张图 ![image](img_v2_c)',
      clean: '**T**\n\n看这张图',
      kinds: ['image'],
    },
    { name: 'post（纯文字）', raw: '纯文字富文本', clean: '纯文字富文本', kinds: [] },
    {
      name: 'media（视频）',
      raw: '<video key="file_v2_d" name="1755000000.mp4" duration="80.9s"/>',
      clean: '',
      kinds: ['video'],
    },
    {
      name: 'media（无 file_name）',
      raw: '<video key="file_v2_e" duration="80.9s"/>',
      clean: '',
      kinds: ['video'],
    },
    {
      name: 'audio（语音）',
      raw: '<audio key="file_v2_f" duration="3s"/>',
      clean: '',
      kinds: ['audio'],
    },
    { name: 'sticker（表情）', raw: '<sticker key="file_v2_g"/>', clean: '', kinds: ['sticker'] },
    {
      name: 'merge_forward（已渲染子消息）',
      raw: '<forwarded_messages>\n[2026-09-15T10:00:00+08:00] 张三:\n    hello\n    ![image](img_v2_h)\n</forwarded_messages>',
      clean: '[2026-09-15T10:00:00+08:00] 张三:\n    hello',
      kinds: ['image', 'forwarded'],
    },
    {
      name: 'merge_forward（能力缺失降级态）',
      raw: '<forwarded_messages/>',
      clean: '',
      kinds: ['forwarded'],
    },
    {
      name: 'merge_forward（子消息抓取失败态，0.4.1+ 带属性自闭合）',
      raw: '<forwarded_messages status="fetch_failed"/>',
      clean: '',
      kinds: ['forwarded'],
    },
    {
      name: 'post（富文本顶层附件区，0.6.0+）',
      raw: '**T**\n\n看一下附件\n<file key="file_v3_a" name="report.pdf"/>\n<folder key="file_v3_b" name="folder"/>',
      clean: '**T**\n\n看一下附件',
      kinds: ['file', 'folder'],
    },
    { name: 'interactive', raw: '[interactive card]', clean: '', kinds: ['unsupported'] },
    {
      name: 'folder',
      raw: '<folder key="file_v2_i" name="myfolder"/>',
      clean: '',
      kinds: ['folder'],
    },
    { name: 'share_chat', raw: '<group_card id="oc_x"/>', clean: '', kinds: ['share'] },
    { name: 'share_user', raw: '<contact_card id="ou_x"/>', clean: '', kinds: ['share'] },
    {
      name: 'location',
      raw: '<location name="公司" coords="lat:1,lng:2"/>',
      clean: '',
      kinds: ['location'],
    },
    { name: 'system（撤回）', raw: '撤回了一条消息', clean: '撤回了一条消息', kinds: [] },
    {
      name: 'vote',
      raw: '<vote>\n午饭吃啥\n• 面\n• 饭\n</vote>',
      clean: '',
      kinds: ['vote'],
    },
    { name: 'todo', raw: '<todo>\n[todo]\n</todo>', clean: '', kinds: ['todo'] },
    {
      name: 'video_chat',
      raw: '<meeting>\n📹 周会\n</meeting>',
      clean: '',
      kinds: ['meeting'],
    },
    {
      name: 'calendar',
      raw: '<calendar_invite>\n📅 会议\n</calendar_invite>',
      clean: '',
      kinds: ['calendar'],
    },
    { name: 'hongbao', raw: '<hongbao text="恭喜发财"/>', clean: '', kinds: ['hongbao'] },
    { name: '未知类型降级态', raw: '[unsupported message]', clean: '', kinds: ['unsupported'] },
    { name: 'image 缺 key', raw: '[image]', clean: '', kinds: ['unsupported'] },
    { name: 'sticker 缺 key', raw: '[sticker]', clean: '', kinds: ['unsupported'] },
  ];

  for (const c of cases) {
    it(`${c.name}: ${JSON.stringify(c.raw.slice(0, 40))}`, () => {
      const result = stripPlaceholders(c.raw);
      expect(result.clean).toBe(c.clean);
      expect(result.kinds).toEqual(c.kinds);
      expect(result.unknownTags).toEqual([]);
    });
  }
});

describe('stripPlaceholders 顺序与语义', () => {
  it('图在前与图在后剥离结果相同（图/文任意顺序等价的前提）', () => {
    const before = stripPlaceholders('![image](img_v3_x) \n test');
    const after = stripPlaceholders('test \n ![image](img_v3_x)');
    expect(before.clean).toBe('test');
    expect(after.clean).toBe('test');
  });

  it('剥离后遗留的连续空行折叠为单空行', () => {
    expect(stripPlaceholders('A\n\n![image](img_x)\n\nB').clean).toBe('A\n\nB');
  });

  it('未知标签：剥离 + 记录 tag 名（防未来 SDK 新增类型静默漏）', () => {
    const result = stripPlaceholders('<newcard key="v3_x"/>\n你好');
    expect(result.clean).toBe('你好');
    expect(result.kinds).toEqual(['unknown']);
    expect(result.unknownTags).toEqual(['newcard']);
  });

  it('未知成对标签整块剥离', () => {
    const result = stripPlaceholders('<newwidget kind="x">内部噪声</newwidget>\n正文');
    expect(result.clean).toBe('正文');
    expect(result.unknownTags).toEqual(['newwidget']);
  });

  it('自己的 <attachments> 协议块原样保留（否则 agent 会丢附件路径）', () => {
    const prompt = 'test\n\n<attachments>\n  <file path="/a/b.png" kind="image"/>\n</attachments>';
    const result = stripPlaceholders(prompt);
    expect(result.clean).toBe(prompt);
    expect(result.kinds).toEqual([]);
  });

  it('@提及标签保留显示名', () => {
    expect(stripPlaceholders('<at user_id="ou_x">张三</at> 你好').clean).toBe('张三 你好');
  });

  it('不误伤用户正文（数学符号 / 无属性标签 / markdown 图片链接）', () => {
    expect(stripPlaceholders('a < b && c > d').clean).toBe('a < b && c > d');
    expect(stripPlaceholders('<div>').clean).toBe('<div>');
    expect(stripPlaceholders('3 < 5').clean).toBe('3 < 5');
    expect(stripPlaceholders('![我的图](https://example.com/a.png)').clean).toBe(
      '![我的图](https://example.com/a.png)',
    );
  });

  it('kinds 去重且保序', () => {
    const result = stripPlaceholders('![image](a)\n![image](b)\n<sticker key="c"/>');
    expect(result.kinds).toEqual(['image', 'sticker']);
  });

  it('可下载占位符判定与媒体通道一致', () => {
    expect(
      ['image', 'file', 'video', 'audio', 'sticker'].map((k) =>
        isDownloadablePlaceholder(k as never),
      ),
    ).toEqual([true, true, true, true, true]);
    expect(
      ['share', 'location', 'folder', 'vote', 'unsupported', 'unknown'].map((k) =>
        isDownloadablePlaceholder(k as never),
      ),
    ).toEqual([false, false, false, false, false, false]);
  });
});
