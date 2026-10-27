# 入站消息分派矩阵

> 起因：2026-09-15 用户在飞书私聊发 mp4，被当普通文本转发给 agent（prompt 变成 `<video key="…"/>` 占位符），
> agent 满盘搜索文件 10 分钟未果。排查后确认根因是**入站分派的判据维度选错**（`msg_type` 白名单，
> 而非"是否携带可下载资源"），并发现同一根因下还有一批同类漏判。
>
> 数据来源：`@larksuite/channel@0.3.0` 的 `normalize()` **实测**（构造 22 种 `message_type` 跑真实 SDK 输出），
> 非读源码推断；`post` 顶层附件区与合并转发抓取失败态两行于 `@larksuite/channel@0.7.1` 复测补齐
> （离线契约锚点：`src/inbound/sdk-normalize-contract.test.ts`）。判定点：修复前 `src/connector/index.ts` 的入站分派分支。
> **SDK 给出的 `resources` 不等于"飞书允许下载"** —— 官方接口的硬限制见 §4（表情包、合并转发都不给下载）。

## 0. 判定点与旧判据

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

`处置` 列按当前代码判定，表驱动断言见 `src/inbound/matrix.test.ts`；三类处置的定义见 §2、判据见 §3。

| message_type                 | content 渲染                                                                                                                                                                 | resources（实测）                          | 处置                         | 备注                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `text`                       | `hello world`                                                                                                                                                                | —                                          | 文本类 → 进 prompt           |                                                                                   |
| `image`                      | `![image](img_v2_a)`                                                                                                                                                         | `image`                                    | 资源类 → 落盘 + 注入 prompt  |                                                                                   |
| `file`                       | `<file key="…" name="report.pdf"/>`                                                                                                                                          | `file` + fileName                          | 资源类                       |                                                                                   |
| `post`（含图）               | `**T**\n\n看这张图 ![image](…)`                                                                                                                                              | `image`（可多个）                          | 资源类 **且** 文本并存       | 图文混排不丢文字                                                                  |
| `post`（纯文字）             | `纯文字富文本`                                                                                                                                                               | —                                          | 文本类                       |                                                                                   |
| `post`（顶层附件区，0.6.0+） | 正文 + `<file key="…" name="report.pdf"/>`（folder 为 `<folder …/>`）                                                                                                        | `file` + fileName（folder 不产资源）       | 资源类 + 文本并存            |                                                                                   |
| `media`                      | `<video key="…" name="1755000000.mp4" duration="80.9s"/>`                                                                                                                    | `video` + fileName + coverImageKey         | 资源类（下载走 `type=file`） | 落视频本体，供 agent 抽帧                                                         |
| `video`                      | 同上（SDK 把 `video`/`media` 都注册到 `convertVideo`）                                                                                                                       | `video`                                    | 资源类                       |                                                                                   |
| `media`（无 file_name）      | `<video key="…" duration="80.9s"/>`                                                                                                                                          | `video`，**无 fileName**                   | 资源类                       | 命名按 MIME + 魔数补扩展名（§2.1）                                                |
| `audio`（语音）              | `<audio key="…" duration="3s"/>`                                                                                                                                             | `audio`，**无 fileName**                   | 资源类                       | 只落盘不转写                                                                      |
| `sticker`（表情）            | `<sticker key="…"/>`                                                                                                                                                         | `sticker`，**无 fileName**                 | 资源类尝试下载               | 飞书称表情包不可下载（§4）→ 失败走 `rejected` 回执，`<sticker key=…>` 不进 prompt |
| `merge_forward`              | 有子消息能力时渲染成 `[时间] 发送人:` + 缩进内容的树；能力缺失时 `<forwarded_messages/>`；子消息抓取失败（0.4.1+，重试耗尽）时 `<forwarded_messages status="fetch_failed"/>` | 子消息内的资源**会被聚合进顶层 resources** | 文本保留 + 附件尽力而为      | 凭据问题与三种降级结局见 §5                                                       |
| `interactive`                | `[interactive card]`                                                                                                                                                         | —                                          | 不支持类 → 回执，不进 prompt |                                                                                   |
| `folder`                     | `<folder key="…" name="myfolder"/>`                                                                                                                                          | `[]`                                       | 不支持类                     | key 不能用 messageResource 下载                                                   |
| `share_chat`                 | `<group_card id="oc_…"/>`                                                                                                                                                    | —                                          | 不支持类                     |                                                                                   |
| `share_user`                 | `<contact_card id="ou_…"/>`                                                                                                                                                  | —                                          | 不支持类                     |                                                                                   |
| `location`                   | `<location name="公司" coords="…"/>`                                                                                                                                         | —                                          | 不支持类                     |                                                                                   |
| `system`（撤回等）           | `撤回了一条消息`                                                                                                                                                             | —                                          | 文本类                       | 无资源且是纯文本，属判据的直接推论；飞书是否下发未由用例固定                      |
| `vote`                       | `<vote>\n午饭吃啥\n• 面\n• 饭\n</vote>`                                                                                                                                      | —                                          | 不支持类                     |                                                                                   |
| `todo`                       | `<todo>\n[todo]\n</todo>`                                                                                                                                                    | —                                          | 不支持类                     |                                                                                   |
| `video_chat`                 | `<meeting>\n📹 周会\n…</meeting>`                                                                                                                                            | —                                          | 不支持类                     |                                                                                   |
| `calendar`                   | `<calendar_invite>\n📅 会议\n</calendar_invite>`                                                                                                                             | —                                          | 不支持类                     |                                                                                   |
| `hongbao`                    | `<hongbao text="恭喜发财"/>`                                                                                                                                                 | —                                          | 不支持类                     |                                                                                   |
| 未知类型                     | `[unsupported message]`                                                                                                                                                      | —                                          | 不支持类 + warn 日志         | 暴露而非静默                                                                      |
| `image`/`sticker` 无 key     | `[image]` / `[sticker]`                                                                                                                                                      | `[]`                                       | 不支持类                     | 兜底降级态                                                                        |

## 2. 处置分类（实现态）

上表按**资源载体**而非消息类型归三类，判据与装配流程见 `inbound-unified-input-design.md` §5.1：

- **资源类**（`resources` 非空）：落盘 → 提示本地路径。`post` 与 `merge_forward` 额外**保留文本**，
  不做"资源 or 文本"二选一（图文混排丢文字就是这么来的）。
- **文本类**（无资源、纯文本）：直接进 agent。
- **不支持类**（无资源且 content 是结构化占位符，或 `msg_type` 未识别）：回一条明确提示，
  **不进 agent**——把 `<xxx …/>`、`[unsupported message]` 当用户意图只会浪费一次 turn，
  还可能误触发命令。

### 2.1 下载侧的三条硬约束

1. **不要**把 `handleInboundMediaDetected` 里的 `r.type === 'image' ? 'image' : 'file'` 改成按类型细分：
   飞书 `im.v1.messageResource.get` 的 `type` 只有 `image`/`file` 两个合法值（SDK 注释
   _'file' for everything else_），传 `'video'` 会 400。
2. `sticker` 按资源类尝试下载（`type=file`），但飞书文档称"暂不支持获取表情包资源"（见 §4）；
   下不动时走回执，且 `<sticker key=…>` 占位符**永不进 prompt**。
3. 无 `fileName` 的资源不能只靠文件名命名：要按 MIME + 魔数补扩展名（参考 `imageExtension`），
   否则 agent 与用户都无法判断格式。

### 2.2 绑定闸门

未绑定用户先发媒体时，媒体闸门与文本闸门必须走同一套 `classify()` 判定，否则新实例的首条
图/视频会**什么都不发生**（文本通道有"首条任意消息即绑定"兜底，媒体通道若没有就成了静默丢弃）。

## 3. 分派判据

判据是"资源载体 + 分类处置"，不看类型白名单：

```
resources.length > 0  →  资源类：落盘 → 提示本地路径（post 额外保留文本）
resources.length === 0 且 content 是纯文本  →  文本类：直接转发
resources.length === 0 且 content 是结构化占位符  →  不支持类：回提示，不进 agent
未识别 msg_type（无论有无资源）  →  warn 日志 + 不支持提示（暴露而非静默）
```

守护测试（表驱动，覆盖上表全部 `message_type`，见 `src/inbound/matrix.test.ts`）：

- 断言「`resources` 非空的入站消息，一律不得进入文本转发路径」；
- 断言「结构化占位符（`<xxx …/>`、`[unsupported message]`）不得成为 agent prompt」。

## 4. 飞书官方接口限制（已核实，2026-09-15）

来源：官方文档《获取消息中的资源文件》（最后更新 2026-08-27），接口
`GET /open-apis/im/v1/messages/:message_id/resources/:file_key`。

**`type` 参数只有两个合法值**，这决定了下载侧的类型映射不可扩展：

| 值      | 覆盖的消息类型                             |
| ------- | ------------------------------------------ |
| `image` | 消息中的图片、富文本消息中的图片           |
| `file`  | 消息中的文件、音频、视频（**表情包除外**） |

由此确定的硬约束：

1. **表情包（sticker）官方称不可下载** —— 文档原文「暂不支持获取表情包资源」，且 `file` 的说明里再次注明
   "表情包除外"。但 `type` 枚举只明确排除了 **`file`** 分支（`image` 的说明是"消息中的图片或富文本消息中的
   图片"，未提及表情包），所以本项目不把它写死成"不支持"：sticker 按资源类尝试下载，下载 `type` 仍受 §2.1
   第 1 条约束（只有 `image`/`file` 两个合法值），失败时降级成 `rejected` 回执，占位符绝不进 prompt。
2. **合并转发（含子消息）的资源下载被列为不支持** —— 错误码 `234043 Unsupported message type` 的示例即
   "合并转发消息（包括子消息）、消息卡片"。该表述没说清作用域：是"拿父消息 id 去下子消息的 key"失败，
   还是"子消息用自己的 message_id"也失败。因此实现按**尽力而为 + 失败回执**处理（见 §5），不承诺一定能拿到附件。
3. **`file_key` 与 `message_id` 必须匹配**（错误码 `234003`）—— 不能拿父消息的 `message_id` 去下载子消息的 `file_key`。
4. **大小限制**：`type=file` 时 >100MB 需 `Range` 分片（单次 ≤32MB，需本地合并）；`type=image` 不支持分片，仅支持完整下载 <100MB。
   SDK 的 `downloadResourceToFile` 不做分片 → >100MB 必失败（`234037`）。
5. 其他会让下载失败的场景：保密消息 / 防泄密模式（`234038`）、消息对操作者不可见（`234040`）。

## 5. merge_forward 的凭据问题与降级

合并转发（`msg_type = merge_forward`）是这套判据里唯一的硬约束来源，事实分三层：

1. **子消息文本能渲染**：`LarkChannel.registerDispatcherHandlers()` 在 `normalizeOpts` 里已注入
   `fetchSubMessages`（实现为 `rawClient.im.v1.message.get({ message_id })`），子消息文本渲染成
   `[时间] 发送人:` + 缩进内容；`<forwarded_messages/>` 只是"能力缺失 / 调用失败"时的降级态 ——
   裸调 `normalize()`（不传 capability）测到的正是这个降级态。SDK 调用失败时只
   `logger.warn('channel: fetchSubMessages failed')` 后静默降级，所以**不能假设文本一定渲染成功**。
2. **key 拿得到，另一半凭据丢了**：`renderItem()` 对每条子消息再 dispatch 一次，子消息里的图片/文件
   会把 key 聚合进顶层 `resources`。但 `ResourceDescriptor` 只有
   `{ type, fileKey, fileName, durationMs, coverImageKey }` —— **没有 `message_id`**，而
   `messageResource.get` 要求 `file_key` 与 `message_id` **同属一条消息**（错误码 `234003`）。
   SDK 从 `0.3.0` 到 `0.7.1` 都是如此，`merge_forward` 的子资源聚合逻辑（`formatSubTree` / `renderItem`）
   也未变化 → **升级 SDK 不解决凭据配对，要拿子消息附件必须自建遍历**：`message.get` 取 items →
   按 `upper_message_id` 建树（含深度截断）→ 逐条解析 `body.content` 取 `file_key` / `image_key` →
   用**子消息自己的 `message_id`** 调 `messageResource.get` 下载。
   （注：0.7.1 的 `merge-forward.ts` 注释称飞书也接受**顶层合并转发容器**的 `message_id`，与本节结论相左；
   本项目不依赖该行为。）
3. **能否下载还受 `234043` 制约**：官方把"合并转发消息（包括子消息）"列为 `messageResource.get` 的不支持场景。

### 5.1 实现取的降级形态：尽力而为，绝不静默

三种结局都有明确出口（表驱动断言见 `src/inbound/matrix.test.ts`）：

| 情况                                    | 行为                                     |
| --------------------------------------- | ---------------------------------------- |
| 子消息文本 + 附件都拿到                 | 文本保留，附件落盘并注入 prompt          |
| SDK 能力缺失（`<forwarded_messages/>`） | 回执「暂不支持合并转发消息」，不进 agent |
| 附件下载失败                            | 文本照常保留，附件回执「下载失败」       |

任何情况下都**不得**把 `![image](img_v2_…)` / `<file key="…"/>` 占位符当 prompt 交给 agent；
走"不支持"路线时，提示里要给出可行替代：**逐条转发**或直接发文件。

> 前置：本应用需具备读取消息内容的权限（`im:message`、获取单聊/群组消息）。缺权限时
> `fetchSubMessages` 调用失败，SDK 只 warn 后静默降级成 `<forwarded_messages/>`，
> 用户看到的是"暂不支持合并转发消息"而不是权限错误。

## 6. 与通用聊天机器人的取舍

本项目要让**本地 agent 真正读得到内容**，因此有意区别于"只给元信息"的通用做法：

| 维度       | 通用做法                         | 本项目的选择与原因                                              |
| ---------- | -------------------------------- | --------------------------------------------------------------- |
| 视频       | 只给 `[video: name, 80s]` + 封面 | **落盘本体** —— agent 要拿 ffmpeg 抽帧做 OCR，封面不够          |
| 语音       | 引擎转写成文字                   | **只落盘不转写** —— 本项目 agent 能自行处理，转写不是必需路径   |
| 附件告知   | 发一张提示卡，等用户再说明一句   | **路径自动注入 prompt** —— 少一步人工，"发完文件直接说要求"才顺 |
| 不支持类型 | 静默丢弃或当文本                 | **回明确提示**，且占位符不进 prompt（静默等于用户以为程序坏了） |

### 6.1 两条通用做法（本项目已落在实现里）

- **判据用 `resources` 非空**，并与消息的 `messageId` 配对后再下载 —— 落点在 `src/connector/index.ts`
  的入站分派；
- **占位符必须剥离**：即使某类型不打算支持，也要把 `![image](key)`、`<video key="…"/>` 从 prompt 里剥掉，
  否则"不特殊处理"等于把 XML 噪声喂给 agent —— 落点在 `src/inbound/placeholder.ts`。

---

_判据与装配流程见 `inbound-unified-input-design.md`；错误码含义见飞书官方文档
`im/v1/messages/:message_id/resources/:file_key`。类型行为由 `src/inbound/matrix.test.ts`
表驱动覆盖，SDK 版本以 `package.json` 里的 `@larksuite/channel` 为准。_
