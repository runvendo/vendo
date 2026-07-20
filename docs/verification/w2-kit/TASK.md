# W2 — the Kit (branch yousefh409/vendo-w2-kit)

RESUMABLE: commit per component. Authority: spec §The Kit. THE BAR (Yousef, explicit):
**the best component stack in generative UI — a strict SUPERSET of thesys Crayon /
Tambo / vercel json-render surfaces, then better on our axes** (host-brand-native via
theme tokens; action-gated interactivity; semantics-driven formatting; named-query empty
states; composable inside islands).

## Step 0 — inventory (1-2h, commit INVENTORY.md)
Enumerate Crayon's component list (docs.thesys.dev/library + crayon repo), Tambo's
templates, json-render examples, Tremor's catalog. Produce the superset target list with
our per-component prop sketch. Our v1 floor (spec): Stack/Row/Grid/Surface/Divider ·
Text/Money/DateTime/Percent/Num/EnumBadge · DataTable/CardList/Stat/Badge ·
Line/Bar/Donut/Sparkline/Progress · Input/Select/DatePicker/Form/Button/Disclaimer ·
Tabs. Add what they have that we lack (e.g. Crayon carousels/steppers/follow-ups —
judge fit) — mark each ADOPT/SKIP with one-line reason.

## Build (in packages/ui, new kit module; keep v1 prewired set intact — retirement is W5)
- TDD per component. Smart props per spec: DataTable = sortBy/limit/filterableBy/
  searchable/paginate/dot-path column keys/per-column format/named-query empty state
  (TanStack Table internals). Charts = data props only, recharts internals, formatted
  ticks, designed empty/invalid states ($NaN unrenderable). Value tier formats raw
  values via Intl (money takes CENTS). Select takes raw object arrays +
  labelField/valueField. Disclaimer: first-class, styled, takes reason text.
- Every prop schema (zod) classed `config | copy | data` + 1-2 sentence "when to use"
  + 1-2 canonical examples. **Generated prompt**: a `kitPrompt()` that renders the
  generation prompt section from the schemas (replaces hand-written lists later; just
  build + test the generator now, wiring into engine.ts is W3/W4's).
- Theme: host tokens (--vendo-color-*, fonts, radius) everywhere; porcelain defaults.
- Browser-verify: a gallery page (playground pattern exists) rendering every component
  in Maple + Cadence themes; screenshots committed (git add -f).

## Done
Gates green. PR to main, self-triage, auto-merge. Worktree comment "W2: N components,
superset of X/Y". Report: inventory verdicts + gallery screenshots.
