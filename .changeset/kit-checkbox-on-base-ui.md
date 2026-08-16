---
"@vendoai/ui": minor
---

Checkbox runs on Base UI.

`Checkbox.Root` / `Checkbox.Indicator` replace the native `<input
type="checkbox">`, so the checked state, the label association and the keyboard
come from `@base-ui/react` (pinned `1.7.0`) rather than from the browser's own
control — the same swap `Tabs`, `Switch` and `Radio` already made.

This is an internals swap, not an API change: `CheckboxProps` is unchanged to
the byte, and every prop a host or a generated screen passes behaves exactly as
before. The Quiet Precision look moved onto Base UI's parts through its
`style`-as-state callback, so the 16px box, the accent fill, the hairline edge
and the `[data-kit]:focus-visible` ring survive with no new stylesheet;
verified click-, keyboard- and focus-ring-wise in a real Chromium against
before/after screenshots.

One thing a consumer can see. Base UI renders the accessible control as a
`<span role="checkbox">` with a visually hidden `<input type="checkbox">`
beside it, so code that reached for the rendered node's `.checked` property
must now read `aria-checked`, and a query by label text matches both elements
rather than one. Nothing in the published API exposes either node.

`Select` stays on its native element.
