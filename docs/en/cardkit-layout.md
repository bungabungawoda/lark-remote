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
- CardKit 2.0 `input` has **no per-keystroke callback** — the callback fires only when the user submits (keyboard Enter/Done on mobile, the submit icon at the right end of the field on desktop); with no per-keystroke change event, "filter as you type" is not achievable
- **Never write "tap ✓" in user-facing copy**: that icon does not exist on mobile, which only has keyboard Enter/Done (user-reported 2026-09-19). Standardize on "press Enter to submit"
- **Do not rely on "clear the input and resubmit" as the cancel path**: the official docs never promise a callback for an empty string, and a user on mobile Feishu confirmed on 2026-09-19 that "clearing then pressing Enter does nothing" — treating it as the only cancel route dead-ends on some clients. When a clear/reset semantic is needed, carry it with an explicit `auto`-width button on the same row (a button callback carries no `input_value`; force the clear with a marker field in the payload instead of relying on the implicit "no input value received"). Reference implementation: `searchBar` in `src/router/card-helpers.ts` (renders a "Clear filter" button plus the `clearQuery` marker whenever `currentQuery` is set)
- However, `input_value` is dropped by the SDK normalizer; you must set `includeRawEvent: true` and read from `action.raw.action.input_value`
- Do not wrap input + button in a `form`; use `column_set` + `input` + `button` directly
- **Never squeeze a label and an input into one row**: when a row holds label + input + buttons, the `auto` buttons take their intrinsic width first and the rest is split by weight — on a narrow phone screen (roughly 330px usable) the label column shrinks to about a hundred pixels and the input to a few dozen, so the text wraps and the input is unusable (real pagination-bar defect, 2026-09-10). Split it into **two rows**: the informational label as a top-level `div` on its own full-width line, and the controls in their own `column_set` (previous `auto` + input `weighted weight:1` + next `auto`, the input filling the space left by the buttons). Reference implementation: `paginationBar` in `src/router/card-helpers.ts` (shared by `/ls` `/ws` `/resume` `/active` `/order`).
- **Do not wrap input + buttons in a `form`** (see above), and do not put the input as the second element of the label's column (same-column elements stack). Column widths use only `weighted`/`auto`; don't introduce pixel widths (e.g. `'90px'`) without verification

## Button Components

- Buttons are placed directly under `body.elements` / `column.elements` / `tabs[].elements`
- **Forbidden** to wrap them in an `action` container (triggers 200861)
- Callbacks uniformly use `behaviors: [{ type: 'callback', value: { cmd, key } }]`

## Collapsible Panels

- Use `collapsible_panel` to wrap secondary information
- **Collapsing is a visual hide; the JSON payload still contains all content**, so the 28KB card budget must still be observed
- Do not assume that collapsing lets you stuff in more content

## Narrow screens first (mobile), desktop too

The rendered card width is decided by the client and **is not visible to the
server**, so every layout must be designed for the narrowest case: a phone
content area of roughly 320–360 px (iPhone SE is narrower), while still looking
right on a wide desktop.

Hard rules:

- **Never place a short label and a long text side by side with
  `column_set` `auto` + `grow`.** The `auto` column gets squeezed to one or two
  characters and CJK text stacks vertically: the "运行\n中" seen on a phone
  (2026-10-19) came from exactly this.
- **Status lines / metadata = one `div` with ` · ` separators.** Line breaks
  then only happen at separators, which is predictable.
- **Keep each segment short enough that it never wraps on its own** (about 8
  display cells): `📊 ~36%`, `🧰 532 步`, `⏱ 2m13s` — not
  `📊 上下文使用率 ~36%`.
- **Put interactive controls at the end of the row** (a right `width:auto`
  column) only for **short labels plus normally wrapping text**: the button
  width is fixed and text wrapping is acceptable there.
- **Never share a row between a button and long unbreakable text**
  (commands/paths/URLs): the command's min-content width squeezes the `auto`
  button into `🟥…` (phone screenshot, 2026-10-21) and truncates the command
  itself. Give the full text its own `div`; when it is long, fold it into a
  `collapsible_panel` (the body keeps the full text) and put the button in a
  **single-column** `column_set` on the next line. A command is what the user
  verifies and copies, so never truncate it. Regression guard:
  `renderRunCard background jobs` in `src/card/run-renderer.test.ts`.
- After changing a card, check it at phone width. The regression guard for the
  status row lives in `src/card/run-renderer.test.ts`, section
  `status row narrow-screen layout` (single `div`, every segment ≤ 8 display
  cells, whole line ≤ 26).

Counter-example / correct example (run-card status row):

```jsonc
// ❌ "运行中" stacks vertically on a phone: the auto column is squeezed
{ "tag": "column_set", "columns": [
  { "tag": "column", "width": "auto", "elements": [{ "tag": "div", "text": { "content": "运行中" } }] },
  { "tag": "column", "width": "grow", "elements": [{ "tag": "div", "text": { "content": "🧰 工具调用中 · 📊 上下文 ~36%" } }] }
]}

// ✅ one line, one div; a narrow screen only breaks at " · "
{ "tag": "div", "text": { "tag": "lark_md", "content": "⏱ 12s · 🧰 532 步 · 📊 ~36%", "text_size": "notation" } }
```

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
- Before sending, check the 28KB limit **and** the element total with
  `enforceCardBudget()` / `countCardNodes()`
- Feishu API error codes: 200621 (tag/structure error), 300123 (form missing
  submit), 230099/11310 (**element total or markdown-table limit** — one code,
  two causes; see below)

### Card element total limit (measured against the real API, 2026-10-19)

`tests/feishu-live/feishu-card-element-total-limit.test.ts` measured, in the test
chat:

| Shape | Passes | Fails |
| --- | --- | --- |
| Flat top-level divs | 99 | 100 |
| Divs nested in one column_set column | 98 (+ the column_set = 99) | 99 (= 100) |
| Columns in one column_set | 66 | 67 |

The rule is **recursively counted `elements` array members (excluding `columns`)
≤ 99**. The whole-card JSON object count is **not** the criterion: the `/ws`
pagination card carries 227 JSON objects and still sends, while 100 flat divs
(205 objects) fails. Column count is an independent dimension (the 66/67
boundary); every card in this repo uses at most 3 columns, so it never applies.
Over-limit responses carry `230099` with an inner `ErrCode: 11310 element
exceeds the limit`.

**Correction**: the repo used to record `230025` as "too many elements". It
never appeared in this measurement; do not use it as the element-total
criterion. The older "/ws fails at 61 top-level elements" observation holds
because its 20 rows × (div + column_set + 2 buttons) count to 101 elements.

On the implementation side: `MAX_CARD_ELEMENTS = 90` (10% below the measured 99)
and `countCardElements()` in `src/card/card-budget.ts`, plus the element-trimming
branch of `enforceCardBudget()`; the run card enforces both budgets via
`withinRunCardBudget()` in `run-renderer.ts`, and its normal path drops the
oldest steps to stay inside the element budget (`selectVisibleGroups()`).
