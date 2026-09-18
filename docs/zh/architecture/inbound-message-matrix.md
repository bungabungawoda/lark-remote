# 入站消息分派矩阵与误判清单

> 起因：2026-09-15 用户在飞书私聊发 mp4，被当普通文本转发给 agent（prompt 变成 `<video key="…"/>` 占位符），
> agent 满盘搜索文件 10 分钟未果。排查后确认根因是**入站分派的判据维度选错**（`msg_type` 白名单，
> 而非"是否携带可下载资源"），并发现同一根因下还有一批同类漏判。
>
> 数据来源：`@larksuite/channel@0.3.0` 的 `normalize()` **实测**（构造 22 种 `message_type` 跑真实 SDK 输出），
> 非读源码推断。判定点：修复前 `src/connector/index.ts` 的入站分派分支。
> **SDK 给出的 `resources` 不等于"飞书允许下载"** —— 官方接口的硬限制见 §4（表情包、合并转发都不给下载）。

## 0. 判定点与修复前判据

```ts
// 修复前的 src/connector/index.ts 入站分派（白名单已移除，现判据为 msg.resources）
if (
  (msg.rawContentType === 'image' || msg.rawContentType === 'file') &&
  msg.resources.length > 0
) {
  void this.handleInboundMediaDetected(msg);   // 媒体通道：下载 → 落盘 → 提示路径
  return;
}
this.onMessage?.({ ... content: msg.content }); // 文本通道：content 原样成为 agent prompt
```

问题：SDK 已经把"这条消息携带哪些可下载资源"算好放在 `msg.resources`（`ResourceDescriptor[]`），
上层又用 `msg_type` 重建了一遍判断 —— **双份真相，且其中一份不完备**。
`resources[].type` 有 5 种值：`image | file | audio | video | sticker`。

正确的判据是不变量而非枚举：**agent 只能访问本地 FS，`file_key` 对它无意义 ⇒ 消息携带资源就必须先落盘变成本地路径**。
枚举 `msg_type` 会随飞书新增类型持续漏；正确形态是 default-deny（`resources` 非空默认进媒体通道，
未识别类型打 warn）。

## 1. 全类型矩阵（实测）

`走向` 列按当前代码判定；`判定` 列标注问题。

| message_type | content 渲染 | resources（实测） | 走向 | 判定 |
|---|---|---|---|---|
| `text` | `hello world` | — | TEXT | 正常 |
| `image` | `![image](img_v2_a)` | `image` | MEDIA | 正常 |
| `file` | `<file key="…" name="report.pdf"/>` | `file` + fileName | MEDIA | 正常 |
| `post`（含图） | `**T**\n\n看这张图 ![image](…)` | `image`（可多个） | TEXT | **漏资源** + 文本被转发 |
| `post`（纯文字） | `纯文字富文本` | — | TEXT | 正常（但注意与含图分支行为不一致） |
| `media` | `<video key="…" name="1755000000.mp4" duration="80.9s"/>` | `video` + fileName + coverImageKey | TEXT | **本次事故** |
| `video` | 同上（SDK 把 `video`/`media` 都注册到 `convertVideo`） | `video` | TEXT | **漏资源** |
| `media`（无 file_name） | `<video key="…" duration="80.9s"/>` | `video`，**无 fileName** | TEXT | **漏资源** + 兜底无名 |
| `audio`（语音） | `<audio key="…" duration="3s"/>` | `audio`，**无 fileName** | TEXT | **漏资源** |
| `sticker`（表情） | `<sticker key="…"/>` | `sticker`，**无 fileName** | TEXT | **不可下载**（飞书限制，见 §4） |
| `merge_forward` | 有子消息能力时渲染成 `[时间] 发送人:` + 缩进内容的树；能力缺失时 `<forwarded_messages/>` | 子消息内的资源**会被聚合进顶层 resources** | TEXT | 文本可用；**资源被丢**（见 §2 P0 #4） |
| `interactive` | `[interactive card]` | — | TEXT | 噪声 |
| `folder` | `<folder key="…" name="myfolder"/>` | `[]` | TEXT | 噪声（key 不可用 messageResource 下载） |
| `share_chat` | `<group_card id="oc_…"/>` | — | TEXT | 噪声 |
| `share_user` | `<contact_card id="ou_…"/>` | — | TEXT | 噪声 |
| `location` | `<location name="公司" coords="…"/>` | — | TEXT | 噪声 |
| `system`（撤回等） | `撤回了一条消息` | — | TEXT | 噪声（待验证飞书是否下发） |
| `vote` | `<vote>\n午饭吃啥\n• 面\n• 饭\n</vote>` | — | TEXT | 噪声 |
| `todo` | `<todo>\n[todo]\n</todo>` | — | TEXT | 噪声 |
| `video_chat` | `<meeting>\n📹 周会\n…</meeting>` | — | TEXT | 噪声 |
| `calendar` | `<calendar_invite>\n📅 会议\n</calendar_invite>` | — | TEXT | 噪声 |
| `hongbao` | `<hongbao text="恭喜发财"/>` | — | TEXT | 噪声 |
| 未知类型 | `[unsupported message]` | — | TEXT | 噪声 |
| `image`/`sticker` 无 key | `[image]` / `[sticker]` | `[]` | TEXT | 噪声（兜底降级态） |

## 2. 缺陷清单（待修）

### P0 — 资源丢失

| # | 缺陷 | 现象 | 修复要点 |
|---|---|---|---|
| 1 | `media` / `video`（视频）漏判 | 本次事故：agent 只拿到 `<video key=…/>` | 判据改 `resources.length > 0` |
| 2 | `audio`（语音）漏判 | 语音被当文本；且 resources **无 fileName** | 补齐无 fileName 的扩展名推断（按 MIME/魔数，参考 `imageExtension`） |
| 3 | `post`（富文本含图）漏判 | 图不落盘；且 content 是**真实文本**，直接套"有资源就不转发文本"会吞掉说明文字 | 该路径需「落盘路径 + 文本」**并存**注入，而非二选一。当前媒体通道是"资源消息不转发文本"的二选一模型 |
| 4 | `merge_forward` 子消息**附件**丢失 | 把含附件的聊天记录合并转发给 bot：子消息**文本**能渲染（SDK 内部注入了子消息能力，见下），但里面图片/文件的 key 只存在于 `resources` 里，因白名单不认 `merge_forward` 被整体丢弃 → agent 只看到 `![image](img_v2_…)`、`<file key="…"/>` 占位符，拿不到文件 | 两层障碍：① 白名单不认 `merge_forward`，聚合出的 `resources` 被丢；② **SDK 的 `resources` 不带 `message_id`**，而下载要求 key 与 message_id 配对（`234003`）→ 需自建子消息遍历、用**子消息自己的 message_id** 下载。能否成功受 `234043` 制约，**必须真机验证**（方案与验证步骤见 §5） |

### P1 — 一致性与闸门

| # | 缺陷 | 现象 | 修复要点 |
|---|---|---|---|
| 5 | `sticker` 漏判 | `<sticker key="…"/>` 占位符当文本进 agent | **不能按 #1 处理**：飞书明确"暂不支持获取表情包资源"，`type=file` 的说明也注明"表情包除外" → 应归「不支持类」，回提示、不进 agent（详见 §4） |
| 6 | `inboundMedia.enabled: false` 时行为不一致 | image/file 走媒体通道 → 回"已关闭"提示；**video/audio/sticker 不匹配白名单 → 直接当 prompt 转发给 agent** | 判据统一后自然消除；提示文案需从"图片/文件"改为覆盖全部资源类型 |
| 7 | 未绑定用户先发媒体 → 静默丢弃且不完成绑定 | `index.ts` 的 `setupMessageHandlers` 媒体闸门只调 `binder.isOwner()`（未绑定恒 false），文本通道有 `classify()` 的"首条任意消息即绑定"兜底，媒体通道没有 → 新实例首条消息是图/视频时**什么都不发生**，用户以为程序坏了 | 媒体闸门也用 `classify()` 走绑定判定，或未绑定时回一条引导 |
| 8 | 落盘命名对无 fileName 资源不可用 | `buildFileName` 的 file 分支：无 fileName → `file_HHmmss_n`（**无扩展名**），agent/用户无法判断格式 | 按 MIME + 魔数补扩展名（视频/音频/表情） |

### P2 — 噪声进 agent

| # | 缺陷 | 现象 |
|---|---|---|
| 9 | 结构化卡片类消息被当 prompt 转发 | `folder` / `share_chat` / `share_user` / `location` / `vote` / `todo` / `video_chat` / `calendar` / `hongbao` / `interactive` 渲染成 XML 占位文本进 agent，浪费一次 turn 甚至触发无关命令 |
| 10 | 兜底降级态无提示 | `[unsupported message]` / `[image]` / `[sticker]`（缺 key 时）纯噪声，agent 只能猜 |
| 11 | 超过 100MB 的资源必然下载失败 | `type=file` 时 >100MB 必须用 `Range` 分片下载（单次 ≤32MB），SDK 的 `downloadResourceToFile` 不做分片 → 必报 400 `234037`。当前默认上限 50MB（`DEFAULT_INBOUND_MEDIA_MAX_SIZE_MB`）不触发，但 `maxFileSizeMb` 一旦调到 >100 就会踩；提示文案也应说明"大文件目前下不动" |

> 9/10 的正确形态：识别为"不支持的消息类型"→ 回一条明确提示（"暂不支持 X 类型消息"），
> **不进 agent**，而不是把占位符当用户意图。

### 修复时必须避开的坑

1. **不要改** `handleInboundMediaDetected` 里的 `r.type === 'image' ? 'image' : 'file'`：飞书
   `im.v1.messageResource.get` 的 `type` 参数只有 `image`/`file` 两个合法值（SDK 注释：*'file' for everything else*），
   传 `'video'` 会 400。
2. `post` 不能简单归入媒体通道（见 #3），否则图文混排会丢文字。
3. 落盘侧 `InboundMediaItem.type` 只有 `'image' | 'file'` 两态，视频/音频天然落到 file 分支 —— 这对
   **下载** 是对的，但对**命名**不够（见 #8）。

## 3. 建议的修复骨架

判据从"类型白名单"改为"资源载体 + 分类处置"：

```
resources.length > 0  →  资源类：落盘 → 提示本地路径（post 额外保留文本）
resources.length === 0 且 content 是纯文本  →  文本类：现状转发
resources.length === 0 且 content 是结构化占位符  →  不支持类：回提示，不进 agent
未识别 msg_type（无论有无资源）  →  warn 日志 + 不支持提示（暴露而非静默）
```

守护测试（表驱动，覆盖上表全部 `message_type`）：
- 断言「`resources` 非空的入站消息，一律不得进入文本转发路径」；
- 断言「结构化占位符（`<xxx …/>`、`[unsupported message]`）不得成为 agent prompt」。

## 4. 飞书官方接口限制（已核实，2026-09-15）

来源：官方文档《获取消息中的资源文件》（最后更新 2026-08-27），接口
`GET /open-apis/im/v1/messages/:message_id/resources/:file_key`。

**`type` 参数只有两个合法值**，这决定了下载侧的类型映射不可扩展：

| 值 | 覆盖的消息类型 |
|---|---|
| `image` | 消息中的图片、富文本消息中的图片 |
| `file` | 消息中的文件、音频、视频（**表情包除外**） |

由此确定的硬约束：

1. **表情包（sticker）大概率不可下载** —— 文档原文「暂不支持获取表情包资源」，且 `file` 的说明里再次注明"表情包除外"。
   ⚠️ 但要注意：文档的 `type` 枚举只明确排除了 **`file`** 分支 —— `image` 的说明是"消息中的图片或富文本消息中的图片"，
   **未提及表情包**。参考项目 cc-connect 对 sticker 走的正是 `downloadImage(...)` 即 **`type=image`**，并带失败降级分支
   （`platform/feishu/feishu.go:1692-1724`；`downloadImage` 定义在 `:3022`，内部 `Type("image")`）。
   → sticker 应标为「**待实测**」：用 `type=image` 与 `type=file` 各试一次（发一个表情给 bot 即可定性），
   不要在没有实测的情况下把它写死成"不支持"，也不要按 #1 直接并进媒体通道（那会走 `type=file`，大概率失败）。
2. **合并转发（含子消息）的资源下载被列为不支持** —— 错误码 `234043 Unsupported message type` 的示例即"合并转发消息（包括子消息）、消息卡片"。
   ⚠️ 该表述的**作用域待实测**：是"用父消息 id 去下子消息的 key 会失败"，还是"子消息用自己的 message_id 也失败"？
   这个区别决定 merge_forward 附件是「可支持」还是「只能回提示」，验证方法见 §5。
3. **`file_key` 与 `message_id` 必须匹配**（错误码 `234003`）—— 不能拿父消息的 `message_id` 去下载子消息的 `file_key`。
4. **大小限制**：`type=file` 时 >100MB 需 `Range` 分片（单次 ≤32MB，需本地合并）；`type=image` 不支持分片，仅支持完整下载 <100MB。
   SDK 的 `downloadResourceToFile` 不做分片 → >100MB 必失败（`234037`）。
5. 其他会让下载失败的场景：保密消息 / 防泄密模式（`234038`）、消息对操作者不可见（`234040`）。

## 5. merge_forward 附件：支持方案与验证路径

### 5.1 先纠正一个事实（本文件早前版本的错误结论）

`LarkChannel.registerDispatcherHandlers()` 在 `normalizeOpts` 里**已经注入** `fetchSubMessages`
（实现为 `rawClient.im.v1.message.get({ message_id })`，见 `dist/index.mjs:3791-3805`，另 `fetchMessage()` 3731 行也有）。
所以生产链路上合并转发的子消息**文本**会被渲染成 `[时间] 发送人:` + 缩进内容；
`<forwarded_messages/>` 只是"能力缺失 / 调用失败"时的降级态 —— 裸调 `normalize()`（不传 capability）测到的正是这个降级态。

> 待确认：`im.v1.message.get` 是否在本应用权限范围内。调用失败时 SDK 只
> `logger.warn('channel: fetchSubMessages failed')` 后静默降级 → 需查日志确认，不能假设文本一定渲染成功。

### 5.2 真正的障碍：key 拿得到，但下不动

`renderItem()` 对每条子消息再 dispatch 一次，子消息里的图片/文件会把 key 聚合进顶层 `resources`。
但 `ResourceDescriptor` 只有 `{ type, fileKey, fileName, durationMs, coverImageKey }` —— **没有 `message_id`**，
而 `messageResource.get` 要求 `file_key` 与 `message_id` **同属一条消息**（错误码 `234003`）。
即：SDK 帮我们捞到了 key，却丢掉了下载所需的另一半凭据。

### 5.3 支持方案（分三步，前两步不依赖真机）

**Step 1｜确认文本链路（零代码）**
- 查日志有无 `fetchSubMessages failed`；
- 确认应用具备读取消息的权限（`im:message` / 获取单聊、群组消息）。

**Step 2｜自建子消息遍历（不依赖 SDK 的 resources）**
在 connector 层对 `merge_forward` 单独处理：
1. `rawClient.im.v1.message.get({ message_id })` → `items`（父消息 + 全部子消息，含嵌套）
2. 按 `upper_message_id` 建树（可参考 SDK 的 `buildChildrenMap` 逻辑），递归遍历
3. 逐条解析 `body.content`：按 `msg_type` 取 `file_key` / `image_key`，记下 `{ subMessageId, fileKey, msgType, fileName }`
4. 用**子消息自己的 `message_id`** 调 `messageResource.get` 下载

**Step 3｜真机验证下载可行性（决定性的一步，只读）**
拿一条真实的、含图片的合并转发消息跑一次探测：

```
GET /open-apis/im/v1/messages/{父 message_id}                     → 子消息列表（各自 message_id + content 里的 key）
GET /open-apis/im/v1/messages/{子 message_id}/resources/{file_key}?type=image
```

三种结果对应三种设计：

| 结果 | 含义 | 设计 |
|---|---|---|
| 200 + 文件流 | 子消息用自己的 id 可下载 | 完整支持：遍历 → 下载 → 落盘 → 提示路径 |
| `234043` | 连子消息 id 也被堵死 | 只能回"转发消息里的附件暂不支持保存"，并引导**逐条转发**或直接发文件 |
| `234003` | key 与 message_id 仍不匹配 | 说明子消息资源归属判断有误，需复查 `message.get` 返回结构 |

### 5.4 无论验证结果如何都要做的兜底

- `merge_forward` 不得把 `![image](img_v2_…)` / `<file key="…"/>` 占位符当 prompt 交给 agent；
- 至少要回一条明确提示（区分"已保存附件"与"暂不支持"两种结局）；
- 若走「不支持」路线，提示里给出可行替代：**逐条转发**或直接发文件。

## 6. 同类项目做法对比（2026-09-15 实地调查）

调查对象：`cc-connect`（Go，自解析飞书事件）、
`lark-coding-agent-bridge`（TS，与本项目同款 `@larksuite/channel`）。

| 维度 | lark-remote（现状） | lark-coding-agent-bridge | cc-connect |
|---|---|---|---|
| 判据 | `msg_type` 白名单 `{image,file}` | **`resources` 非空**（消费 SDK 归一化） | `switch msg_type`（枚举 8 类 + `default`） |
| 视频 `media` | ❌ 当文本进 agent | 识别 → 下载 → 立即 `skipped/unsupported-kind` | 识别 → **不下视频本体**，给 `[video: name, 80s]` + 封面图（`:1726-1762`） |
| 语音 `audio` | ❌ 当文本进 agent | 识别 → skip | 下载 `audio/opus` → 引擎 **转写成文字**（`:1584-1618`） |
| 表情 `sticker` | ❌ 当文本进 agent | 识别 → 不下载（skipped） | **真下载**（`type=image`），失败降级 `[sticker]`（`:1692-1724`） |
| 合并转发 | ❌ 当文本（白名单不认） | SDK 展开；`fetch_failed` → 回提示并**中断 run** | **自建遍历**，用**子消息自己的 msgID** 下载嵌套图片/文件（`:2635`、`:2704`） |
| 不支持类型 | 静默当 prompt | 当文本，但 `stripAttachmentRefs` 剥掉占位符 | 主消息**静默丢弃**（debug 日志）；子消息渲染 `[xxx message]`（`:1803-1804`） |
| 附件如何告知 agent | 发提示卡，用户自己再说一句 | **自动注入 prompt** 的 attachments 段 | **自动追加** `(Files saved locally, please read them: <abs>)` |
| 失败反馈 | 提示卡列 failures | — | 每种下载失败都回 `⚠️ … download failed (network error). Please resend.` |

### 6.1 可直接借鉴的四条

1. **判据换成 `resources`** —— `lark-coding-agent-bridge` 用同款 SDK 在生产环境就是这么做的（`src/bot/channel.ts:832`
   把 `resources` 与消息的 `messageId` 配对后交给 media resolver），是本文 §3 骨架的现实印证。
2. **占位符剥离** —— 即使某类型不打算支持，也要把 `![image](key)`、`<video key="…"/>` 这类占位符从 prompt 里剥掉
   （参考实现 `src/bot/channel.ts:1919-1926` 的正则），否则"不特殊处理"等于把 XML 噪声喂给 agent。
3. **合并转发照 cc-connect 的 `parseMergeForward` 抄**（`feishu.go:2635`）：`message.get` → 按 `upper_message_id`
   建树 → 递归 `formatMergeForwardTree`（含 10 层深度截断）→ 每个子消息用**自己的 `msgID`** 下载资源
   （`case "image"` / `case "file"` 分支明确传 `msgID`）。这既是 §5 Step 2 的现成蓝本，
   也说明"用子消息 id 下载"在同类项目里是**预期可行**的做法（该路径无测试覆盖，仍需真机确认）。
4. **附件路径自动进 prompt**（两家都做）—— 比现在"发提示卡 + 用户重述"少一步人工，
   对"发完文件直接说要求"的场景更顺。

### 6.2 需按本项目场景区别对待的两条

- **视频要下本体**：cc-connect 面向通用聊天，只给元信息 + 封面即可；本项目要让本地 agent 用 ffmpeg 抽帧做 OCR
  （正是本次事故的原始诉求），必须落盘视频本体。**不要照搬"不下视频"那条。**
- **语音可先落盘**：cc-connect 转写成文字，是因为通用 agent 读不了 opus；本项目 agent 可自行处理，
  转写作为可选增强（可考虑后续加）。

### 6.3 已核查的一条否定结论

SDK 从 `0.3.0` 到 `0.6.0`，`ResourceDescriptor` **始终不带 `message_id`**（已下载 0.6.0 实物对比确认），
`merge_forward` 的子资源聚合逻辑（`formatSubTree` / `renderItem`）也未变化
→ **升级 SDK 不能解决合并转发的凭据配对问题，必须自建遍历。**

---

_生成于 2026-09-15，基于 SDK 实测 + 日志现场 + 飞书官方文档核查；修复前请复核 `@larksuite/channel` 版本（0.3.0）。_
