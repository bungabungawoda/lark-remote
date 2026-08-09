[简体中文](../zh/cardkit-layout.md) | English

# CardKit 2.0 Layout Tips

> Pitfall avoidance guide for Feishu CardKit 2.0 card layouts

## Basic Rules

- **column does not support flex**: Only `width: 'auto'` or `weight: N` can be used; `flex: 1` is not supported
- **div does not support elements**: Only `text`/`tag`/`href` can be placed inside; nesting child elements like buttons is not allowed
- **tag: tabs is not supported**: Using `tag: tabs` in CardKit 2.0 returns a 200621 error; use a simple list instead
- **tag: form is not supported**: CardKit 2.0 does not fully support the `form` element, which triggers 300123 (no submit button) or 200621 (form nested inside a column) errors. Implement search boxes and input fields using `column_set` + `input` + `button` directly, without wrapping them in a `form`.
- **Correct layout pattern**: Use standalone div for text, `column_set` + `column` + `button` for buttons; wrapping in an `action` container is forbidden
- **The 200861 iron rule**: Any CardKit 2.0 schema card must never mix `tag: "action"` + `actions: [...]`, which returns a 200621 error and renders the entire card unusable

## Form Components

### Toggle in Right Column
- A toggle button for a boolean field in the right column must use `width: 'weighted', weight: 3`
- Do not use `width: 'auto'` — `auto` makes the button only as wide as its text, causing the right edge to be misaligned with select/input fields

### Input Component
- CardKit 2.0 `input` component has a built-in ✓ submit icon that triggers a callback
- However, `input_value` is dropped by the SDK normalizer; you must set `includeRawEvent: true` and read from `action.raw.action.input_value`
- Do not wrap input + button in a `form`; use `column_set` + `input` + `button` directly

## Button Components

- Buttons are placed directly under `body.elements` / `column.elements` / `tabs[].elements`
- **Forbidden** to wrap them in an `action` container (triggers 200861)
- Callbacks uniformly use `behaviors: [{ type: 'callback', value: { cmd, key } }]`

## Collapsible Panels

- Use `collapsible_panel` to wrap secondary information
- **Collapsing is a visual hide; the JSON payload still contains all content**, so the 28KB card budget must still be observed
- Do not assume that collapsing lets you stuff in more content

## Common Layout Templates

### Text + Button (Inline)
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

### Left Label + Right Input (Form Row)
```json
{
  "tag": "column_set",
  "columns": [
    {
      "tag": "column",
      "width": "weighted",
      "weight": 1,
      "elements": [{ "tag": "div", "text": { "tag": "plain_text", "content": "Label" } }]
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

## Debugging Tips

- Use `JSON.stringify(card)` to inspect the structure
- Check the 28KB limit with `enforceCardBudget()` before sending
- Feishu API error codes: 200621 (tag/structure error), 230025 (too many elements), 300123 (form missing submit)
