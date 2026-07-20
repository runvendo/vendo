# Vendo format v3 + reliable generation — the 2-pager

Status: APPROVED DIRECTION (Yousef, 2026-07-19). Replaces the long draft. Context: dev-set
hit 6/6 but held-out gate measured 11/30 — mechanical classes were fixed, judgment classes
weren't, and our invented micro-op dialect was itself the overfitting. Full evidence:
`docs/verification/vendo-v2-heldout/` + PRs #385–#397.

## The design in five lines

The model builds an app from three things:
1. **The Kit** — our smart, branded components: they sort, filter, paginate, and format
   themselves; the model only fills props.
2. **Islands** — its own small React components for anything the Kit doesn't cover.
3. **The host's tools** — the only source of data, the only way to act.

Two laws: **(1)** screen data must trace to a tool call — hand-typed business data is a
compile error (no tool for the ask → the styled `Disclaimer` is the legal move).
**(2)** every app's tool surface is statically readable, and every call flows through the
one guard + approval pipe — fired from the tree or from island code, same gate.

## The format

```jsx
<App name="Overdue Invoices">
  <Stack>
    <Stat label="Total overdue" value={invoices.list({status:"overdue"}).totalCents} format="money"/>
    <DataTable rows={invoices.list({status:"overdue"}).data}      // same ref → one fetch
       sortBy="dueDate asc" limit={20} filterableBy={["client"]}
       columns={[{key:"client.name"},{key:"amountCents",format:"money"},{key:"dueDate",format:"date"}]}/>
    <Button label="Remind all" onClick="invoices.sendReminders"/>
    <ClientLookup/>
  </Stack>
  <Island name="ClientLookup">
    export default function ClientLookup() {
      const [hits, setHits] = useState([]);
      return <Stack>
        <Input label="Find a client" onChange={async q => setHits((await tools.clients.search({q})).data)}/>
        <DataTable rows={hits} columns={[{key:"name"},{key:"balanceCents",format:"money"}]}/>
      </Stack>;
    }
  </Island>
</App>
```

- **Data:** inline tool references in props — parsed data, never executed; compiler checks
  every name + input against the live registry. *(Pending Wave-1 measurement vs `<Query>`;
  keep whichever measures more reliable.)*
- **Actions:** `on*` props naming a host tool. Mutations need a payload; controls must match
  the tool's real input parameters.
- **Islands:** one file, one component, full React. Ambient scope — React, the whole Kit,
  charts, `fmt` are just in scope (no imports; known ones stripped, unknown → repair).
  Direct tool calls via ambient `tools.x.y(args)` — literal member access only, so the
  compiler extracts + validates each island's tool manifest and the runtime exposes only
  that. No network, no host-page DOM; byte caps.
- **Run anything:** Kit props (no code) → island (client React + tools) → `fn:` server
  functions (sandboxed machine) → rung-4 full app. Same two laws at every rung.

## How a generation runs (the reliability pipeline)

"Dropdown where mistakes live, blank page where creativity lives."

1. **Outline** (~0.5s, strict structured call): sections + which tools feed them + all
   SHARED facts (shared data, shared state). Tool names picked from the registry menu —
   unsamplable if invalid. Deeply coupled pieces (picker filtering two views) are marked
   one-unit → single island or single-stream; parallel is an optimization, not a rule.
2. **Instant paint** (~1.5s): tier-0 wired skeleton, as today.
3. **Parallel section writers** (~2–5s): one call per section, seeing only its section's
   tools/shapes; short JSX; sections click in as they land. Errors can't compound across
   sections; a bad section regenerates alone.
4. **Whole-app validation**: compiler validates the assembled tree — every reference,
   action, both laws.
5. **Structured repair** (~1s when needed): compile errors are fixed by ONE strict call
   over the closed fix space — enums of the real field paths / registry tools, with an
   explicit "no valid fix → Disclaimer" arm. The fix cannot itself be invalid. Replaces
   whole-app re-generation.
6. **End pass** (~1s, skippable): one no-think editor read-through of the assembled app —
   answers-the-ask, duplicate titles, tone drift — emitting 0–2 small validated patches
   through the normal compile gate. Polishes; structurally cannot break.

Target: paint ~1.5s, complete ~6s, no failure mode that ships silently.

## The Kit (Wave 2 surface)

**Bar: the best component stack in generative UI — a strict superset of thesys Crayon /
Tambo / json-render surfaces, then better on our axes:** host-brand-native (theme tokens,
not our brand), action-gated interactivity (their components can't mutate anything; ours
carry approval-gated real actions), semantics-driven formatting (cents/dates/enums arrive
correct, not prompted), named-query empty states, and composable inside islands. Wave-2
planning starts from a full inventory of their catalogs and ships ours strictly larger.

Layout (Stack/Row/Grid/Surface/Divider) · values (Text, Money, DateTime, Percent, Num,
EnumBadge) · data (DataTable — sort/limit/filter/search/paginate/dot-path columns/named-
query empty states — CardList, Stat, Badge) · charts (Line, Bar, Donut, Sparkline,
Progress — data props only, recharts internals, `$NaN` unrenderable) · forms (Input,
Select over raw arrays via labelField/valueField, DatePicker, Form, Button, **Disclaimer**)
· self-managing Tabs. Built ours (host theme tokens) on TanStack Table + recharts
internals. Every prop classed `config | copy | data` (law 1 enforcement); the generation
prompt is GENERATED from the schemas — hand-written prompt lists are dead.

## Context (Wave 3)

At `vendo sync`: field semantics (cents/date/enum-labels/id — host-declared or inferred
once into a reviewable file) · domain manifest ("has: accounts, budgets. has NO: payroll,
crypto") · better tool descriptions ("use this when…") · all generation context
program-generated from these artifacts.

## Reliability mechanisms — adopt / measure / defer

| | What | Why |
|---|---|---|
| **Adopt** | Structured repair; region-parallel writers + outline; end pass | Cheap, on today's API, kills the two measured amplifiers (repair cost, compounding) |
| **Measure (Wave 1, bench)** | Inline refs vs `<Query>` · builder-calls fork (app as strict per-component tool calls; go/no-go = judged quality) · fetch-then-generate vs shape-cards A/B · 1-day llguidance CFG-JSX replay on open weights | Decisions by data; the CFG replay is the evidence line for owned serving |
| **Defer** | Molds (template retrieval + slot-fill) until production traffic · CFG-JSX adoption until owned serving · label verifiers / island-literal bans unless the frozen eval proves the class survives | Evidence first, mechanisms second |

Endgame (owned inference): grammar-constrained JSX — invalid components/fields become
unsamplable at the keyboard. Nobody ships this; it is the moat's second job after latency.

## Also

- **Wave 0 (first):** fix the approve→resume engine stall (approved actions hang at
  "Running" — breaks every gated mutation) + an e2e that asserts the effect lands. Freeze
  the 30-prompt held-out corpus as the golden set (never tuned against) + fresh-pool +
  negative prompts; metric = browser-judged error-free rate.
- **Dialect retirement (Wave 5):** deprecate `asOptions`/`template`/`currencyCents`/dotted
  keys (Kit makes them unnecessary); no new reshape ops ever; re-gate on frozen 30 + 10
  fresh and report the arc honestly.
- **Not doing:** query algebra · LLM-roundtrip interactivity · split-surfaces · preemptive
  verifier passes.

## Waves

0 engine fix + eval freeze → 1 bench measurements → 2 Kit → 3 semantics + law checks →
4 islands (ambient scope/tools) + pipeline (outline/parallel/repair/end pass) → 5
retirement + re-gate.
