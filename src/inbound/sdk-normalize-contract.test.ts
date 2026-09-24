/**
 * `@larksuite/channel` 归一化契约锚点。
 *
 * 这里**不 mock SDK**，直接 import 真实的 `normalize`，用合成 raw 事件跑真实
 * 归一化结果——目的是把项目对 SDK 行为的两条假设钉死：
 *
 * 1. `post` 富文本的**顶层附件区**（content JSON 里与 `zh_cn` 平级的 `files` 数组）
 *    从 0.6.0 起会产出 `{type:'file'}` resources + `<file .../>` 正文标记。
 *    这是升级 0.3.0→0.7.1 唯一净增的入站能力，也是项目媒体通道能自动接管的前提。
 * 2. 合并转发子消息抓取失败时（0.4.1+）产出带属性的自闭合标记
 *    `<forwarded_messages status="fetch_failed"/>`——`stripPlaceholders` 必须把它
 *    归到 `forwarded` 而非 `unknown`。
 *
 * 若有人降级 SDK 或 SDK 改动这两处形状，本文件先红，早于线上丢文件。
 */
import { describe, it, expect } from 'vitest';
import { normalize, type RawMessageEvent } from '@larksuite/channel';
import { stripPlaceholders } from './placeholder.js';

const BOT = { openId: 'ou_bot', name: 'bot' };

function rawPost(content: unknown): RawMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'om_post',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'post',
      create_time: '1700000000000',
      content: JSON.stringify(content),
    },
  };
}

describe('SDK 归一化契约：post 顶层附件区（0.6.0+）', () => {
  it('正文 + 顶层 files → file 资源带 fileName，folder 只留标记不产资源', async () => {
    const msg = await normalize(
      rawPost({
        zh_cn: { title: '报告', content: [[{ tag: 'text', text: '看一下附件' }]] },
        files: [
          { file_key: 'file_v3_a', file_name: 'report.pdf' },
          { file_key: 'file_v3_b', file_name: 'notes.txt' },
          { file_key: 'file_v3_c', file_name: 'folder', is_folder: true },
        ],
      }),
      { botIdentity: BOT },
    );

    expect(msg.rawContentType).toBe('post');
    expect(msg.resources).toEqual([
      { type: 'file', fileKey: 'file_v3_a', fileName: 'report.pdf' },
      { type: 'file', fileKey: 'file_v3_b', fileName: 'notes.txt' },
    ]);
    expect(msg.content).toContain('<file key="file_v3_a" name="report.pdf"/>');
    expect(msg.content).toContain('<folder key="file_v3_c" name="folder"/>');
  });

  it('纯附件（无正文）也产资源——不再整体降级成 [rich text message]', async () => {
    const msg = await normalize(
      rawPost({ files: [{ file_key: 'file_v3_only', file_name: 'only.zip' }] }),
      { botIdentity: BOT },
    );

    expect(msg.resources).toEqual([
      { type: 'file', fileKey: 'file_v3_only', fileName: 'only.zip' },
    ]);
    expect(msg.content).not.toContain('rich text message');
  });

  it('产出的标记被 stripPlaceholders 归为可下载 file，文本侧保留正文', async () => {
    const msg = await normalize(
      rawPost({
        zh_cn: { title: 'T', content: [[{ tag: 'text', text: '正文' }]] },
        files: [{ file_key: 'file_v3_x', file_name: 'a.pdf' }],
      }),
      { botIdentity: BOT },
    );
    const stripped = stripPlaceholders(msg.content);

    expect(stripped.clean).toBe('**T**\n\n正文');
    expect(stripped.kinds).toEqual(['file']);
    expect(stripped.unknownTags).toEqual([]);
  });
});

describe('SDK 归一化契约：合并转发抓取失败标记（0.4.1+）', () => {
  it('子消息抓取抛错 → 带属性自闭合标记，且被判为 forwarded 而非 unknown', async () => {
    const msg = await normalize(
      {
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
        message: {
          message_id: 'om_mf',
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          message_type: 'merge_forward',
          create_time: '1700000000000',
          content: '{}',
        },
      },
      {
        botIdentity: BOT,
        fetchSubMessages: () => Promise.reject(new Error('boom')),
      },
    );

    expect(msg.content).toBe('<forwarded_messages status="fetch_failed"/>');
    const stripped = stripPlaceholders(msg.content);
    expect(stripped.clean).toBe('');
    expect(stripped.kinds).toEqual(['forwarded']);
    expect(stripped.unknownTags).toEqual([]);
  });
});
