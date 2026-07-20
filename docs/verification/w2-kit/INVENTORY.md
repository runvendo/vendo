# W2 Kit — competitor inventory + superset target

Bar (Yousef, explicit): **the best component stack in generative UI — a strict
SUPERSET of thesys Crayon / Tambo / Vercel json-render surfaces, then better on our
axes.** Our axes: host-brand-native via theme tokens (not our brand); action-gated
interactivity (their components cannot mutate — ours carry approval-gated real host
actions); semantics-driven formatting (cents/dates/enums arrive correct, never
prompted); named-query empty states; composable inside islands; every prop
zod-schema'd + classed `config | copy | data`; the model-facing prompt is GENERATED
from those schemas, not hand-written.

## What they ship

### thesys Crayon / C1 (docs.thesys.dev/library)
Four categories, model fills props:
- **Informational**: Card, Image, CodeBlock, Callout, Text blocks, ListBlock
- **Forms**: Input, Select, form controls
- **Triggers / control**: Button(s), **FollowUpBlock** (follow-up prompt chips)
- **Data viz**: Chart (Vega-backed), Table (DataTable)
- **Interactive**: Carousel, Accordion, Tabs, Steps/Stepper
Weakness vs us: charts are Vega config blobs (model must author spec), no
cents/date/enum semantics, no host actions, no named-query empty states.

### Tambo (ui.tambo.co) — closest philosophical peer
- **Chat/thread blocks**: MessageThread (full/collapsible/panel), ControlBar,
  Thread History, Message, MessageInput, Elicitation — chrome, not app components
- **Generative**: Form, Input fields, **Graph**, **Map**
- Registers components with **Zod schemas** (same idea as ours; we go further — the
  schema is also the prompt source and the class tag for law-1 enforcement)
Weakness vs us: thin data/value tier (one Graph, one Form), no smart DataTable, no
semantic formatting, thread surfaces are the product not the app.

### Vercel AI SDK RSC / json-render (ai-sdk.dev streamUI)
Not a fixed catalog — `streamUI` streams whatever components you register as tools,
with a `yield` loading skeleton. The "surface" is the streaming+skeleton *pattern*,
not a component set. RSC path is now paused/experimental.
Superset move: we already own the pattern (instant paint / forming-skeleton / section
writers) AND ship a fixed, validated component set on top.

### Tremor (tremor.so) — richest dashboard catalog (35+); our data/chart bar
- **Charts** (recharts-backed): AreaChart, BarChart, LineChart, ScatterChart,
  PieChart, DonutChart, Sparkline, **Tracker**, ProgressBar/Circle, **BarList**
- **Data**: Card/KPI (metric + delta), Badge, Callout, Table, List, Legend
- **Layout**: Grid, Col, Flex, Divider, Title, Text
- **Interactive/forms**: TabGroup, Accordion, DateRangePicker, DatePicker, Button,
  TextInput, NumberInput, Textarea, Select, MultiSelect, SearchSelect, Switch
Weakness vs us: not brand-tokenized per host, no host actions, no semantics (you pass
`valueFormatter` every time), no named-query empty states, no generation prompt.

## The superset target — SHIPPED list (ADOPT) + verdicts

Legend: floor = in spec's v1 floor. extra = beyond floor, judged in.

### Layout (5) — all floor
Stack · Row · Grid · Surface · Divider — ADOPT (floor). Covers Tremor Grid/Col/Flex,
Crayon containers.

### Values (6) — all floor. **Our differentiator: semantic, Intl-formatted.**
Text · Money (takes **cents**) · DateTime · Percent · Num · EnumBadge — ADOPT (floor).
Nobody else has a semantic value tier; competitors format ad-hoc in every call.

### Data (4) — all floor
- **DataTable** — ADOPT (floor, flagship). TanStack Table internals:
  sortBy/limit/filterableBy/searchable/paginate/dot-path column keys/per-column
  `format`/**named-query empty state**. Strict superset of Crayon Table + Tremor Table.
- CardList — ADOPT (floor). Covers Crayon Carousel's job without horizontal-scroll UX.
- Stat — ADOPT (floor). = Tremor KPI card (metric + delta/trend).
- Badge — ADOPT (floor).

### Charts (5) — all floor. recharts internals, `$NaN` unrenderable, formatted ticks.
LineChart · BarChart · DonutChart · Sparkline · Progress — ADOPT (floor). Data props
only (no Vega spec, no valueFormatter plumbing). Covers Tremor Area/Bar/Line/Donut/
Spark/Progress and Crayon Chart.

### Forms (6) — all floor
Input · Select (over **raw object arrays** via labelField/valueField) · DatePicker ·
Form · Button (**action-gated** — names a host tool) · **Disclaimer** (first-class,
the legal move when no tool backs the ask) — ADOPT (floor).

### Interactive / feedback
- Tabs — ADOPT (floor). Self-managing.
- **Callout** — ADOPT (extra). Info/success/warning notice; cheap; needed to superset
  Crayon Callout + Tremor Callout. Distinct from Disclaimer (which is the honesty arm).
- **Accordion** — ADOPT (extra). Self-managing collapsible sections; supersets Crayon/
  Tremor Accordion; genuinely useful for long apps. Low cost.
- **Checkbox** — ADOPT (extra). Completes the forms story (boolean input) for superset.
- **Textarea** — ADOPT (extra). Multiline input; superset of Tremor Textarea.

### Judged SKIP (with reason)
- **Carousel** (Crayon) — SKIP. Horizontal scroll hides business data; CardList is the
  better move on our surfaces.
- **Stepper/Steps** (Crayon) — SKIP. Multi-step wizards are stateful → island territory;
  Progress covers linear progress display.
- **FollowUpBlock** (Crayon) — SKIP. Follow-up prompts are a chrome/thread concern,
  already owned by `@vendoai/ui/chrome`, not a generated-app component.
- **Map** (Tambo) — SKIP. Needs a tile provider + heavy dep; not core to host business
  data; an island can mount one when a host truly needs it.
- **CodeBlock** (Crayon) — SKIP. Business apps rarely surface source; islands cover it.
- **ScatterChart / Tracker / BarList** (Tremor) — SKIP as separate components. Scatter is
  niche for business dashboards; Tracker is uptime-specific; BarList's job is served by
  BarChart(horizontal) + DataTable.
- **MultiSelect / SearchSelect** (Tremor) — SKIP as separate; folded into `Select`
  (`multiple`, `searchable` props) to keep one selection component.
- **Image** (Crayon) — SKIP for v1. Avatars/logos ride inside DataTable/CardList cells;
  a dedicated Image adds little and invites layout misuse. Revisit if corpus demands it.
- **PieChart** (Tremor) — SKIP. DonutChart is the same family; a `donut=false` variant
  covers full-pie if ever needed.

## Count
**26 components shipped** (5 layout + 6 values + 4 data + 5 charts + 6 forms) with 4
interactive/feedback extras (Tabs counted in forms group is separate → Tabs + Callout +
Accordion + Checkbox + Textarea). Every one is theme-tokenized, semantics-aware where it
carries values, zod-schema'd, and classed `config | copy | data`; the generation prompt
is rendered from the schemas by `kitPrompt()`. This is a strict superset of Crayon and
Tambo's app-component surfaces and matches Tremor's data/chart depth while adding
semantics, host actions, named-query empty states, and a generated prompt none of them
have.
