# 入站消息统一处理设计（Inbound Turn）

> 状态：**已实施（2026-09-15 拍板；B1–B4 同日落地，B5/B6 待真机验证）**。
> 前置阅读：`inbound-message-matrix.md`（全类型实测矩阵 + 飞书接口硬限制 + 同类项目对比）。
> 本文只回答一个问题：**怎么把"用户发的一串东西"统一变成 agent 能用的一个回合（turn）**。

## 0. 结论摘要

现在的问题不是"漏了某个消息类型"，而是**缺少一层"用户意图装配"**：

- 飞书的事件模型是「**一条消息 = 一个事件**」，而用户的意图常常是「**多条消息 = 一个意图**」（先发图再说话，或先说再发图）。
- 当前实现把"事件"直接映射成"动作"：资源事件 → 落盘 + 单独发提示卡；文本事件 → 立刻起一个 agent turn。
  两者互不知情，于是 **agent 永远拿不到附件路径**。
- 额外暴露一个 **P0 安全问题**：SDK 把富文本里的图片渲染成 `![image](key)`，行首的 `!` 命中了本项目
  的 bash 命令语法 → **用户消息被当 shell 命令执行**（详见 §1.3）。

方案核心：新增 **InboundTurnAssembler**（§4）+ 判据改为「资源载体」而非「消息类型」（§5.1）+
命令识别加前置条件（§5.6）+ 附件路径统一注入 prompt（§5.4）。

## 1. 现场：两条消息为什么表现不同

证据：现场实例日志 `logs/2026-09-15/`（22:09 两条消息）。

### 1.1 两条消息的真身

日志里 `message from …` 的原文：

```
22:09:34  ![image](img_v3_…) \n test     ← "图片在前，文字在后"
22:09:42  test \n ![image](img_v3_…)     ← "文字在前，图片在后"
```

一条消息里同时含文字与图片、且图片被渲染成 `![image](img_v3_…)` —— 这是 **富文本消息（`msg_type = post`）**
（飞书把相邻的"图 + 文"合成一条 post；纯 `image` 消息的 content 只有 `image_key`，不会有文字）。
SDK 的 `convertPost` 把 `img` 元素渲染为 `![image](${image_key})`，与本项目实测一致。

### 1.2 关键事实：图**从未下载**

对该日志 `grep -cE "\[media\]|inbound media|downloadResource"` = **0**。
因为 `post` 不在判据白名单 `{image, file}` 里（修复前 `src/connector/index.ts` 的入站分派分支），
消息整体走了文本通道，`resources` 里的 `image` 被直接丢弃。

### 1.3 表现差异的**真正原因**：`!` 被当成 bash 命令

```
22:09:34.110  [router] handle … startsWithBang=true          ← 渲染串以 "!" 开头
22:09:34.110  [lark-remote] executeBash start … command="[image](img_v3_…"
22:09:34.792  [bash-runner] spawn pid=1234 command="[image](img_v3_…)…"
22:09:34.796  [bash-runner] process exited with code=2
```

修复前 `src/router/index.ts` 的 `CommandRouter.handle` 判据是**裸文本前缀**：

```ts
const trimmed = message.trim();
const startsWithBang = trimmed.startsWith('!');
…
if (trimmed.startsWith('!')) {
  const cmd = trimmed.slice(1).trim();
  await this.bridge.executeBash(cmd, ctx);   // → 整段用户消息进了 bash
}
```

而 `![image](…)` 的第一个字符恰好是 `!`。于是：

| 顺序 | 走到的分支 | 用户看到的结果 |
|---|---|---|
| **图在前** | `startsWithBang` → `executeBash` | 一条 bash 执行失败的卡片（exit 2），**文字 `test` 也没进 agent** |
| **文在前** | `startsWithBang=false` → `forwardToClaude` | agent 收到 `test\n![image](img_v3_…)`，**图不存在**，agent 只能猜 |

**这不是"两种时序"，是"一条消息被当成命令执行了"。** 且它同时构成一个安全问题：
任何以结构占位符开头的消息（`![image](…)`、`![]()`）都会被送进 shell；
若富文本首段是图片、后续段落含可控文本，整段都会被拼成命令。
命令识别的判据必须建立在"**这条消息到底是不是用户在打字**"之上，而不是首字符。

## 2. 三条根因

| # | 根因 | 位置 | 后果 |
|---|---|---|---|
| R1 | 判据是**消息类型白名单**，而 SDK 已给出"是否携带资源"（`resources`） | 修复前 `connector/index.ts` 白名单分支 | video/audio/sticker/post/merge_forward 全漏 |
| R2 | 没有"用户意图装配"层：资源事件与文本事件各自触发动作、互不知情 | 修复前 `index.ts`（媒体闸门） vs `index.ts`+`router`（文本通道） | 附件路径永远进不了 agent prompt |
| R3 | 命令识别只看**裸文本前缀**，且发生在任何语义清洗之前 | 修复前 `router/index.ts` 的 `handle` | 富文本/占位符被当命令执行（P0） |

## 3. 设计原则

1. **判据用"载体"，不用"分类"**：消息是否携带可下载资源（`resources`）、是否只含结构占位符 —— 由数据决定，不由类型枚举决定。
2. **先清洗，后判语义**：任何前缀判定（命令/别名）都必须发生在**占位符剥离之后**。
3. **一个用户意图 = 一个 turn**：多条消息可以合成一个 turn，合并规则显式且可测。
4. **agent 只认本地路径**：任何进 agent 的输入都必须已经落到本地；拿不到的部分用"回执"告诉人，不塞给 agent。
5. **失败与不支持必须可见**：不允许静默丢弃、不允许静默降级成占位符。
6. **不动 runner 契约**：turn 最终仍是一个字符串 prompt（本项目不改 agent system prompt 的既有原则）。

## 4. 统一模型：InboundTurn

### 4.1 数据结构（设计）

```ts
interface InboundTurn {
  userId: string;
  chatId: string;
  replyToMessageId?: string;

  /** 用户文本片段，按到达顺序；已剥离结构占位符 */
  texts: string[];
  /** 已落盘的附件（绝对路径），按到达顺序 */
  attachments: Array<{
    path: string;
    kind: 'image' | 'file' | 'video' | 'audio' | 'sticker';
    sourceMsgId: string;        // 下载凭据的一部分，也是排障锚点
    originalName?: string;
    durationMs?: number;
  }>;
  /** 拿不到、不支持、超限、失败的项 —— 需要回执给人（不进 agent） */
  rejected: Array<{
    kind: string;               // 原 msg_type 或 'unknown-placeholder'
    reason: string;             // 面向人的说明
    sourceMsgId: string;
  }>;

  /** 本 turn 覆盖的飞书 messageId（回执、去重、排障） */
  messageIds: string[];
  /** 提交原因，用于观测与测试断言 */
  commitReason: 'idle' | 'timeout' | 'flush' | 'no-text';
}
```

### 4.2 生命周期

```
connector 事件（文本 / 资源 / 结构占位）
        │  归一化为 InboundEvent
        ▼
InboundTurnAssembler               ← 新增层（§7）
   ├─ 文本事件        → 清洗占位符 → texts.push()
   ├─ 资源事件        → 触发下载（异步）→ attachments.push()
   ├─ 结构占位事件    → rejected.push()
   ├─ 命令事件        → 旁路：立即执行（不等窗口），见 §5.6
   └─ 静默期到 / 超时 → commit()
        ▼
  构造 prompt = texts + 附件块(§5.4)
        ▼
  bridge.forwardToClaude(prompt)  → 现有 work queue → runner
        ▼
  回执（仅当有 rejected / 无文本时）
```

## 5. 关键设计决策

### 5.1 判据：从"消息类型"改为"资源载体"

- connector 侧**不再做白名单判定**，统一上报 `InboundEvent`（含 `rawContentType`、`content`、`resources`、`messageId`）。
- 是否需要下载，由 assembler 按 `resources.length > 0` 决定。
- `msg_type` 只用于：① 日志/诊断；② 未识别类型时产出 `rejected` 提示。

这样做的理由已在 `inbound-message-matrix.md` §1 论证：SDK 的 converter 注册表里
`image / file / audio / video+media / sticker` 五类都会产出非空 `resources`，枚举类型必然漏。
**未识别类型（有资源但类型不认识）→ 照常下载 + `warn` 日志**，而不是走文本。

### 5.2 时序：统一静默期窗口

- 任何事件到达：**重置**一个静默期定时器（默认 `700ms`，可配置）。
- 静默期结束 → 进入"提交就绪"；但**必须等本 turn 内所有下载落定**（成功/失败/超时）才真正 commit。
- 上传/下载超时上限沿用 `RESOURCE_DOWNLOAD_TIMEOUT_MS`；超时项 → `rejected`。
- **不实现"零延迟快路径"**（决策 1，2026-09-15 拍板）：所有消息一律走 700ms 静默期，
  以保证"图/文任意顺序等价"。

> 已拍板：接受统一窗口带来的 ~700ms 延迟（agent 单回合本身即几十秒量级）。

### 5.3 附件下载与落盘

- 复用现有 `downloadInboundMedia` + `InboundMediaHandler`（下载、限流、超限、原子移动、时间戳目录）。
- **修正 `InboundMediaItem.type` 的语义**：现在只有 `'image' | 'file'`，导致 video/audio/sticker 落盘命名退化。
  保留 `'image' | 'file'` 作为**下载 type**（飞书 API 只认这两个值），
  但**新增独立的 `kind`**（image/file/video/audio/sticker）用于：命名、prompt 标注、提示文案。
- 命名规则按 `kind`：
  - `image` → `image_HHmmss_n.<ext>`（按 MIME/魔数，沿用 `imageExtension`）
  - `file` → 保留 `originalName`
  - `video` / `audio` / `sticker` → 有原名用原名；**无原名时按 MIME/魔数补扩展名**
    （现在是 `file_HHmmss_n` 无扩展名 —— mp4/opus/gif 都不可识别）

### 5.4 prompt 组装：文字 + 附件块（决策 3：**结构化标签**）

格式（XML 自闭合标签，agent 易解析；格式定稿见任务书 §6.3）：

```
<用户文本，按原顺序、原样>

<attachments>
  <file path="/Users/…/.lark-remote-temp/20260915/image_220934_1.png" kind="image"/>
  <file path="/Users/…/.lark-remote-temp/20260915/1755000000.mp4" kind="video" duration="80.9s" name="1755000000.mp4"/>
</attachments>
```

要点：
- 附件块**只列路径 + 类型 + 可选时长/原名**，不列 `file_key`（对 agent 无意义）。
- **富文本占位符从文本里剥离**：`![image](img_v3_…)`、`<file key="…"/>`、`<video …/>` 等
  在 `texts` 里替换为空并（若已落盘）转为附件块条目；避免 agent 把 key 当路径。
- 无文本、只有附件时不自动起 turn（见 §5.5）。

### 5.5 无文本的纯附件消息

**已拍板（决策 2）：不自动提交 turn**，只发一条回执（沿用现有文案并改写为引导式）：
「📎 已保存 1 个文件：`/abs/path`。说一句话我就开始处理。」
理由：用户发文件常常只是"存一下"；自动起 turn 会烧 token 且行为不可预期。

### 5.6 命令识别：加前置条件（P0 修复）

新顺序（`router.handle` 之前）：

```
1. 占位符剥离 + 资源归一化（assembler 或 router 前置纯函数）
2. 命令判定仅在以下条件**全部**成立时生效：
   a. rawContentType === 'text'            （富文本/资源消息永不作为命令）
   b. 清洗后文本 !== '' 且不含任何结构占位符
   c. 首字符为 '!' 或 '/'
3. 其它情况一律走 turn（文本进 agent）
```

配套：`router.handle` 增加显式入参（如 `allowCommandPrefix`）或由调用方传入 `kind`，
避免"哪里都能调 handle、裸文本就成了命令"的现状。
**测试必须包含**：以 `![image](…)` 开头的消息不得触发 `executeBash`。

### 5.7 不支持类型与降级态：回执而非塞给 agent

| 输入 | 处置 |
|---|---|
| 结构占位（`<vote>`、`<location>`、`<group_card>`、`[unsupported message]`、缺 key 的 `[image]`） | `rejected` → 回执「暂不支持 X 类型消息」；**不进 agent** |
| 富文本中的图片 | 正常落盘进附件块（不再因为"整条是 post"而整体放弃） |
| 合并转发 | 文本保留（SDK 已渲染）；附件下载见 `inbound-message-matrix.md` §5 的分阶段方案 |
| 表情 sticker | 待实测 `type=image`；失败 → `rejected`（「表情暂不支持保存」） |
| 超限/下载失败 | `rejected`，与同 turn 的回执合并成一条，不单独飘消息 |

### 5.8 与既有机制的衔接

- **命令消息与窗口**：`/stop`、`/t` 立即生效（不进窗口，保持现有可打断性）；其它 `/命令` 立即执行，
  窗口内已装配的附件作为**独立回执**（或附带路径到命令回执里？—— 建议前者，简单可预期）。
- **clone 状态机活跃期**：现有"一切消息先经 clone 状态机（`/stop` 除外）"的拦截位置**保持不变**，
  装配器在其后；clone 期间不落盘附件。
- **`inboundMedia.enabled = false`**：不下载 → 附件项进 `rejected`（原因"入站媒体保存已关闭"），
  文本照常进 agent。语义与现状一致，只是反馈并入了 turn 回执。
- **agent 忙**：commit 后仍走现有 work queue，不改变排队语义。
- **多用户/多实例**：装配器按 `userId:chatId` 分桶（与现有合批 key 同源）。

## 6. 类型处置矩阵（设计态）

| msg_type | 有资源 | texts | attachments | rejected | 备注 |
|---|---|---|---|---|---|
| `text` | — | ✅ 原文 | — | — | 命令前缀仅此类型可生效 |
| `image` | ✅ | — | ✅ | — | |
| `file` | ✅ | — | ✅ | — | 保留原名 |
| `media` / `video` | ✅ | — | ✅（**本体**） | — | 附时长；封面可选 |
| `audio` | ✅ | — | ✅（补扩展名） | — | 转写为可选增强 |
| `sticker` | ✅ | — | ✅（待实测） | 失败时 | `type=image` 优先 |
| `post` | 可能 | ✅（剥占位符） | ✅（内嵌图） | — | **文本与图片并存**，不再二选一 |
| `merge_forward` | 可能有 | ✅（SDK 渲染） | 分阶段（§5） | 失败时 | |
| `interactive` | — | — | — | ✅ | 「卡片消息暂不支持」 |
| `folder` / `share_chat` / `share_user` / `location` / `vote` / `todo` / `video_chat` / `calendar` / `hongbao` / `system` | — | — | — | ✅ | 统一"暂不支持 X" |
| 未知类型 | 视情况 | — | ✅（有资源就下） | warn + 提示 | **default-deny 而非 default-text** |

## 7. 模块与改动面

**新增**（建议目录 `src/inbound/`）：

| 文件 | 职责 |
|---|---|
| `src/inbound/event.ts` | `InboundEvent` 类型 + 从 connector 归一化数据构造事件 |
| `src/inbound/placeholder.ts` | 结构占位符识别/剥离（纯函数，表驱动易测） |
| `src/inbound/turn-assembler.ts` | 窗口、合并、下载等待、commit（可注入时钟，便于测试） |
| `src/inbound/prompt.ts` | texts + attachments → prompt 字符串 |
| `src/inbound/receipt.ts` | rejected / 无文本场景的回执文案 |

**改动**：

| 位置 | 改动 |
|---|---|
| `src/connector/index.ts`（入站分派分支） | 去掉 `{image,file}` 白名单；统一上报事件（文本/资源/占位），只保留 owner 闸门的调用时机语义 |
| `src/index.ts`（`setupMessageHandlers` 媒体闸门） | 媒体闸门 → 改为向 assembler 投递资源事件；owner/enabled 判定保留 |
| `src/index.ts`（`setupMessageHandlers` 文本投递） | 文本投递 assembler；`flushMediaNotifications` 由窗口机制取代 |
| `src/router/index.ts`（`CommandRouter.handle`） | 命令识别加前置条件（§5.6），`handle` 入参显式化 |
| `src/bridge/inbound-media.ts` | 保留下载/落盘；`kind` 与命名规则扩展（§5.3）；提示卡降级为"回执来源之一" |
| `src/bridge/index.ts`（`saveInboundMedia`） | `saveInboundMedia` 向 assembler 回传落盘结果；`forwardToClaude` 接受组装后的 prompt |

**不改**：runner 契约、卡片渲染、命令实现、session 管理。

## 8. 测试策略（按项目 TDD 纪律）

1. `placeholder.test.ts`：表驱动 22 种 `message_type` 的 SDK 渲染串 → 期望"剥离后残文 + 是否占位"。
   （可直接复用我在 `inbound-message-matrix.md` §1 的实测样本。）
2. `turn-assembler.test.ts`（注入假时钟）：
   - 图在前 / 文在前 / 图+文+图 → 三种顺序产出**同一个 turn**（断言 prompt 相等）；
   - 静默期重置、下载未完成不提交、超时进 rejected；
   - 命令消息不改变窗口内装配结果。
3. `router` 命令安全：`![image](img_x)`、`<file key="x"/>`、`[unsupported message]` **不得**触发 `executeBash` / 命令分发。
4. 矩阵集成：22 类消息逐个走一遍 assembler，断言 `texts/attachments/rejected` 结构（表驱动，防回归）。
5. `bun run typecheck` + `bun run test` 全量门禁；新测试文件必须登记进 `test-classification.json`。

## 9. 分批实施建议

| 批次 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **B1（P0 安全）** | 命令识别加前置条件 + 占位符剥离 | 无 | 低；可独立发布，先止血 |
| **B2（P0 资源）** | 判据改 `resources`；video/audio/post 落盘；路径注入 prompt（**暂不做窗口**） | 无 | 中；prompt 格式变化需回归 |
| **B3（P1 时序）** | 引入 assembler 静默期窗口 | B2 | 中；延迟可感知，需拍板窗口值 |
| **B4（P1 反馈）** | rejected 回执、无文本场景回执文案 | B3 | 低 |
| **B5（P2）** | merge_forward 附件（自建遍历，先做真机验证） | 矩阵 §5 验证 | 中；受飞书接口限制 |
| **B6（P2）** | sticker `type=image` 实测后决定 | 真机验证 | 低 |

## 10. 决策记录（2026-09-15 已拍板）

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 聚合窗口 | **统一静默期 700ms**，不做零延迟快路径；接受该延迟 |
| 2 | 纯附件无文字 | **只回执**，不自动起 turn |
| 3 | prompt 附件块格式 | **结构化标签**（`<attachments><file path kind/></attachments>`，见 §5.4） |
| 4 | 语音转写 | **不做**，只落盘交给 agent |
| 5 | 实施方式 | 按批次推进：B1 命令守卫 → B2 分派判据 → B3 装配器 → B4 回执 |

**实施位置**：装配链路在 `src/inbound/`（event / placeholder / prompt / receipt / turn-assembler），
行为矩阵测试见 `src/inbound/matrix.test.ts` 与 `src/router/command-guard.test.ts`。

---

_生成于 2026-09-15。现场证据来自维护者本地实例日志；类型行为来自 `@larksuite/channel@0.3.0` 实测，
接口限制与同类项目做法见 `inbound-message-matrix.md` §4/§5/§6。_
