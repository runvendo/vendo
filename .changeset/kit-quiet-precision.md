---
"@vendoai/ui": minor
---

Quiet Precision — every Kit brick restyled against the theme v2 tokens.

The Kit had its taste written in literals: `1px solid`, `fontWeight: 650`, four
different hand-rolled `box-shadow` blurs, `letterSpacing: "-0.011em"` copied
into six files. A host that set `borderWidth`, `weightEmphasis` or `shadow.small`
changed nothing, because nothing read them.

Now one edge, one lift, one type ramp, and all three come off the host's theme:

- `hairline` is the ONE edge — `--vendo-border-width` over `--vendo-color-border`.
  Borders do the work shadows used to, so Card, Surface, CardList and the tabs
  indicator are flat. The single remaining lift is a filled Button, and it paints
  `--vendo-shadow-small` rather than a literal.
- `microLabel` is the ONE micro-label — letterspaced uppercase, for the things
  that are chrome and not content: a column header, a table caption, a Stat's
  metric name, a Progress label, `<Text variant="label">`. Caption text stays
  sentence-case; it carries model-authored sentences.
- Weights, line-heights and letter-spacing come from
  `--vendo-font-weight-normal/-emphasis`, `--vendo-line-height(-heading)` and
  `--vendo-letter-spacing`, so a brand's type voice reaches the Kit.
- Figures are tabular everywhere — the whole DataTable, not just its formatted
  columns.
- `transitionFor()` builds every transition on `--vendo-motion-duration` and
  `--vendo-motion-easing`, so `motion: "reduced"` (which emits `0ms`) collapses
  the tabs glide, the accordion chevron and the progress fill with no branch.
- A neutral Stat loses its 3px rule: `toneColor("neutral")` is the foreground
  itself, and a near-black bar on every resting tile is the opposite of quiet.
  A toned tile keeps it.
- Chart tooltips and axis ticks read the tokens instead of re-spelling them.

No prop changed on any brick. The `fluidkit` and `motion` dependencies, the
vitest alias that stubbed them and `test/mocks/fluidkit.tsx` are deleted — the
last import of either was gone.
