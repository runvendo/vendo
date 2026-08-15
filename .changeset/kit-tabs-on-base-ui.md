---
"@vendoai/ui": minor
---

Tabs runs on Base UI.

`@base-ui/react` (pinned `1.7.0`) is now a dependency of the Kit, and `Tabs` is
the first brick built on it: `Tabs.Root` / `List` / `Tab` / `Panel` replace the
hand-rolled tablist, so the roving tab order, the arrow/Home/End walk and the
tab↔panel `aria-controls` / `aria-labelledby` wiring come from the library
instead of from ~40 lines of this repo's own keyboard code.

`TabsProps` is unchanged to the byte, and so is the rendering: the Quiet
Precision inline styles moved onto Base UI's parts through its `style`-as-state
callback, which is how the selected tab's accent, fill and rule survive with no
stylesheet. Before/after screenshots of the bar in a real Chromium are
pixel-identical.

One behavior moved. A disabled tab is now reachable with the arrow keys (Base
UI marks it `aria-disabled` and leaves it in the roving order, for
discoverability) where the old bar skipped over it. It still cannot be
selected, by click or by Enter.

`Checkbox` and `Select` stay on their native elements — see the PR for why.
