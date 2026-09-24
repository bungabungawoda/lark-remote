/**
 * 入站消息结构占位符识别与剥离（纯函数，无 IO，便于表驱动测试）。
 *
 * 背景（P0 事故 2026-09-15）：`@larksuite/channel` 把非文本消息渲染成结构占位符，
 * 富文本（`post`）里的图片是 `![image](img_v3_…)` —— 首字符恰好是 `!`，于是被
 * `src/router/index.ts` 的裸前缀判定当成 bash 命令执行了整段消息。
 *
 * 规则来源：`docs/zh/architecture/inbound-message-matrix.md` §1 的 22 种 message_type
 * 实测渲染串（`@larksuite/channel@0.7.1`）。判定顺序**先清洗后判语义**：任何前缀
 * 判定都必须发生在剥离之后。
 *
 * 取舍（有意为之）：剥离对所有消息生效，所以用户在**纯文本**消息里手打
 * `![image](…)` / `<file key="…"/>` 这类字面量也会被当成占位符剥掉。代价是极少数
 * 「讨论本工具自身语法」的消息会丢片段；换来的是任何入口都不可能把占位符当命令
 * （P0 事故正是 `![image](img_v3_…)` 的首字符 `!` 命中 bash 判定）。
 */

export type PlaceholderKind =
  | 'image'
  | 'file'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'share'
  | 'location'
  | 'folder'
  | 'vote'
  | 'todo'
  | 'meeting'
  | 'calendar'
  | 'hongbao'
  | 'forwarded'
  | 'unsupported'
  | 'unknown';

export interface StripResult {
  /** 剥离占位符后的文本（trim 后；forwarded 块只剥标签、保留内部文本）。 */
  clean: string;
  /** 命中的占位符种类（去重、保序），用于 rejected 回执与排障。 */
  kinds: PlaceholderKind[];
  /** 未知标签（未来 SDK 新增）——必须 warn，防止再次静默漏。 */
  unknownTags: string[];
}

/**
 * 可下载资源类占位符：这些占位符对应的资源会由媒体通道下载落盘，
 * 因此文本侧不把它们记成「不支持」（否则图文混排会双重报错）。
 */
const DOWNLOADABLE_KINDS: ReadonlySet<PlaceholderKind> = new Set<PlaceholderKind>([
  'image',
  'file',
  'video',
  'audio',
  'sticker',
]);

export function isDownloadablePlaceholder(kind: PlaceholderKind): boolean {
  return DOWNLOADABLE_KINDS.has(kind);
}

/** 协议块哨兵：`<attachments>` 是本项目自己生成的 prompt 附件块，剥离时必须原样保留。 */
const ATTACHMENT_BLOCK_RE = /<attachments>[\s\S]*?<\/attachments>/g;
const SENTINEL_PREFIX = '\u0000lark-inbound-att-';
const SENTINEL_SUFFIX = '\u0000';

/** 自闭合标签 → kind（`<file key="…" name="…"/>` 等，属性可缺省）。 */
const SELF_CLOSING_RULES: ReadonlyArray<readonly [RegExp, PlaceholderKind]> = [
  [/<file(?:\s[^<>]*)?\/>/g, 'file'],
  [/<video(?:\s[^<>]*)?\/>/g, 'video'],
  [/<audio(?:\s[^<>]*)?\/>/g, 'audio'],
  [/<sticker(?:\s[^<>]*)?\/>/g, 'sticker'],
  [/<group_card(?:\s[^<>]*)?\/>/g, 'share'],
  [/<contact_card(?:\s[^<>]*)?\/>/g, 'share'],
  [/<location(?:\s[^<>]*)?\/>/g, 'location'],
  [/<folder(?:\s[^<>]*)?\/>/g, 'folder'],
  [/<hongbao(?:\s[^<>]*)?\/>/g, 'hongbao'],
];

/** 整块剥离（含内部内容）的容器标签：内容无用户语义，只作噪声。 */
const BLOCK_RULES: ReadonlyArray<readonly [RegExp, PlaceholderKind]> = [
  [/<vote>[\s\S]*?<\/vote>/g, 'vote'],
  [/<todo>[\s\S]*?<\/todo>/g, 'todo'],
  [/<meeting>[\s\S]*?<\/meeting>/g, 'meeting'],
  [/<calendar_invite>[\s\S]*?<\/calendar_invite>/g, 'calendar'],
  [/<calendar_share>[\s\S]*?<\/calendar_share>/g, 'calendar'],
  [/<calendar>[\s\S]*?<\/calendar>/g, 'calendar'],
];

/** 图片渲染串：`![image](img_v3_…)` / `![]()`,富文本内嵌图与纯 image 消息同形。 */
const IMAGE_MD_RE = /!\[(?:image)?\]\([^)]*\)/g;

/**
 * 合并转发：只剥标签、保留内部文本（子消息文本有语义）。
 * `@larksuite/channel@0.4.1+` 在子消息抓取重试耗尽后渲染
 * `<forwarded_messages status="fetch_failed"/>`（带属性、自闭合）——属性段必须
 * 一起吃掉，否则落到「未知标签」分支，被判为 unsupported 并污染排障日志。
 */
const FORWARDED_TAG_RE = /<\/?forwarded_messages(?:\s[^<>]*)?\/?>/g;

/** 提及标签：保留内部显示名，不作为占位符上报。 */
const AT_TAG_RE = /<at(?:\s[^<>]*)?>([\s\S]*?)<\/at>/g;

/** converter 的降级态（缺 key / 未识别类型 —— 都是纯噪声）。 */
const BRACKET_FALLBACK_RE =
  /\[(?:unsupported message|rich text message|interactive card|image|file|video|audio|sticker|system message|folder)\]/g;

/**
 * 未知标签兜底：只在「有属性」或「成对闭合」时才剥离。
 * 要求有属性可显著降低误伤——用户正文里的 `<3`、`a < b`、`<div>` 不会被吃掉。
 */
const UNKNOWN_SELF_CLOSING_RE = /<([a-z][a-z0-9_]*)\s[^<>]*\/>/g;
const UNKNOWN_PAIRED_RE = /<([a-z][a-z0-9_]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1>/g;

/** 剥离后遗留的连续空行折叠为单空行（属剥离产物，不算对用户文本加工）。 */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

export function stripPlaceholders(raw: string): StripResult {
  const kinds: PlaceholderKind[] = [];
  const unknownTags: string[] = [];
  /** 是否真的剥离过东西：没有命中时不做任何文本加工（保持用户原文）。 */
  let stripped = false;

  // 1. 先把本项目自己的 <attachments> 协议块摘出去，最后原样放回。
  const protectedBlocks: string[] = [];
  let working = raw.replace(ATTACHMENT_BLOCK_RE, (match) => {
    const token = `${SENTINEL_PREFIX}${protectedBlocks.length}${SENTINEL_SUFFIX}`;
    protectedBlocks.push(match);
    return token;
  });

  const hit = (kind: PlaceholderKind): void => {
    stripped = true;
    if (!kinds.includes(kind)) kinds.push(kind);
  };

  // 2. 图片渲染串（必须在 forwarded 标签剥离之前，覆盖块内子消息的图）。
  working = working.replace(IMAGE_MD_RE, () => {
    hit('image');
    return '';
  });

  // 3. 已知自闭合标签。
  for (const [re, kind] of SELF_CLOSING_RULES) {
    working = working.replace(re, () => {
      hit(kind);
      return '';
    });
  }

  // 4. 已知容器块（整块剥离）。
  for (const [re, kind] of BLOCK_RULES) {
    working = working.replace(re, () => {
      hit(kind);
      return '';
    });
  }

  // 5. 合并转发：只剥标签。
  working = working.replace(FORWARDED_TAG_RE, () => {
    hit('forwarded');
    return '';
  });

  // 6. 提及标签：保留显示名。
  working = working.replace(AT_TAG_RE, (_match, inner: string) => {
    stripped = true;
    return inner;
  });

  // 7. converter 降级态。
  working = working.replace(BRACKET_FALLBACK_RE, () => {
    hit('unsupported');
    return '';
  });

  // 8. 未知标签兜底（未来 SDK 新增类型）：剥离 + 记录 tag 名。
  working = working.replace(UNKNOWN_SELF_CLOSING_RE, (match, tag: string) => {
    hit('unknown');
    if (!unknownTags.includes(tag)) unknownTags.push(tag);
    return '';
  });
  working = working.replace(UNKNOWN_PAIRED_RE, (match, tag: string) => {
    hit('unknown');
    if (!unknownTags.includes(tag)) unknownTags.push(tag);
    return '';
  });

  // 9. 放回协议块。
  if (protectedBlocks.length > 0) {
    stripped = true;
    for (let i = 0; i < protectedBlocks.length; i += 1) {
      working = working.split(`${SENTINEL_PREFIX}${i}${SENTINEL_SUFFIX}`).join(protectedBlocks[i]);
    }
  }

  // 未命中任何占位符时**不做文本加工**（保留原文的连续空行等），
  // 确保 router.handle 对纯文本消息的转发与原行为逐字一致。
  const clean = stripped ? collapseBlankLines(working).trim() : working.trim();
  return { clean, kinds, unknownTags };
}
