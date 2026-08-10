/**
 * `references/format.md` — the `building-apps` skill's companion file: the complete
 * `.vendo` authoring reference, so the skill body can stay one screen per section.
 * A FILE on the `/host` mount, read with the harness's own hands, never listed.
 *
 * Every element, attribute and function below is taken from the parsers and the
 * validator, not from another prompt: `core/genui/plan/compile.ts` (plan.vendo),
 * `core/genui/wire/{compile,attributes,expression}.ts` (app.vendo),
 * `core/genui/expr.ts`, `core/reshape.ts` (the pipe ops) and
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

A plan holds \`<Query>\`, \`<Group>\` (of \`<Leaf>\`), \`<Server>\` and
\`<Cannot>\`, and nothing else. It needs at least one group or one \`<Cannot>\`.

### \`<Plan name display>\`

| attribute | | |
|---|---|---|
| \`name\` | required | becomes the app's title. |
| \`display\` | optional | \`"inline"\` (default) or \`"stage"\`. \`"stage"\` opens the app full-width and assembles it there; it is for what the person asked you to BUILD when it takes several groups. Anything else is reported and the app arrives inline. |

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
    <Stat label="Outstanding" value={sum(invoices.data, "amount_cents")} format="money"/>
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
- \`{/* comments */}\` are skipped.
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
- There is **no string interpolation**, in a string or between tags.
  \`label="Total: {invoices.total}"\` renders the braces literally and fails
  validation, and \`<Text>Total: {invoices.total}</Text>\` is refused outright.
  Give the value its own attribute: \`<Text text={invoices.total}/>\`.

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

## Braces: one grammar

\`{…}\` is a READ of the data, a RESHAPE of what it read, or a CALCULATION over it
— one grammar, one set of functions, all of it plain function calls. Everything is
evaluated in the browser, fresh, on every render, which is why you never compute a
value and type it in.

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

### Reshaping what you read: the value comes first

A reshape is a call whose FIRST argument is the value and whose remaining
arguments are quoted field names. Calls nest, up to eight deep, and the value at
the centre is always a query or \`state\` read.

| call | arguments after the value | what it does |
|---|---|---|
| \`pick\` | one or more field names | keep only those fields (per row, over rows) |
| \`rename\` | old/new pairs | rename fields |
| \`asPoints\` | label field, value field | rows to \`{label, value}\` points |
| \`format\` | \`"number"\` / \`"currency"\` / \`"percent"\` / \`"date"\` | format the value |
| \`format\` | field, kind | format that field in every row |

\`\`\`
points={asPoints(invoices.data, "month", "total_cents")}
rows={format(pick(invoices.data, "client", "amount_cents"), "amount_cents", "currency")}
note={format(state.rate, "percent")}
\`\`\`

Reading the nesting from the inside out reads the steps in order: \`pick\` first,
then \`format\`.

### Calculating: functions and arithmetic

| function | arguments | what it does |
|---|---|---|
| \`sum(rows, "field")\` | 2 | adds up one numeric field over the rows |
| \`count(rows)\` | 1 | how many rows |
| \`average(rows, "field")\` | 2 | the mean |
| \`min(rows, "field")\` \`max(rows, "field")\` | 2 | smallest / largest |
| \`difference(a, b)\` | 2 | a minus b |
| \`days_until(path)\` | 1 | whole days from today to an ISO date |
| \`group_by(rows, "dateField", bucket, aggregate)\` | 4 | buckets rows by a date field |

Every aggregate NAMES the field it reads — there is no implicit field, and the
rows come first. \`group_by\` is strict: the rows, then the quoted date field, then
the quoted bucket \`"day"\`, \`"month"\` or \`"year"\`, then the aggregate written as
\`sum.of("field")\`, \`average.of("field")\`, \`min.of("field")\`, \`max.of("field")\`
or \`count.of()\`.

\`\`\`
value={sum(payments.data, "amount_cents") - sum(refunds.data, "amount_cents")}
value={difference(budget.data.planned_cents, budget.data.spent_cents)}
value={days_until(invoice.data.due_at)}
data={group_by(invoices.data, "issued_at", "month", sum.of("total_cents"))}
\`\`\`

Operators are \`+ - * /\`, a leading \`-\`, and \`( )\`. Values are numbers and quoted
strings. Nothing else exists: no \`%\`, no comparisons, no \`&&\`, no \`? :\`, no
\`[…]\` indexing.

A query that has not answered yet reads as nothing, and rows carrying explicit
nulls are skipped by the aggregates — so you never write a guard for either.
Dividing by zero, and arithmetic on something that is not a number, are reported
rather than rendered as nonsense.

### A reshape reshapes a READ, never a calculation

There is exactly one \`sum\`, one \`count\`, one \`average\`, one \`min\` and one
\`max\`, and each takes rows. A reshape works on what a query read, so the value at
the centre of the nesting is a path — \`format(sum(invoices.data, "amount_cents"),
"currency")\` is refused, because \`sum(...)\` already produced a number and there
is nothing left to reshape. Let the component format it: \`Stat\` takes
\`format="money"\`, \`Money\` takes \`cents\`, a \`DataTable\` column takes
\`format:"money"\`.

---

## Changing an app that already exists

Edit the text; never rewrite the file. Small edits keep everything the person is
already looking at exactly where it is.

Use your own file-edit tool, quoting the exact text that goes and the text that
replaces it. Quote enough of it to match in exactly one place — a quote that
matches twice, or not at all, is a failed edit, not a guess to retry.

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
        <Stat label="Total spend" value={sum(expenses.data, "amount_cents")} format="money"/>
        <BarChart data={group_by(expenses.data, "spent_at", "month", sum.of("amount_cents"))} xKey="key" series={["value"]} format="money" emptyState="No spend in this window"/>
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
