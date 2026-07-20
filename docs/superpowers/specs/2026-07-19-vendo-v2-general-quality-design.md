# Vendo app format v3 + generation quality — the generalization redesign

Status: DRAFT v2 for Yousef's review (rewritten after the format brainstorm converged).
Output of the 2026-07-19 brainstorm following the held-out gate (11/30). Supersedes the
micro-op fix direction AND revises parts of the v2 format spec
(`2026-07-18-vendo-v2-format-spec.md`): compiler-owned ids, streaming, tier-0 lane,
brand-native sandboxed rendering, approval gates, and the rung ladder all stay; the
data surface, island rules, and prewired set change as specified here.

## 0. The whole design in five lines

The model builds an app out of three things:
1. **Our components** (the Kit) — smart and branded; they sort, filter, paginate, and
   format themselves. The model fills in props.
2. **Its own small React components** (islands) — for anything the Kit doesn't cover.
   Full React, sandboxed, with the Kit and the host's tools in scope.
3. **The host's tools** — the only source of data and the only way to act.

Two laws keep it honest:
- **Law 1 — screen data traces to a tool call.** The model cannot type business data
  in by hand; no tool for the ask → the styled `Disclaimer` is the only legal move.
- **Law 2 — every app's tool surface is statically readable, and every call flows
  through the one gated pipe** (guard + approval), whether fired from the tree or
  from island code.

Everything else in this spec is plumbing for those five lines.

## 1. The format (v3) — by example

A complete app; every feature of the format appears once:

```jsx
<App name="Overdue Invoices">
  <Stack>
    <Text variant="heading">Overdue Invoices</Text>

    <Stat label="Total overdue"
          value={invoices.list({status:"overdue"}).totalCents} format="money"/>

    <DataTable rows={invoices.list({status:"overdue"}).data}   // same call → one fetch (dedupe)
       sortBy="dueDate asc" limit={20} filterableBy={["client"]} searchable
       columns={[
         { key: "client.name", label: "Client" },
         { key: "amountCents", label: "Amount", format: "money" },
         { key: "dueDate",     label: "Due",    format: "date" },
       ]}/>

    <Button label="Remind all" onClick="invoices.sendReminders"/>

    <ClientLookup/>
  </Stack>

  <Island name="ClientLookup">
    export default function ClientLookup() {
      const [q, setQ] = useState("");
      const [hits, setHits] = useState([]);
      async function search(text) {
        setQ(text);
        const res = await tools.clients.search({ q: text });   // ambient tools API
        setHits(res.data);
      }
      return (
        <Stack>
          <Input label="Find a client" value={q} onChange={search}/>
          <DataTable rows={hits} columns={[{key:"name"},{key:"balanceCents",format:"money"}]}/>
          <Button label="Send reminder"
                  onClick={() => tools.invoices.sendReminders({ ids: hits.map(h => h.id) })}/>
        </Stack>
      );
    }
  </Island>
</App>
```

### 1.1 Components
Resolution order: **host catalog** (the host's real branded components, schemas from
`vendo sync`) → **Kit** (ours, §3) → **islands** (model's own). Host brand wins name
collisions. The model emits JSX; the compiler mints ids, validates, and produces the
canonical tree exactly as in the v2 spec.

### 1.2 Data — inline tool references (pending measurement)
Data enters as **inline tool references in props**: `rows={invoices.list({...}).data}`.
References are parsed data, never executed code: the compiler statically extracts every
reference, checks tool name + input shape against the live registry (unknown tool →
repair), and the runtime fetches on first reference with dedupe by tool+args.
Rationale: declare-at-use matches autoregressive generation (upfront `<Query>` blocks
force the model to plan all data needs before writing the UI — a measured failure
source: declared-but-unused queries, wrong-query-silent-empty), and it removes one of
the format's two data concepts.

**Open experiment (Wave 1 gate):** bench inline references vs declared `<Query>` on
reliability and paint timing. Expected: inline wins or ties (prefetch head start of
declarations ≈ ~100 tokens against a multi-second stream). If the measurement
surprises us, `<Query>` stays and inline is dropped — decided by data, not taste.

### 1.3 Actions
`on*` props naming a host tool (`onClick="invoices.sendReminders"`), unchanged
semantics: guard-checked, approval-gated at dispatch, mutating actions must bind a
payload, and controls feeding a payload must correspond to real parameters of the
target tool's input schema (kills the invented-"From account"-selector class).

### 1.4 Islands — full React with the Kit and tools in scope
- **One island = one file = one component.** Full React inside (state, effects,
  handlers, SVG, canvas, animation).
- **Ambient scope, no imports.** React + hooks, the entire Kit, charts, and `fmt`
  helpers are in scope (react-live pattern). Compile rule: island code contains **no
  import statements** — known specifiers are silently stripped (pretraining habit),
  unknown ones are compile errors → repair. The import/loader attack surface is gone
  rather than allowlisted.
- **Ambient `tools` API — direct calls.** `await tools.clients.search({ q })`.
  One syntax rule makes this safe: **literal member access only**
  (`tools.<name>.<name>`; `tools[expr]` is a compile error). The compiler scans island
  source, infers the island's tool manifest, validates every name against the
  registry (→ repair), stamps the manifest into the canonical app, and the runtime
  exposes **only the manifest's tools** to that island — least privilege by
  construction. Reads execute per read policy; mutations pause at the same approval
  gate as tree buttons. Static enumerability of the app's powers is preserved: tree
  actions are attributes; island tools are the inferred manifest.
- **Sandbox fences (mechanical, unchanged):** no network egress (CSP; imports can't
  express a fetch either), no host-page DOM access (iframe sandbox), byte caps,
  TSX syntax + default-export gates.
- Islands may compose Kit components inside custom logic — "custom" never means
  "off-brand": theme tokens flow via CSS variables already present in the iframe.

### 1.5 Run anything — the ladder
| Need | Where it runs |
|---|---|
| Standard UI | Kit/host components — no code |
| Custom visuals, client logic, rich interaction, dynamic reads | Island — React in the iframe sandbox |
| Heavy compute, cross-tool joins, private logic | `fn:` server functions — sandboxed machine; tree/islands reference them like tools |
| A real application (routing, jobs, storage) | Rung 4 — full app on its own machine |

Same two laws at every rung. Complexity climbs the ladder; no rung's rules bend.

## 2. Principles (measured, now design law)

1. **Enforcement generalizes; guidance doesn't.** Held-out gate: zero of 30 failures
   came from compile-enforced classes; every prompt-held behavior cracked.
2. **Bespoke vocabulary is the overfitting engine.** Every invented op (`asOptions`,
   `template`, `currencyCents`, dotted keys) is syntax with no pretraining mass — a
   permanent teaching tax. Ride the model's distribution: JSX, plain props, real JS,
   `await tools.x.y()`. Never invent grammar where a native surface exists.
3. **Values must not transit the model.** The model routes references; raw values flow
   tool → component; components format deterministically.
4. **Compute lives in real code** — Kit internals, island JS, or a server. Never in
   the model's head; never demanded of a layer that cannot compute.
5. **Honesty is structural.** Fabrication must be inexpressible, not discouraged.
6. **Dumb components force the model to be smart; smart components let it be dumb.**
   The model is excellent at configuring described props and bad at computing.

## 3. The Kit (smart components)

Replaces the dumb prewired set. Components own compute, formatting, interaction, and
empty states; the model configures.

- **Per failure class:** sorting/limiting/grouping are props (`sortBy`, `limit`,
  `groupBy`+agg) executed in component code · filter/search/tab UI lives INSIDE
  components (`filterableBy`, `searchable`) so there is no wiring to get wrong ·
  formatting is component-owned (`format="money|date|percent"` + the value tier
  `Money/DateTime/Percent/Num/EnumBadge`) driven by field semantics (§4) · column
  keys and label/value fields accept dot-paths resolved in component code · every
  data component ships a designed empty state naming its query ("No rows from
  `payments.list`") so silent-wrong-query becomes visible.
- **v1 surface:** layout (Stack/Row/Grid/Surface/Divider) · text+values
  (Text, Money, DateTime, Percent, Num, EnumBadge) · data (DataTable, CardList, Stat,
  Badge) · charts (Line, Bar, Donut, Sparkline, Progress — data props only, recharts
  internals, formatted ticks, designed empty/invalid states; a `$NaN` is impossible to
  render) · forms+actions (Input, Select with labelField/valueField over raw arrays,
  DatePicker, Form, Button, **Disclaimer** — the styled honest-fallback, first-class) ·
  self-managing Tabs.
- **Internals decision:** build ours (brand-native, host theme tokens), with
  battle-tested logic libraries inside — TanStack Table mechanics, recharts rendering —
  not a styled kit (Tremor) wholesale.
- **Contract:** every component ships a zod prop schema with per-prop class
  `config | copy | data` (§5), a 1–2 sentence "when to use", and 1–2 canonical
  examples. The generation prompt for the Kit is **generated from these schemas**
  (`catalog.prompt()` pattern); hand-written prompt lists are abolished. Kit is
  versioned; stored apps pin their kit version (compiler carries per-version schemas).

## 4. Semantic sync + generated context

At `vendo sync` (the host's existing extraction step), capture meaning alongside shape:

- **Field semantics** per tool response field: `money(cents|dollars, currency)`,
  `date(iso|epoch)`, `enum(value→label map)`, `id(entity)`, `percent(0-1|0-100)`,
  plain. Priority: host annotations → inference from names + sampled values (inferred
  ONCE at sync into a reviewable generated file; never guessed per-generation) →
  plain. Consumers: Kit auto-formatting, §5 compile checks, and the model's context.
- **Domain manifest:** the positive list of data domains the host's tools cover
  (derived at sync, host-editable), surfaced as fact: "This host has accounts,
  transactions, budgets. It has NO payroll, invoices, crypto, FX." Unservable asks
  stop being judgment calls; the Disclaimer path is stated, not hoped for.
- **Generated context:** the full generation context — Kit schemas, host component
  schemas, tool list with shapes + semantics, domain manifest, theme — is
  program-generated from artifacts. Prompt content is a build product with a diffable
  source of truth.

## 5. Compile checks (the enforcement layer)

Prop classes from the Kit/host contracts: `config` (knobs; literals expected) ·
`copy` (human text; model writes freely) · `data` (anything rendered as business
data).

- **Law 1 in the tree:** a `data` prop must be a tool reference (or a value derived
  from one). Literal arrays/objects/numbers in data slots = compile error → repair.
  Value slots are typed raw by semantics (cents ⇒ number), so model-written display
  strings ("$5,490,715.00") fail type-check.
- **Law 1 in islands (honest limits):** island code's only possible data sources are
  props and `tools.*` (no network exists), so provenance is structural; a model could
  still hardcode a literal dataset in island source. Deliberately NOT mechanized yet:
  the prompt carries the rule, the frozen eval (§7) watches the class, and a check is
  built only if the re-gate shows it surviving. Same policy for label-vs-binding
  mismatches. Evidence first, mechanisms second.
- **Law 2:** tree actions are validated attributes; island tool manifests are
  compiler-inferred (literal-member-access rule) and registry-checked. Unknown tool,
  wrong input shape, mutation without payload, control not matching a real tool
  parameter — all compile errors routed to the existing repair loop.
- Streaming discipline (kept from v2 + OpenUI lesson): invalid statements drop
  without killing the frame; skeletons for not-yet-defined refs; last-good-state on
  regressions.

## 6. Dialect retirement

Deprecate `asOptions`, `template`, `currencyCents`, compiler dotted keys, and shrink
the reshape pipe to (at most) `pick`/`rename`/`asPoints` during migration — their jobs
move into Kit internals and island JS. No new reshape ops, ever: pressure for one is a
signal the Kit lacks a prop or the case belongs in an island. Staged removal: stop
teaching (prompt) immediately → keep compiling for stored apps → delete after Kit
migration. The `<Query>` element follows the same path if (and only if) the §1.2
measurement retires it.

## 7. Eval infrastructure (permanent fixture)

- The 30-prompt held-out corpus is **frozen** as the golden set (the 6 dev-set prompts
  kept, labeled dev). Never tuned against; each wave judged on it once; any prompt
  discussed in a fix PR moves to the dev pile.
- A rotating **fresh pool** (~10 never-seen prompts per gate; new categories over
  time: multi-part, edits, joins, adversarial phrasing, non-dashboard shapes).
- **Negative prompts** are first-class (asks the host cannot serve, scored on honest
  handling) — the measured honesty rate (2/5) is the baseline to beat.
- Metric: error-free rate, browser-judged with committed screenshots, per-class
  breakdown, timing. Production boots, real generations — the discipline that caught
  everything unit tests missed.

## 8. Engine fix (orthogonal, ships first)

Approved actions stall at "Running" (approve → resume never completes; found twice in
the held-out gate). Breaks every approval-gated mutation regardless of generation
quality. Fix in the actions/runtime path + an e2e that approves a gated action and
asserts the effect lands (current e2e stops at "approval requested").

## 9. Failure class → mechanism map

| Held-out failure class (freq) | Killed by |
|---|---|
| Raw cents / cents-as-dollars in derived slots (7) | §3 value components + §4 semantics + §5 raw-typed data slots; island compute uses `fmt` |
| Core-ask-not-computed: sort/limit/group/derive (5) | §3 smart props; §1.4 island JS for arbitrary derivation |
| Fabrication on missing domains (3) | §5 Law-1 checks + §4 domain manifest + Disclaimer |
| Invented/mislabeled controls (3) | §5 control-grounding vs tool input schemas |
| Dead filters/tabs (2) | §3 internal-filter components (no wiring exists to break) |
| Dotted-key vs template inconsistency | §6 retirement; dot-paths native to Kit |
| Silent-empty-despite-data | §3 named-query empty states |
| Raw ISO dates / raw enums | §4 semantics + §3 auto-formatting |
| $NaN error blobs | §3 chart invalid-states + §5 raw typing |
| Approve→resume stall (engine) | §8 |
| Facade interactions (dead Submit) | §1.4 island `tools` API — flows can complete |

Named residual risks: island internals are unproven code (fenced; lint for literal
data; eval measures it) · copy props are free text (captions can mislead; carry no
data) · semantics inference can mislabel (sync-time review file + host override).

## 10. Rollout (broad waves; detailed plans via writing-plans)

1. **Wave 0** — engine approve→resume fix (§8); freeze the golden set (§7).
2. **Wave 1** — format experiments in the bench harness: inline refs vs `<Query>`
   (§1.2), ambient-tools island reliability, ambient-scope stripping. Decisions by
   measurement before product code.
3. **Wave 2** — Kit core (DataTable, value tier, Select, Disclaimer; prop-class
   contract; generated kit prompt).
4. **Wave 3** — semantic sync + §5 compile checks (land together — checks need
   semantics).
5. **Wave 4** — charts tier + furnished jail (ambient Kit/tools in islands, manifest
   inference).
6. **Wave 5** — dialect retirement + full re-gate: frozen 30 + ~10 fresh; report the
   arc honestly.

## 11. Relationship to the market

Borrowed: spec-not-code main path (thesys conviction) · catalog-generated prompts
(json-render/OpenUI) · smart components with data props + format enums
(Crayon/Tambo/Retool/json-render) · golden sets with negative prompts (OpenAI Apps) ·
streaming drop-invalid/last-good (OpenUI). Rejected: bespoke line-DSLs and closed
compute vocabularies (`@Sum/@Filter`) — the teaching-tax argument; LLM-roundtrip
interactivity; codegen-never absolutism (v0's trained-AutoFix data shows raw codegen
needs a crutch — our answer is fencing it, not banning it). Different (the moat):
host-native rendering (apps look like the host, not like us) · real gated authority
(approval-gated host-API actions) · durable app artifacts with a server ladder ·
islands with the Kit + tools in scope — spec-only systems cannot express custom
interactive regions at all.
