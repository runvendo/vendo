# W3 — semantics + the two laws + inline refs: verification

Branch `yousefh409/vendo-w3-semantics`. Authority: TASK.md here + the v3 spec
(§Context, §The two laws, §format Data) + W1 VERDICTS (Exp1: ADOPT inline).

## What shipped

**Part 1 — semantics at `vendo sync`**
- `packages/core/src/semantics.ts`: the field-semantics model —
  `money(cents|dollars)`, `date(iso|epoch)`, `enum(value→label)`, `id(entity)`,
  `percent(ratio|0-100)`, plain — one-time inference from field names + sampled
  values, collapsed dot paths, semantics-annotated shape cards
  (`describeShapeWithSemantics`), the `vendo/semantics@1` file schema.
- `vendo sync` writes REVIEWABLE `.vendo/semantics.json`: host annotation
  (`overrides.json tools[name].semantics`) > what the file already says (host
  edits + prior inference are never overwritten) > fresh inference (dev-server
  `POST /sync/semantics`, classifications only — values never leave the server)
  > plain (omitted). Domain manifest (has / has-NOT) derived from tool names on
  first sync, host-owned afterwards.
- Empty tool descriptions get deterministic "Use this to …" lines at sync
  (reviewable in tools.json, overridable forever).
- Generation context is program-generated: the COMPONENTS prompt section is
  `kitPrompt()` over the Kit specs (hoisted to core) + the legacy primitive
  signatures; shape cards carry semantic annotations; the domain manifest is
  stated as fact.

**Part 2 — the two laws at compile** (all TDD'd in
`packages/apps/src/engine-laws.test.ts`)
- Law 1: `data`-classed props (Kit prop classes + legacy data props + host
  catalog schemas) must be bindings — a hand-typed literal is a compile error
  with a strict structured-repair fix (bind a real path, or the Disclaimer
  arm). Kit value slots are raw-typed: a string-shaped field bound into
  `Money.cents` fails the kind probe.
- Law 2: actions must name a REAL tool (unknown → strict fix over the
  registry enum); payload fields must be the tool's REAL input parameters
  (ungrounded → payload rebuilt whole from the schema); Kit `Form` is a
  submit affordance (read-only/missing onSubmit = fake affordance); query
  inputs are LITERAL JSON (a dependent call can never execute).

**Part 3 — inline tool refs (W1 Exp1 ADOPT)**
- `inlineRefs` + `inlineTools` on every engine compile of model wire;
  single-segment production tool heads (`host_listTransactions({...})`)
  expand when the registry knows them; `<Query>` stays accepted; the WIRE
  DIALECT prompt teaches inline references first.

## Demo-host artifacts

- `apps/demo-bank/.vendo/semantics.json` (Maple): 10 tools inferred —
  `data.amount: money.cents`, `data.timestamp/dueDate: date.iso`,
  `category/status: enum(labels)`, `accountId/cardId: id(entity)` — plus a
  curated manifest (`has`: accounts…transfers; `hasNot`: payroll, crypto,
  loans, mortgages, investments, credit score, taxes, insurance, invoices).
- `apps/demo-accounting/.vendo/semantics.json` (Cadence): entity-type enums
  (`s_corp → "S corp"`), ISO filing deadlines, ids; `hasNot`: invoices/billing,
  payroll, bank transactions, expenses, tax calculations, time tracking,
  e-signatures.

## Live verification (Maple, production boot, 6 FRESH prompts — not the frozen 30)

| # | Prompt | Result | Evidence |
|---|---|---|---|
| P1 | Which subscriptions am I paying for, monthly cost? | PASS — Kit DataTable, money/date column formats from cents/ISO, sort+search+filters, inline-ref minted query | w3-p1-subscriptions.png |
| P2 | Checking balance + 10 recent transactions | PARTIAL (honest) — balance card correct; account-scoped tool needs an id the model can't literally have, so the table renders the named empty state. The dependent-data class is the spec's DEFERRED fetch-then-generate (W1 Exp3); the new laws turned it from a crash/broken call into honest degradation | w3-p2-checking-honest-empty.png |
| P3 | Spending breakdown by category + donut | PASS — host donut bound RAW (reshape guard), correct total $4,799.69 from cents, formatted table | w3-p3-spending-donut.png |
| P4 | Quick-pay panel (pick payee, send money) | PASS — Kit Selects over RAW arrays (labelField/valueField), Form onSubmit → host_transferMoney with payload keys = the tool's exact required params | w3-p4-quickpay.png |
| P5 | Show my crypto portfolio (negative — hasNot domain) | PASS — Kit `<Disclaimer>`: "No tool on this host provides crypto holdings…" | w3-p5-crypto-disclaimer.png |
| P6 | Savings goals progress | PASS — CardList + DataTable, money formatted from cents | w3-p6-goals.png |

Law-1 literal rejection is pinned by unit test (engine-laws.test.ts: literal
rows/cents/host-catalog data props → compile error → repair/strict splice).

## Live-verify findings fixed during the lane

1. Dependent inline-call args (`accountId: accounts.data.0.id`) execute as
   literal JSON and ship broken → new compile law + prompt line.
2. Kit data components crashed on undefined rows (failed query) → all Kit
   data/options/series surfaces fail SOFT to their empty states.
3. `asPoints` into a host prop that declares its own item fields drew `$NaN`
   → compile guard: bind the RAW rows.
4. Maple's donut declared dollars while every Maple tool speaks cents →
   host component fixed to integer cents (the semantics wave exposed it).
5. `VENDO_BASE_URL` unset on a production boot silently kills tool sampling
   AND app queries (server already warns; recipe note).

## Known limitations (named, deferred by spec)

- Account-scoped asks needing a literal id (P2): fetch-then-generate is the
  DEFER'd mechanism (W1 Exp3); the laws force honest degradation meanwhile.
- Form field values do not yet feed the submit payload dynamically (payload
  binds row/context paths); interactivity wiring is future work.
