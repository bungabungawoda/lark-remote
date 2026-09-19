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
- 发送前用 `enforceCardBudget()` 检查是否超 28KB
- 飞书 API 错误码：200621（标签/结构错误）、230025（elements 过多）、300123（form 缺少 submit）
