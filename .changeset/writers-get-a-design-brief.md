---
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": patch
---

**Both writers get a design brief.** The screen agent and the `claudeCode()`
builder could name every component in the catalog and had nothing to say about
WHICH one, HOW MANY, or WHERE — so a screen was whatever the model reached for
first.

**The design law ships inside the skill.** `buildingAppsSkill` gains a
`## What a good screen looks like` section, written in `.vendo` terms rather than
CSS, because every one of these is a choice made in the plan: lead with the
answer, fewer parts and better ones, never say the same thing twice, bind the
rows as they come, group by what the person came to do, `col` is width and never
slicing, pick the chart by the shape of the data, a hole is a `<Cannot>`, the
words are the host's own, and an `<Island>` styles with the theme's CSS variables
and nothing else. One text, in the skill BOTH writers read, so `claudeCode()` and
the screen agent cannot be taught different design.

**The host's theme and design rules now reach both writers.** `apps.designRules`
and the theme tokens are documented seams a host sets and expects to be obeyed.
They reached the fill worker of the retired conductor and nothing else — so on
both live write paths those two config keys silently did nothing. The new
`hostDesignBrief` (exported from `@vendoai/apps`) renders that pair ONCE, and
composition hands the same string to both seams: the screen agent's brief,
through a `design` slot beside `system` on `ScreenInput` and
`ScreenAssemblerDeps`, and the composed prompt `claudeCode()` thinks with. The
slot is a thunk, not a value, so a rules change applies to the next screen rather
than the next boot.

Deliberately NOT inside `claudeCode()`: that harness thinks with `turn.system`
whole and alone and appends nothing after the host's prompt seam, so the prompt
seam is the only honest place for them.
