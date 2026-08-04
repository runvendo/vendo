/**
 * `references/format.md` — the `building-apps` skill's companion file: the complete
 * `.vendo` authoring reference, so the skill body can stay one screen per section.
 * A FILE on the `/host` mount, read with the harness's own hands, never listed.
 *
 * Every element, attribute and function below is taken from the parsers and the
 * validator, not from another prompt: `core/genui/plan/compile.ts` (plan.vendo),
 * `core/genui/wire/{compile,attributes,expression}.ts` (app.vendo),
 * `core/genui/expr.ts`, `core/reshape.ts` (the pipe ops),
 * `core/genui/wire/text-edit.ts` (edits) and
 * `apps/generation/validation/validate.ts`. Anything a prompt claims and no parser
 * implements is deliberately absent — a documented attribute that does nothing is
 * worse than a missing one. The component half is INTERPOLATED from the same
 * generated schemas the engine's workers read, so it cannot drift from the code.
 */
import { componentsPromptSection } from "../generation/contracts/sections.js";

const DIALECT = `# The .vendo format

An app is two files in its own directory, \`user/apps/app_<name>/\`:

- \`plan.vendo\` — the data to read and the groups of parts that show it. Saving it
  paints the skeleton on the person's screen.
- \`app.vendo\` — the app itself. Saving it repaints the app.

Both compilers are TOTAL: nothing you write can make them fail outright. A part
they cannot read is dropped, reported, and everything around it still renders —
which is why a half-written file already paints.

---

## plan.vendo

One \`<Plan>\` document. Prose or code fences around it are ignored; the plan is
read from the first \`<Plan\` to the last \`</Plan>\`.

\`\`\`
<Plan name="Invoices workspace">
  <Query id="invoices" tool="maple_invoices_list" input={{ limit: 100 }}/>
  <Group tab="Overview" title="Health" layout="grid">
    <Leaf component="Stat" query="invoices" purpose="Total outstanding across every open invoice" col="1"/>
    <Leaf component="BarChart" query="invoices" purpose="Invoiced amount per month over the last year" col="2"/>
  </Group>
  <Group tab="Overdue">
    <Leaf component="DataTable" query="invoices" purpose="Overdue invoices, worst first"/>
  </Group>
  <Cannot>This product has no way to send email, so reminders land in the app's own log instead.</Cannot>
</Plan>
\`\`\`

A plan holds \`<Query>\`, \`<Group>\` (of \`<Leaf>\`), \`<Server>\`, \`<Island>\` and
\`<Cannot>\`, and nothing else. It needs at least one group or one \`<Cannot>\`.

### \`<Plan name="…">\`

\`name\` becomes the app's title. No other attribute on \`<Plan>\` is read.

### \`<Query id tool input/>\` — self-closing

| attribute | | |
|---|---|---|
| \`id\` | required | letters, digits and \`_\`, starting with a letter or \`_\`. Never \`state\`. Unique. This is the name leaves and expressions use. |
| \`tool\` | required | a host tool name. One that does not exist is kept and reported. |
| \`input\` | optional | an object: \`input={{ limit: 100 }}\`. LITERAL values only — an input may not read another query. |

### \`<Group tab title layout waitsForServer>\`

| attribute | | |
|---|---|---|
| \`tab\` | optional | which tab this section belongs to. |
| \`title\` | optional | the section's heading. |
| \`layout\` | optional | \`"stack"\` (default) or \`"grid"\`. Nothing else is accepted. |
| \`waitsForServer\` | optional | a BARE flag — write \`<Group waitsForServer>\`. \`waitsForServer="true"\` is ignored. |

Tabs ARE the \`tab\` labels, in order of first appearance. There is no \`<Tab>\`
element and you never write one. A group with no \`tab\` sits above the tab bar.

A group holds \`<Leaf>\` elements only — **at most five**; extras are dropped. A
group inside a group does not exist.

### \`<Leaf component query purpose …/>\` — self-closing

| attribute | | |
|---|---|---|
| \`component\` | required | the component that shows this part. One that does not exist is kept and reported. |
| \`purpose\` | required | one sentence, written so a stranger could build the part from it and nothing else. |
| \`query\` | optional | the \`id\` of a \`<Query>\` anywhere in the document — declaring it later is fine. |

Any other attribute is kept verbatim as an arrangement HINT for whoever fills the
leaf in (\`col="1"\`, \`row="2"\`, \`span="2"\` by convention). Nothing enforces a hint
and nothing renders one: real arrangement is \`<Group layout="grid">\` and the
\`Grid\` component in app.vendo. Never copy a hint onto a component in app.vendo —
an unknown prop fails validation.

A misspelled \`purpose\` becomes a hint, and the leaf is then dropped for having no
purpose. Read the findings.

### \`<Server kind why served schedule/>\` — self-closing, at most one

| attribute | | |
|---|---|---|
| \`kind\` | required | \`"steps"\`, \`"agentic"\` or \`"box"\`. Anything else drops the whole element. |
| \`why\` | required | one sentence: why this app needs a server side at all. |
| \`served\` | optional | a BARE flag, legal only with \`kind="box"\`. |
| \`schedule\` | optional | a cadence in words, or a five-field cron read in UTC. |

### \`<Island name purpose/>\` — self-closing, at most one

Declares that this app needs a component you will write, by name and purpose. It
carries no code; the code goes in app.vendo's own \`<Island>\`.

### \`<Cannot>…</Cannot>\`

Plain text, verbatim to the first \`</Cannot>\`, and it may not be empty. One
honest sentence about what this product cannot do. \`<Cannot>\` belongs to the plan
only — in app.vendo it reads as an unknown component and fails validation.

\`validate\` does not read plan.vendo. The plan's proof is the skeleton appearing.

---

## app.vendo

One \`<App>\` document and nothing else; anything after \`</App>\` is dropped.

\`\`\`
<App name="Invoices">
  <Query id="invoices" tool="maple_invoices_list" input={{ limit: 100 }}/>

  <Text variant="heading">Invoices</Text>
  <Grid columns={2}>
    <Stat label="Outstanding" value={sum(invoices.data.amount_cents)} format="money"/>
    <Stat label="Open invoices" value={count(invoices.data)}/>
  </Grid>
  <DataTable rows={invoices.data} columns={[{key:"client",label:"Client"},{key:"amount_cents",format:"money",align:"end"}]} emptyState="Nothing outstanding"/>
</App>
\`\`\`

- \`<App name="…">\` — \`name\` is required and at most 40 characters. No other
  attribute on \`<App>\` is read.
- \`<Query id tool input/>\` — the same attributes as the plan's, declared at the
  top. It shows nothing; it is where data comes from. At most 16 per app.
- Every other element is a component. Names are PascalCase; a lowercase tag
  (\`<div>\`, \`<span>\`) drops the element **and everything inside it**.
- Text typed between tags becomes text on screen.
- \`<!-- comments -->\` are skipped.
- Never write \`id=\` — ids are minted for you, and an \`id\` attribute is ignored.
- At most 5000 elements.

### Attributes — three forms, exactly

\`\`\`
title="Outstanding invoices"     a string — DOUBLE quotes only
rows={invoices.data}             a value read from the data
searchable                       a bare flag, meaning true
\`\`\`

- Single quotes around a markup string (\`title='x'\`) drop the attribute. Single
  quotes are fine INSIDE braces.
- Inside a string the only escapes are a backslash before a double quote and a
  backslash before a backslash. Every other backslash is literal text.
- A repeated attribute keeps the last one.
- There is **no string interpolation**. \`label="Total: {invoices.total}"\` renders
  the braces literally and fails validation — give the value its own attribute.

### Actions

An \`on*\` attribute names a host tool: \`onClick="maple_invoice_send"\`. That is the
only way anything in an app mutates. A value that is not a legal tool name drops
the attribute.

### \`<Island name="PascalName">\` — a component you write

The content is raw TSX, verbatim to the **first** \`</Island>\`, with an
\`export default\` component. There are no imports and none can be added: React
and its hooks, the whole Kit, and \`fmt\` (\`fmt.money(cents)\`,
\`fmt.dateTime(iso)\`, \`fmt.percent(ratio)\`, \`fmt.num(n)\`) are already in scope,
and nothing else can load. The name must be PascalCase and must not collide with
a host, Kit or prewired component name. Reference it as \`<PascalName/>\`. At most
16 islands, 64 KB each.

Write an island for a custom visual or client-side logic. Never for a chart — the
Kit's charts already render their own empty state.

---

## Braces: two grammars

\`{…}\` is either a READ of the data or a CALCULATION over it, and the compiler
tells them apart by what is inside. Both are evaluated in the browser, fresh, on
every render — which is why you never compute a value and type it in.

### Reading: paths, state, literals

\`\`\`
rows={invoices.data}                    a query's id, then field names
label={invoices.data.0.client}          a numeric segment reads one row
value={state.selectedTab}               a value the app holds while in use
columns={[{key:"client",label:"Client"}]}
limit={20}   flag={true}   empty={null}   text={"literal"}
\`\`\`

- The head of a path must be a declared \`<Query>\` id, or \`state\`. Anything else
  drops the attribute.
- \`state\` takes exactly one key: \`state.a.b\` is illegal.
- Literals: numbers, strings (single or double quotes), \`true\`, \`false\`, \`null\`,
  arrays and objects, with trailing commas allowed. \`true\`, \`false\` and \`null\`
  win over a query of the same name.

### Reshaping what you read: \`{path | op(…)}\`

A pipe is legal **only** directly after a path or \`state\` read, up to eight steps.

| op | arguments | what it does |
|---|---|---|
| \`pick\` | one or more field names | keep only those fields (per row, over rows) |
| \`rename\` | old/new pairs | rename fields |
| \`asPoints\` | label field, value field | rows to \`{label, value}\` points |
| \`format\` | \`"number"\` / \`"currency"\` / \`"percent"\` / \`"date"\` | format the value |
| \`format\` | field, kind | format that field in every row |
| \`sum\` \`avg\` \`min\` \`max\` | one numeric field | one number out of the rows |
| \`count\` | none | how many rows |

\`\`\`
points={invoices.data | asPoints("month", "total_cents")}
total={invoices.data | sum("amount_cents")}
rows={invoices.data | pick("client", "amount_cents") | format("amount_cents", "currency")}
\`\`\`

The pipe's aggregate is \`avg\`. The calculation grammar below calls it \`average\`.
They are not interchangeable, and the wrong one drops the attribute.

### Calculating: functions and arithmetic

| function | arguments | what it does |
|---|---|---|
| \`sum(path)\` | 1 | adds up a numeric field over the rows |
| \`count(path)\` | 1 | how many rows |
| \`average(path)\` | 1 | the mean |
| \`min(path)\` \`max(path)\` | 1 | smallest / largest |
| \`difference(a, b)\` | 2 | a minus b |
| \`days_until(path)\` | 1 | whole days from today to an ISO date |
| \`group_by(path, bucket, aggregate)\` | 3 | buckets rows by a date field |

\`group_by\` is strict: the first argument is a path, the second is the quoted
string \`"day"\`, \`"month"\` or \`"year"\`, and the third is \`sum\`, \`average\`, \`min\`,
\`max\` or \`count\` over a field of the **same** rows.

\`\`\`
value={sum(payments.data.amount_cents) - sum(refunds.data.amount_cents)}
value={difference(budget.data.planned_cents, budget.data.spent_cents)}
value={days_until(invoice.data.due_at)}
data={group_by(invoices.data.issued_at, "month", sum(invoices.data.total_cents))}
\`\`\`

Operators are \`+ - * /\`, a leading \`-\`, and \`( )\`. Values are numbers and quoted
strings. Nothing else exists: no \`%\`, no comparisons, no \`&&\`, no \`? :\`, no
\`[…]\` indexing.

A query that has not answered yet reads as nothing, and rows carrying explicit
nulls are skipped by the aggregates — so you never write a guard for either.
Dividing by zero, and arithmetic on something that is not a number, are reported
rather than rendered as nonsense.

### Never mix them

\`{sum(invoices.data.total_cents) | format("currency")}\` is rejected outright. Let
the component format the number: \`Stat\` takes \`format="money"\`, \`Money\` takes
\`cents\`, a \`DataTable\` column takes \`format:"money"\`.

---

## Changing an app that already exists

Edit the text; never rewrite the file. Small edits keep everything the person is
already looking at exactly where it is.

Editing the file by hand, use your own file-edit tool. Editing an app through
this product's app tools, the change is written as edit blocks — same discipline,
one dialect:

\`\`\`
<Edit>
  <Old><Stat label="Total" value={sum(invoices.data.amount_cents)}/></Old>
  <New><Stat label="Total outstanding" value={sum(invoices.data.amount_cents)} format="money"/></New>
</Edit>
\`\`\`

- The elements are exactly \`<Edit>\`, \`<Old>\` and \`<New>\`, with **no attributes** —
  \`<Edit reason="…">\` is not read as an edit at all.
- \`<Old>\` is the text as printed, verbatim: blank space around the outside is
  trimmed and nothing else is forgiven. There is no fuzzy matching.
- It must match **exactly once**. Zero matches and two matches are both refused;
  include a surrounding line to make it unique. The refusal quotes the closest
  line the app actually has — read it, do not retry the same quote.
- An empty \`<New></New>\` deletes. An \`<Old>\` that is empty after trimming is
  refused.
- One \`<Edit>\` per replacement. They apply in order, each seeing the result of
  the ones before it, and the **first failure abandons the whole batch** — so a
  bad quote never leaves the app half-rewritten.

---

## What \`validate\` checks

Call \`validate\` with the \`document\` you just saved (its text). It reports
findings; it never throws, and it never guesses. In order, roughly: the document
parses to a complete \`<App>\`; every compile issue; the app has a name of at most
40 characters; islands are sound and actually render; every query names a tool
the host has; every binding fits the prop it is bound to; query inputs are
literal; no string interpolation; every component name exists; **every prop name
exists** on the component it is written on.

Findings name the real alternative — the fields that do exist, the props that do
exist. Fix from the finding and validate again.

---

## One worked app, end to end

The ask: "show me where my spend is going, and which invoices are late."

\`user/apps/app_spend/plan.vendo\` — saved first, so the skeleton appears:

\`\`\`
<Plan name="Spend and late invoices">
  <Query id="expenses" tool="maple_expenses_list" input={{ limit: 500 }}/>
  <Query id="invoices" tool="maple_invoices_list" input={{ status: "overdue" }}/>
  <Group tab="Spend" title="Where it goes" layout="grid">
    <Leaf component="Stat" query="expenses" purpose="Total spend across every expense in the window" col="1"/>
    <Leaf component="BarChart" query="expenses" purpose="Spend per month, so a rising trend is visible" col="2"/>
    <Leaf component="DataTable" query="expenses" purpose="Every expense, biggest first, with vendor and date"/>
  </Group>
  <Group tab="Late">
    <Leaf component="Stat" query="invoices" purpose="How many invoices are overdue right now"/>
    <Leaf component="DataTable" query="invoices" purpose="Overdue invoices, longest overdue first"/>
  </Group>
  <Cannot>This product cannot send email, so chasing a late invoice still happens outside it.</Cannot>
</Plan>
\`\`\`

\`user/apps/app_spend/app.vendo\` — saved once per group, so it grows on screen:

\`\`\`
<App name="Spend and late invoices">
  <Query id="expenses" tool="maple_expenses_list" input={{ limit: 500 }}/>
  <Query id="invoices" tool="maple_invoices_list" input={{ status: "overdue" }}/>

  <Tabs tabs={["Spend", "Late"]} value="Spend">
    <Stack>
      <Text variant="heading">Where it goes</Text>
      <Grid columns={2}>
        <Stat label="Total spend" value={sum(expenses.data.amount_cents)} format="money"/>
        <BarChart data={group_by(expenses.data.spent_at, "month", sum(expenses.data.amount_cents))} xKey="key" series={["value"]} format="money" emptyState="No spend in this window"/>
      </Grid>
      <DataTable rows={expenses.data} sortBy="amount_cents desc" searchable columns={[{key:"vendor",label:"Vendor"},{key:"spent_at",format:"date"},{key:"amount_cents",format:"money",align:"end"}]} emptyState="No expenses yet"/>
    </Stack>
    <Stack>
      <Text variant="heading">Late</Text>
      <Stat label="Overdue invoices" value={count(invoices.data)}/>
      <DataTable rows={invoices.data} sortBy="due_at asc" columns={[{key:"client",label:"Client"},{key:"due_at",label:"Due",format:"date"},{key:"amount_cents",format:"money",align:"end"}]} emptyState="Nothing overdue"/>
      <Disclaimer reason="This product cannot send email, so chasing a late invoice still happens outside it."/>
    </Stack>
  </Tabs>
</App>
\`\`\`

Every number on that screen is a reference or a calculation. Nothing is typed in,
nothing is pre-formatted, and nothing names a font or a colour — the components
carry this product's own look.

---

## Components

Host components come first when one fits: they are this product's own, already
branded. One file each, with the full props schema and examples:
\`host/components/<Name>.md\`, relative to the directory you are working in.
\`search_components\` finds one by intent when you do not know the name.

Everything below ships with the format and is available in every app. Use these
exact component and prop names — an unknown prop fails validation.

One difference to read past: the examples below sometimes write a tool call
inline (\`invoices.list({}).data\`). In a \`.vendo\` file, always declare the data
with \`<Query>\` and reference it by id instead. Every prop name and type is exact.

`;

/** The reference as it lands on disk. */
export const VENDO_FORMAT_REFERENCE = `${DIALECT}${componentsPromptSection()}\n`;
