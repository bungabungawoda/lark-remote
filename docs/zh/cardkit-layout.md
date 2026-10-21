[English](../en/cardkit-layout.md) | 简体中文

# CardKit 2.0 布局经验

> 飞书 CardKit 2.0 卡片布局避坑指南

## 基础规则

- **column 不支持 flex**：只能用 `width: 'auto'` 或 `weight: N`，不能用 `flex: 1`
- **div 不支持 elements**：只能放 `text`/`tag`/`href`，不能嵌套按钮等子元素
- **tag: tabs 不支持**：CardKit 2.0 中使用 `tag: tabs` 会返回 200621 错误，改用简单列表
- **tag: form 不支持**：CardKit 2.0 不完全支持 `form` 元素，会触发 300123（无 submit 按钮）或 200621（form 嵌套在 column 中）错误。搜索框和输入框改用 `column_set` + `input` + `button` 直接实现，不要用 `form` 包裹。
- **正确布局模式**：文字用独立 div，按钮用 `column_set` + `column` + `button`，禁止包 `action` 容器
- **200861 铁律**：任何 CardKit 2.0 schema 卡片禁止出现 `tag: "action"` + `actions: [...]` 混用，会返回 200621 报错整卡不可用

## 表单组件

### toggle 右列
- boolean 字段的 toggle 按钮右列必须 `width: 'weighted', weight: 3`
- 不能用 `width: 'auto'`——`auto` 让按钮只占文字宽度，右边缘和 select/input 对不齐

### input 组件
- CardKit 2.0 `input` 组件**没有逐键回调**，只有用户提交（移动端键盘回车/完成键，桌面端输入框右侧的提交图标）时才触发一次 callback；没有逐键 change 事件，所以「边输边过滤」做不到
- **文案不要写「点 ✓」**：移动端没有那个图标，只有键盘回车/完成键（2026-09-19 用户反馈）。统一写「按回车提交」
- **不要依赖「清空输入再提交」作为取消手段**：官方文档没有承诺空串会发回调，且 2026-09-19 用户在手机飞书实测「清空后回车没有反应」——把它当唯一取消路径会在部分客户端变成死路。需要「清除/重置」语义时，在同一行放一个显式 `auto` 宽按钮承载（按钮 callback 不带 `input_value`，用 payload 里的标记字段强制清除，别靠「读不到输入值」这一隐式条件）。参考实现：`src/router/card-helpers.ts` 的 `searchBar`（有 `currentQuery` 即渲染「清除筛选」按钮 + `clearQuery` 标记）
- 但 `input_value` 会被 SDK normalizer 丢弃，必须 `includeRawEvent: true`，从 `action.raw.action.input_value` 读取
- 不要用 `form` 包裹 input + button，直接用 `column_set` + `input` + `button`
- **input 不要和文案挤在同一行**：同一行里放「文案 + input + 按钮」时，`auto` 按钮先占走固有宽度，剩下的宽度再按 weight 切分——手机窄屏（可用宽约 330px）下文案列只剩百来像素、input 只有几十像素，文案折行且输入框没法点（2026-09-10 分页栏真实故障）。正确做法是**拆成两行**：信息文案用顶层 `div` 独占整行，控件放进自己的 `column_set`（上一页 `auto` + input `weighted weight:1` + 下一页 `auto`，input 吃满按钮之外的剩余宽度）。参考实现：`src/router/card-helpers.ts` 的 `paginationBar`（`/ls` `/ws` `/resume` `/active` `/order` 共用）。
- **不要用 form 包裹 input + 按钮**（见上）；也不要放进文案同一个 column 的第二个 element（同列会上下堆叠）。列宽只用 `weighted`/`auto`，未经验证不要引入像素宽度（如 `'90px'`）

## 按钮组件

- 按钮直接挂 `body.elements` / `column.elements` / `tabs[].elements`
- **禁止**包在 `action` 容器中（会触发 200861）
- 回调统一用 `behaviors: [{ type: 'callback', value: { cmd, key } }]`

## 折叠面板

- 使用 `collapsible_panel` 包裹次要信息
- **折叠是视觉隐藏，JSON payload 仍含全部内容**，28KB 卡片预算仍需遵守
- 不要以为折叠后就可以塞更多内容

## 窄屏优先（手机）与桌面双端

卡片的实际渲染宽度由对端决定，服务端**拿不到**宽度，所以布局必须按最窄的形态
设计：手机内容区约 320–360px（iPhone SE 更窄），同一张卡还要在桌面宽屏上不难看。

硬规则：

- **不要用 `column_set` 的 `auto` + `grow` 并排放"短标签 + 长文本"**。`auto` 列会
  被长文本挤到只剩一两个字宽，CJK 会竖排：2026-10-19 手机反馈的
  「运行
中」就是这么来的。
- **状态行/元信息 = 单个 `div` + ` · ` 分隔**。换行只会发生在分隔符处，可预期。
- **每个分段要短到自身不会折行**（≈8 个显示宽度以内），例如 `📊 ~36%`、
  `🧰 532 步`、`⏱ 2m13s`，不要写 `📊 上下文使用率 ~36%`。
- **交互控件放行尾**（按钮列 `width:auto` 在右侧），正文列用 `grow`——只适用于
  **短标签 + 可正常折行的正文**：按钮宽度固定，文字换行可接受。
- **长且不可断行的文本（命令/路径/URL）不能和按钮共用一行**：长命令的
  min-content 宽度会把 `auto` 按钮挤成「🟥…」（2026-10-21 手机截图），命令本身也
  会被截断。完整文本单独占一个 `div`；太长就收进 `collapsible_panel`（正文保留
  全文），按钮放到下一行的**单列** `column_set`。命令是用户要核对/复制的对象，
  任何情况下都不 truncate。回归守卫：
  `src/card/run-renderer.test.ts` 的 `renderRunCard background jobs`。
- 修改卡片后按手机宽度复核；状态行的回归守卫在
  `src/card/run-renderer.test.ts` 的 `status row narrow-screen layout` 一节
  （断言单 `div`、每个分段 ≤ 8 显示宽度、整行 ≤ 26）。

反例 / 正例（run 卡状态行）：

```jsonc
// ❌ 手机上 "运行中" 竖排：auto 列被 grow 列挤压
{ "tag": "column_set", "columns": [
  { "tag": "column", "width": "auto", "elements": [{ "tag": "div", "text": { "content": "运行中" } }] },
  { "tag": "column", "width": "grow", "elements": [{ "tag": "div", "text": { "content": "🧰 工具调用中 · 📊 上下文 ~36%" } }] }
]}

// ✅ 单行单 div，窄屏只在 " · " 处换行
{ "tag": "div", "text": { "tag": "lark_md", "content": "⏱ 12s · 🧰 532 步 · 📊 ~36%", "text_size": "notation" } }
```

## 常用布局模板

### 文字 + 按钮（行内）
```json
{
  "tag": "div",
  "text": { "tag": "lark_md", "content": "some text" }
},
{
  "tag": "column_set",
  "columns": [
    {
      "tag": "column",
      "width": "auto",
      "elements": [{ "tag": "button", ... }]
    }
  ]
}
```

### 左标签 + 右输入（表单行）
```json
{
  "tag": "column_set",
  "columns": [
    {
      "tag": "column",
      "width": "weighted",
      "weight": 1,
      "elements": [{ "tag": "div", "text": { "tag": "plain_text", "content": "标签名" } }]
    },
    {
      "tag": "column", 
      "width": "weighted",
      "weight": 3,
      "elements": [{ "tag": "input", ... }]
    }
  ]
}
```

## 调试技巧

- 使用 `JSON.stringify(card)` 检查结构
- 发送前用 `enforceCardBudget()` 检查是否超 28KB 与元素总数（`countCardNodes`）
- 飞书 API 错误码：200621（标签/结构错误）、300123（form 缺少 submit）、
  230099/11310（**元素总数或 markdown table 超限**——同一码两个成因，见下）

### 卡片元素总数上限（2026-10-19 真实 API 实测）

`tests/feishu-live/feishu-card-element-total-limit.test.ts` 在测试会话实测：

| 形状 | 通过 | 失败 |
| --- | --- | --- |
| 顶层平铺 div | 99 个 | 100 个 |
| 单列 column_set 内嵌 div | 98 个（+1 个 column_set = 99） | 99 个（= 100） |
| 单 column_set 的列数 | 66 列 | 67 列 |

判据是**递归统计 `elements` 数组成员（不含 `columns`）≤ 99**。整卡 JSON 对象数
**不是**判据：`/ws` 分页卡有 227 个 JSON 对象仍能发出去，而平铺 100 个 div 只有
205 个对象却失败。列数是另一个独立维度（66/67 的边界），本仓库的卡片列数都在 3
以内，用不到。超限报 `230099`，内层 `ErrCode: 11310 element exceeds the limit`。

**勘误**：仓库早期把 `230025` 记作「elements 过多」，本次探测中一次都没有出现，
不要再用它做元素总数的判据。旧结论「`/ws` 61 个顶层元素就 11310」之所以成立，
是因为 20 行 × (div + column_set + 2 button) 的元素计数到了 101。

实现侧：`src/card/card-budget.ts` 的 `MAX_CARD_ELEMENTS = 90`（相对实测 99 留
10% 余量）、`countCardElements()`，以及 `enforceCardBudget()` 的元素裁剪分支；
run 卡片由 `run-renderer.ts` 的 `withinRunCardBudget()` 做双预算（28KB + 90 元素）
检查，正常路径还会按元素预算从最新往回省略最旧的步骤（`selectVisibleGroups()`）。
