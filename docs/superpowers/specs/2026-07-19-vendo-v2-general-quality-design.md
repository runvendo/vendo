# Vendo v2 generation quality — the generalization redesign

Status: DRAFT for Yousef's review. Output of the 2026-07-19 brainstorm following the
held-out gate. Supersedes the micro-op fix direction; complements (does not replace)
the v2 format spec (`2026-07-18-vendo-v2-format-spec.md`) — wire, compiler, ids,
tier-0 lane, approval gates all stay.

## 1. Why: what we measured

- Dev-set matrix (6 prompts, iterated 4×): went 2/6 → 6/6-equivalent via five merged PRs
  (#385 prop schemas, #386 speed, #387 asOptions/currencyCents, #388 island-gate/honesty,
  #397 template op).
- **Held-out gate (30 fresh prompts, zero tuning, one attempt each): 11/30**
  (Maple 2/15, Cadence 9/15). Evidence: branches `vendo-heldout-maple`/`-cadence`.
- The split is the finding: **zero of 30 failures came from compile-enforced classes**
  (Select projection, object cells, action payloads, jail imports). Every prompt-held
  behavior cracked. The compile layer generalizes; instructions don't.
- Held-out failure classes, by frequency:
  1. Money-scale in derived slots ×7 (raw cents in stat tiles/donut centers/sums; incl.
     comma-formatted cents-as-dollars "$5,490,715.00" and one "$NaN")
  2. Core-ask-not-computed ×5 ("largest 10" → unsorted dump; "remaining" → "—";
     "per staff" → flat list — the tree cannot sort/limit/group/derive by design)
  3. Impossible-prompt fabrication ×3 (invented FX rates; document data relabeled as
     payroll/invoice dashboards, no disclaimer) — honesty held when the *action tool*
     was missing (2/2) but failed when the *data domain* was missing (0/3... 2/5 total)
  4. Invented/mislabeled controls ×3 (a "From account" selector for a parameter the
     transfer tool does not have — twice on money-moving actions)
  5. Dead controls ×2 (filter Selects/tabs render but do nothing — no client-state wiring
     exists in the dialect)
  6. Smaller: dotted column keys unresolved while `template` resolves the same path
     (dialect inconsistency); silent-empty-despite-data (wrong query); layout clipping;
     raw ISO date in hero; entity leak; TZ off-by-one.
- Cross-cutting engine bug: **approved actions stall at "Running"** — after human
  approval the action never resumes (C4, C11). Breaks every gated mutation.

## 2. Principles (the learnings, now design law)

1. **Enforcement generalizes; guidance doesn't.** Correctness lives in code that
   executes or validates deterministically — never in prompt instructions alone.
   Prompt guidance is a UX hint, not a correctness mechanism.
2. **Bespoke vocabulary is the overfitting engine.** Every op we invented
   (`asOptions`, `template`, `currencyCents`, dotted keys) is syntax with zero
   pretraining mass — a permanent teaching tax the model keeps mispaying. Ride the
   model's pretraining distribution (JSX, JS, real libraries, plain props); never
   invent grammar when a native surface exists.
3. **Values must not transit the model.** The model routes *references*; raw values
   flow tool → component; components format deterministically. A model-written
   display string is where scale/format bugs are born.
4. **Compute lives in real code** — our components, sandboxed islands, or a server.
   Never in the model's head, and never demanded of a layer that cannot compute.
5. **Honesty is structural.** Fabrication must be inexpressible (data slots can only
   render what a real query returned), not discouraged.
6. **Dumb components force the model to be smart; smart components let it be dumb.**
   The model is excellent at configuring well-described props (measured) and bad at
   computing. Move intelligence into components; leave configuration to the model.

## 3. Architecture overview (what changes, what stays)

Unchanged: JSX wire format; deterministic compiler owning ids/validation/repair
routing; canonical `vendo-genui/v2` tree; sandboxed brand-native renderer; tier-0
paint lane; guarded actions + approval gates; rung ladder (2–4 server apps); repair
loop; owned-serving roadmap.

Changed (the five moves):

1. **Smart Component Kit** replaces the dumb prewired set (§4).
2. **Furnished jail** re-scopes islands from "demonized last resort" to "fenced escape
   hatch with batteries" (§5).
3. **Semantic sync** — shape cards carry meaning (units, dates, enums, ids) plus a
   host domain manifest; the catalog prompt is generated, never hand-written (§6).
4. **Bind-only data props** — the single mechanism behind both structural honesty and
   values-not-transiting (§7).
5. **Dialect retirement** — the invented micro-op vocabulary shrinks away (§8).

Generated-code posture (three tiers):
- **Tier A (~95% of apps): no generated code.** The model emits the JSX wire — a spec
  of Kit + host components with props and bindings. Looks like code, is data; the
  compiler validates it, the renderer executes it.
- **Tier B (custom tail): islands.** The only model-written executable code on the
  client. Small display-only React components in the jailed iframe; imports limited
  to react + bundled kit libs; size-capped; no authority (cannot call tools).
- **Tier C (rungs 2–4, unchanged): server code** in sandboxed machines, for apps that
  graduate to owning a backend.

## 4. The Smart Component Kit (the centerpiece)

Replace the current prewired primitives with a kit where components own compute,
formatting, interaction, and empty states internally. The model configures; the
component executes.

### 4.1 What "smart" means, per failure class
- **Sorting/limiting/grouping are props, not model work.** `DataTable` accepts
  `sortBy`, `limit`; chart/list components accept `groupBy` + an aggregate mode.
  The component sorts/groups deterministically in our code. Kills class 2 without
  any new language: it is just zod-described props, which the model demonstrably
  handles once schemas are provided (#385's proof).
- **Filtering/search/tabs live INSIDE components.** `DataTable` ships its own
  filter/search UI (`filterableBy`, `searchable`); a tabbed container manages its own
  active tab. The model never wires a Select to a Table — there is no wiring to get
  wrong. Kills class 5 (dead controls) structurally.
- **Formatting is component-owned.** Value components (`Money`, `DateTime`, `Percent`,
  `Num`) and per-column `format` on tables take RAW values plus semantics (from §6)
  and run Intl internally. Kills class 1 wherever the tree renders a value.
- **Nested access is component-native.** Column keys and label/value fields accept
  dot-paths resolved by component code (`labelField="assignee.name"`), replacing both
  the failed dotted-key compiler feature and the `template` op for the common case.
- **Empty states are built in and honest.** Every data component renders a designed
  empty state naming its query ("No transactions matched `payments.list`") — silent
  wrong-query emptiness (M4) becomes visible and diagnosable.
- **Derived-value slots accept simple references only.** Stat tiles take a bound raw
  value + format; where a genuine computation is needed (budget − spent), the ask
  routes to an island (§5) — never to model arithmetic.

### 4.2 Kit contents (v1 surface)
- Layout: Stack, Row, Grid, Surface, Divider (unchanged, already fine).
- Text & values: Text, **Money, DateTime, Percent, Num, EnumBadge** (new value tier).
- Data: **DataTable** (sort/limit/filter/search/paginate/format/nested-keys/empty-state),
  **CardList/Grouped list**, Stat, Badge.
- Charts: **Line, Bar, Donut/Pie, Sparkline, Progress** — data props only
  (`series`/`segments` + `x`/`y`/`groupBy`/`agg` + format hints), internally rendered
  (recharts internals), self-labeling axes with formatted ticks, designed empty state.
- Forms & actions: Input, Select (labelField/valueField over raw arrays), DatePicker,
  Form + Button (actions remain tree-level, guard-checked, approval-gated),
  **Disclaimer/NotAvailable** (the honest-fallback component, first-class and styled).
- Tabs/sections: self-managing.

### 4.3 Internals decision
Build the Kit ourselves (brand-native: host theme tokens, porcelain defaults), with
battle-tested logic libraries INSIDE our components — TanStack Table for table
mechanics, recharts for chart rendering — rather than adopting a styled kit (Tremor)
wholesale. We keep total brand control and a stable prop contract; the hard logic is
not hand-rolled. The kit is versioned; the catalog prompt regenerates from its schemas
on every change.

### 4.4 Kit contract (what makes it enforceable)
Every component ships: a zod prop schema where each prop is classed
`config | copy | data` (§7 uses this), semantics-aware format props, a one-to-two
sentence "when to use" description, and 1–2 canonical usage examples. The generation
prompt for the kit is GENERATED from these — hand-written prompt lists are abolished
(thesys/json-render `catalog.prompt()` pattern).

## 5. Furnished jail; islands as the fenced escape hatch

- Bundle vetted libraries INTO the jail as allowlisted imports (they ship with the
  runtime; nothing is fetched): `@vendo/charts` (recharts-based, same visual language
  as the Kit charts), `@vendo/kit` (fmt helpers: moneyCents, date, percent; misc
  utilities), react/react-dom (as today).
- Re-scope the island rule from "LAST RESORT, never for data" (a v1-era overcorrection
  that caused class 2's worst cases) to: **"Use the Kit for anything it covers. Use an
  island for a custom visual or a derived region the Kit cannot express — small,
  display-only, one region."**
- Gates stay and extend: import allowlist (react + the two bundled libs), byte caps,
  export-default check, TSX syntax gate, **display-only enforced** (no tool calls, no
  action dispatch from island code — anything mutating stays in the tree), props are
  the only data entry point (bound query data, shape-checked at the boundary).
- The trade, stated honestly: island internals are code, not provable by shape-check.
  This is the *fenced* generality valve — industry consensus (thesys essay; v0 needing
  a trained AutoFix model) says don't make it the main path, and we don't.

## 6. Semantic sync + generated context (the B work)

At `vendo sync` (already the host's extraction step), capture MEANING alongside shapes:

- **Field semantics** on every tool response field: `money(cents|dollars, currency)`,
  `date(iso|epoch)`, `enum(value → label map)`, `id(entity)`, `percent(0-1|0-100)`,
  plain. Sources, in priority order: host annotations (one-line decorators/config in
  the host's vendo config), inference from field names + sampled values (\*Cents,
  ISO-looking strings — inferred ONCE at sync, reviewed in the generated file, never
  guessed per-generation), defaults to plain.
- **Domain manifest**: the positive list of data domains the host's tools cover
  (derived from tool names/descriptions at sync, host-editable) — surfaced to
  generation as fact: "This host has: accounts, transactions, budgets, payees.
  It has NO: payroll, invoices, crypto, FX." The honest-disclaimer path stops being
  a judgment call.
- **Generated catalog prompt**: the entire component/tool context (Kit schemas §4.4,
  host component schemas, tool list + shapes + semantics, domain manifest) is
  program-generated from these artifacts. Prompt content becomes a build product with
  a diffable source of truth; hand-edited prompt lists are retired.
- Semantics feed three consumers: Kit components auto-format (`Money` reads
  `money(cents)` and needs no per-use hint), compile checks (§7 can type value slots),
  and the model's context (it stops guessing units).

## 7. Bind-only data props (structural honesty + values-not-transiting — one mechanism)

The single rule: **a `data`-classed prop must be a binding to a declared Query result.**

- Prop classes come from the Kit contract (§4.4) and host catalog schemas:
  - `config` — knobs (limit, sortBy, variant, columns spec): literals expected.
  - `copy` — human text (titles, captions, disclaimers): model writes freely.
  - `data` — anything rendered as business data (rows, options, series, segments,
    stat/value slots, Money cents): **must be `{query.path}` bindings.** A literal
    array/object/number here is a compile error routed to repair.
- Consequences, by class:
  - Fabrication becomes inexpressible (class 3): an invented FX table cannot be
    written — no query yields FX data, so repair converges on the `Disclaimer`
    component (which is `copy`, where the model is free and harmless).
  - Model-written display strings die (class 1's transit half): value slots are typed
    raw (number cents) by §6 semantics, so "$5,490,715.00" fails the schema type
    check; the number arrives via binding and the component formats it.
  - Silent-empty gets diagnosable (M4): data props name their query; the component's
    empty state says which query returned nothing.
- Action-side counterpart (kept from #388, extended): mutating actions must bind a
  payload; submit-shaped buttons must either carry a real action or be replaced by
  `Disclaimer`; **new — control-grounding check**: a form control bound into an
  action payload must correspond to a parameter in the target tool's input schema
  (kills class 4's invented "From account" selector — the tool has no such parameter,
  so the control is flagged at compile).
- Escape valve: demo/preview data is a legitimate need (playgrounds); it enters
  through a declared sample-data query source, never through literals — the rule has
  no exceptions, the *sources* vary.

## 8. Dialect retirement

- Deprecate `asOptions`, `template`, `currencyCents` format kind, and compiler-level
  dotted column keys. Their jobs move into Kit component internals (§4.1): Select's
  labelField/valueField over raw arrays, dot-path resolution in component code,
  semantics-driven Money/date formatting.
- The reshape pipe shrinks back toward its Wave-3 core (`pick`, `rename`, `asPoints`
  where charts still want it) and no new ops are added — any pressure for a new op is
  a signal the Kit is missing a prop or the case belongs in an island.
- Removal is staged: mark deprecated in the prompt immediately (stop teaching them),
  keep compiling them for stored apps, delete after the Kit migration completes.

## 9. Eval infrastructure (the permanent fixture)

- The 30-prompt held-out corpus is FROZEN as the golden set (plus the 6 dev-set
  prompts, labeled as dev). It is never tuned against; each fix wave is judged on it
  once, and any prompt that gets discussed in a fix PR moves to the dev pile.
- Grow a rotating FRESH pool: every gate run adds ~10 never-seen prompts (new
  categories over time: multi-part asks, edits, cross-tool joins, adversarial
  phrasing, non-dashboard shapes).
- Negative prompts are a first-class category (OpenAI golden-set discipline): asks the
  host cannot serve, scored on honest handling.
- Metric: error-free rate (browser-judged, screenshot evidence, PASS bar as defined in
  the held-out CORPUS.md) + per-class breakdown + timing. Report the arc honestly on
  every wave.
- Judging stays browser-real (production boots, real generations, committed
  screenshots) — the discipline that caught everything unit tests missed.

## 10. Engine fix (orthogonal, ships first)

Approved actions stall at "Running" (approve → resume path broken; C4/C11). This
breaks every approval-gated mutation in production regardless of generation quality.
Diagnose and fix in `@vendoai/actions`/runtime; add an e2e test that approves a gated
action and asserts the effect lands (the current e2e stops at "approval requested").

## 11. Failure class → mechanism map (the analyzability table)

| Held-out failure class | Killed by | Mechanism type |
|---|---|---|
| Raw cents / cents-as-dollars in derived slots (×7) | §4 value components + §6 semantics + §7 raw-typed value slots | enforce + execute |
| Core-ask-not-computed: sort/limit/group/derive (×5) | §4 smart props (sortBy/limit/groupBy); islands for arbitrary derivation (§5) | execute |
| Fabrication on missing domains (×3) | §7 bind-only data props + §6 domain manifest + Disclaimer component | enforce (structural) |
| Invented/mislabeled controls (×3) | §7 control-grounding check vs tool input schemas | enforce |
| Dead filters/tabs (×2) | §4 internal-filter components (no wiring exists to break) | execute |
| Dotted-key vs template inconsistency | §8 retirement + §4 component-native dot-paths | simplify |
| Silent-empty-despite-data | §4 named-query empty states | execute + surface |
| Raw ISO dates / raw enums | §6 semantics + §4 DateTime/EnumBadge auto-format | execute |
| Approve→resume stall (engine) | §10 | bugfix |
| $NaN error blobs | §7 raw typing + §4 chart empty/invalid states | enforce + execute |

Residual risks named: island internals are unproven code (fenced, display-only);
copy props remain free text (a model could write a misleading caption — accepted;
captions carry no data); semantics inference can mislabel a field (mitigated by
sync-time review file + host override).

## 12. Rollout (broad waves — plans come from writing-plans)

1. **Wave 0 — engine fix (§10)** + freeze the golden set (§9). Small, urgent.
2. **Wave 1 — Kit core**: DataTable + value components + Select/labelField + Disclaimer;
   prop-class contract; generated kit prompt. Gate: fresh-prompt mini-corpus.
3. **Wave 2 — semantic sync + bind-only data props** (§6 + §7 land together — the
   check needs the semantics). Gate: negative prompts + the money classes.
4. **Wave 3 — charts tier + furnished jail** (§4 charts, §5 bundles + re-scoped island
   rules). Gate: chart-heavy + derivation prompts.
5. **Wave 4 — dialect retirement (§8) + full held-out re-gate** on the frozen 30 +
   ~10 fresh. Report the arc.

## 13. Open questions (parked, not blocking)

- Cross-component reactive state (a filter OUTSIDE a table driving it): deliberately
  deferred — internal-filter components cover the measured cases; revisit with
  evidence from fresh corpora before inventing a state dialect.
- Kit versioning vs stored apps (old apps reference old prop contracts): compiler
  carries per-version schemas; details in the Wave-1 plan.
- Cadence/Maple speed asymmetry + repair-round latency: unchanged by this spec;
  owned-serving remains the endgame per the format spec.
- How much of the host's own catalog should adopt the prop-class contract: catalog
  entries already carry schemas; classing their props is additive at sync — scope in
  Wave 2.

## 14. Relationship to the market (context for the bets)

Borrowed: spec-not-code main path (thesys conviction + essay), catalog-generated
prompts (json-render/OpenUI), smart chart components with data props (Crayon/Tambo),
format-enum props + component-side Intl (json-render/Retool), golden-set + negative
prompts (OpenAI Apps), streaming drop-invalid/last-good discipline (OpenUI).
Rejected: bespoke line-DSLs and closed compute vocabularies (`@Sum/@Filter`) — the
teaching-tax argument (§2.2); LLM-roundtrip interactivity.
Different (the moat): host-native rendering (their apps look like thesys; ours look
like the host), real guarded authority (approval-gated host-API actions vs
send-values-to-the-LLM), durable app artifacts with a server ladder, and the fenced
island escape hatch (pure spec systems cannot express custom visuals at all).
