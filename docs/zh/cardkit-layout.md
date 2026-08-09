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
- CardKit 2.0 `input` 组件自带 ✓ 提交图标触发回调
- 但 `input_value` 会被 SDK normalizer 丢弃，必须 `includeRawEvent: true`，从 `action.raw.action.input_value` 读取
- 不要用 `form` 包裹 input + button，直接用 `column_set` + `input` + `button`

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
