/**
 * `references/format.md` — the `building-apps` skill's companion file: how to
 * write the screen. A FILE on the `/host` mount, read with the harness's own
 * hands, never listed.
 *
 * A screen is a plain React component now, so this file teaches only the DELTAS
 * from React a model already knows: the two imports, catalog-only components, a
 * write as one element, tool calls in handlers, no clock and no network, keys,
 * controlled inputs. Everything that used to live here — a markup dialect, its
 * attribute forms, its brace grammar, its island envelope — is gone with the
 * dialect, and teaching it would send a model writing a file nothing compiles.
 *
 * The component half is INTERPOLATED from the same generated schemas the engine's
 * workers read (`componentsPromptSection`), so it cannot drift from the code — and
 * it now teaches the same idiom this chapter does, so nothing here has to correct
 * it (`contract/kit/kit-prompt.ts`).
 *
 * The WORKED SCREENS are the other half of the teaching, and each one is there for
 * a shape a model does not reach for from prose: a total reduced off the rows and
 * repeated where it is acted on, a fixed column count for a compare-these ask, a
 * detail pane opened on the first row with the row action on every row. One stacked
 * card list was the only example for a while, and a stacked card list is what came
 * back. They are pinned in `tests/skills/format-reference.test.ts`, which runs each
 * of them through the real save-time gauntlet.
 */
import { DISPLAY_TAG_NAMES } from "../../contract/kit/index.js";
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import { VENDO_THEME_VARIABLE_NAMES } from "../../contract/theme.js";
import { HOT_PATH_FILES } from "../generation/render-seam.js";
import { componentsPromptSection } from "../generation/contracts/sections.js";

/** The file a harness with hands saves — the screen artifact's own name, held here
 *  to the list of files the seam WATCHES, because this is the one place both are in
 *  scope. A manual that names a basename the seam does not watch teaches a save
 *  that paints nothing, on the one leg that writes files itself (`claudeCode()`). */
const APP_FILE: (typeof HOT_PATH_FILES)[number] = SCREEN_FILE;

const CHAPTER = `# The screen file

- An app is ONE file: \`${APP_FILE}\`, in the app's own directory
  \`user/apps/app_<name>/\`.
- It holds a React component, default-exported.
- Saving it repaints the person's screen.

\`\`\`tsx
import { useState } from "react";
import { useQuery, tools, Stack, Text, Button } from "@vendo/screen";

export default function Overview() { … }
\`\`\`

Those two imports are everything there is. Nothing else can be loaded.

## Data — \`useQuery(tool_name, input)\`

- Synchronous, and it hands back the tool's result with the tool's own field
  names on it — read them off the tool's schema and COPY them. The shape is
  closed: a field you inferred from a sibling's name (\`amount_cents\` where the
  schema says \`amount\`) is a hard refusal, not an undefined value.
- A read whose input you COMPUTE has no answer on the first paint: its \`data\` is
  undefined until the host supplies it, and then every \`useQuery\` re-runs with
  the real thing. So write the screen so an unanswered read draws its empty shell
  — \`rows.data ?? []\`, an empty state, a panel with nothing in it yet.
- The input is any value you have: a piece of state, something you computed, a
  field off another query.
- Read the same tool twice with different inputs where the screen needs two
  answers.
- An id is not a name: a field ending in \`_id\` points into another tool's rows
  (\`release.owner_id\` → \`list_members\`), so read that tool and show the NAME. A
  screen about ONE record shows that record's own fields — who owns it included —
  not only the fields the ask spelled out.

## Actions — \`tools.<tool_name>(args)\`

- Inside an event handler only, never during render. \`await\` it when you need
  the result — but only a READ answers straight away.
- A WRITE is answered by the PERSON, not by the host: it comes back
  \`pending-approval\`, and the code after your \`await\` does not run until they
  answer — where nobody answers, it never runs at all. So a handler may FIRE
  writes and finish; it must never wait on one to do the next thing.
  \`for (const row of rows) await tools.remove({ id: row.id })\` sends the first
  call and stops there, and \`await tools.pay({}); setOpen(false)\` leaves the
  dialog standing. Fire every call in the one press, with no \`await\` between.
- When an awaited call succeeds, every \`useQuery\` on the screen re-runs and the
  screen re-renders with fresh data, keeping the state it had — never patch state
  to mirror what the refresh will bring back.
- Destructive and money-moving calls are confirmed by the product OUTSIDE your
  screen — the guard asks the person before the call runs — so never build a
  confirm step of your own: no "are you sure" panel, no second button, no
  \`confirming\` state.
- The exception: a confirmation the person ASKED for, or one press that fires a
  whole batch of calls. That one is part of their app, and the second worked
  screen below is its shape.
  - A guarded host still asks once per call on top of it, and that is the trade:
    only your Modal can say how many, and being asked twice beats a batch that
    goes out silently.
- Another exception: a confirmation THIS product's own rules require. When the
  host design rules in the brief name an action as confirm-first, that step is
  part of the app — build it. The guard's own ask counts where it fires; where
  it does not, yours is the one the rules asked for.
- THE ACTION THE ASK NAMED IS ALWAYS PRESSABLE. Never paint it \`disabled\`
  because the screen thinks the moment is wrong: someone who asked to cut a
  release, kick a review back or cancel a queue and finds the control greyed out
  has a screen that cannot do the job they asked for. Let the press land, and put
  the risk where they will read it — in the confirmation ("3 issues are still
  open; cutting now freezes them"), or in a Callout beside the control.
- A CONTROL YOU DO DISABLE SAYS WHAT IT IS WAITING FOR, on the screen, naming
  every missing piece — "Name it, and pick at least one condition" — and
  \`required\` on the fields that are. A form still filling in is the ONLY thing
  \`disabled\` is for. The ask's verb is never disabled — not on the screen, not
  on one row of a table, not on the row already open or already holding that
  status: a press that merely repeats is harmless, and a control that refuses
  it reads as broken.
- BUILD THE CONTROLS THE ASK ASKED FOR, AND NEVER A SECOND WAY TO DO THE SAME
  THING. "One button that cancels all of them" is ONE button: a per-row Cancel
  beside it is the same verb twice. A row action is for a verb the ask puts ON
  the row — "let me cancel one", "kick one back".
- A form that FILES a record shows a field for every argument the write takes —
  including the ones the ask already fixed, prefilled and editable. "Open a bug
  on the mobile team" arrives with Team reading \`mobile\`; hard-coding it in the
  call and printing it as a sentence takes away their ability to change it.
- An id argument carries the row's \`id\` field VERBATIM (\`bld_4188\`), never the
  number a person says ("build #4188") — the host knows its own ids, not your
  respelling of them.

## Components and plain HTML

- Prefer the catalog: its components carry this product's theme, and their props
  are checked.
- Beside it you have plain display HTML — \`${DISPLAY_TAG_NAMES.join("`, `")}\` — used the way you'd use
  it anywhere: headings, prose, lists, and any structure the catalog doesn't
  offer.
- Display tags take children and an inline \`style\`, nothing else — no handlers,
  so anything that ACTS is a component.
- Whatever you build yourself, style off the host's own CSS variables
  (\`var(--vendo-color-accent)\`, \`var(--vendo-density-content-gap)\`), never
  hard-coded values: a hard-coded color is your color, not the product's.
- Every variable there is, and what each one means, is listed at the end of this
  file.
- You format every figure yourself, with \`Intl\` — \`toLocaleString\`,
  \`toLocaleDateString\` — in the units the host stores and the currency the brief
  names. Components display and theme what you hand them; none of them formats.
  Read the unit off what the tool SAYS, not off the field's name: a field called
  plain \`amount\` whose description reads "\`amount\` is in CENTS: 285000 is
  $2,850.00" is cents everywhere you print it.
- A CHART IS NO EXCEPTION. It plots the raw numbers, and every figure it PRINTS —
  a slice's legend line, a bar's label, a hovered point, an x tick — comes from a
  \`format\` function you write, of the row:
  \`format={(row) => money(row.amount)}\` on a DonutChart,
  \`series={[{key:"amount",label:"Spend",format:(row) => money(row.amount)}]}\` on a
  Bar or Line chart, \`xFormat={(row) => day(row.month)}\` for the x axis. It is the
  same helper the table beside it uses.
- The ONE figure you cannot write is a value-axis tick: the chart invents those
  off the scale, and they read as the plotted numbers with digit grouping
  (285000 → "285,000"). So plot the units you want read — divide where you
  PREPARE the rows if the axis matters.

## The sandbox

- No network, no storage, no timers, no clock: no \`fetch\`, no \`localStorage\`,
  no \`setTimeout\`, no \`new Date()\`.
- A style that fetches (\`url(…)\`) is dropped.
- \`key={…}\` on every row you \`.map\`.

## State — \`useState\`

- Inputs are controlled: \`value={x}\` with \`onChange={(e) => setX(e.target.value)}\`,
  and \`value\` must read STATE you set in that same handler. A \`value\` taken off
  query data — \`value={row.status}\` — with no \`setX\` behind it snaps back to the
  old value the instant they pick something: the tool call goes out and the screen
  shows nothing happened. Where the choice IS the action and you hold no state for
  it, leave \`value\` off.
- A handler receives a plain \`{ target: { value } }\` — a checkbox or a switch,
  \`{ target: { checked } }\`.
- Two controls put something other than a string in \`value\`, and the state they
  set has to match, so convert it in the handler:
  - \`<Slider>\` gives a number — \`onChange={(e) => setPoints(Number(e.target.value))}\`.
  - \`<Select multiple>\` gives the whole selection —
    \`onChange={(e) => setPicked([...e.target.value])}\`, over \`useState([])\`.
- There is no \`preventDefault\` to call: \`<Form>\` submits itself.

---

## Worked screens

The ask: "let me cancel a transfer before it goes out."

\`\`\`tsx
import { Button, Card, Row, Stack, Text, tools, useQuery } from "@vendo/screen";

const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function PendingTransfers() {
  const pending = useQuery("list_pending_transfers");

  return (
    <Stack gap={12}>
      <Text text="Transfers waiting to go out" variant="heading" />

      {pending.data.length === 0 ? (
        <Text text="Nothing is waiting to go out." variant="caption" />
      ) : (
        pending.data.map((transfer) => (
          <Card key={transfer.id} title={transfer.recipient}>
            <Row justify="between" align="center">
              <Stack gap={4}>
                <Text text={money(transfer.amount_cents)} />
                <Text text={day(transfer.scheduled_for)} variant="caption" />
              </Stack>
              <Button label="Cancel" tone="danger" onClick={() => tools.cancel_transfer({ id: transfer.id })} />
            </Row>
          </Card>
        ))
      )}
    </Stack>
  );
}
\`\`\`

The ask: "what do I owe this month, and let me pay it all at once." A total the ask
names is COMPUTED off the rows the screen drew, and said again in the dialog that
acts on it.

\`\`\`tsx
import { useState } from "react";
import { Button, DataTable, Modal, Row, Stack, Stat, Text, tools, useQuery } from "@vendo/screen";

const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function BillsDue() {
  const bills = useQuery("list_open_bills");
  const [confirming, setConfirming] = useState(false);
  const totalCents = bills.data.reduce((sum, bill) => sum + bill.amount_cents, 0);

  return (
    <Stack gap={12}>
      <Row justify="between" align="center">
        <Stat label="Due this month" value={money(totalCents)} />
        <Button label="Pay all" onClick={() => setConfirming(true)} />
      </Row>
      <DataTable rows={bills.data} columns={["payee", { key: "due_on", label: "Due", cell: (bill) => <Text text={day(bill.due_on)} /> }, { key: "amount_cents", label: "Amount", align: "end", cell: (bill) => <Text text={money(bill.amount_cents)} /> }]} />
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Pay every open bill?"
        footer={<Button label="Pay all" onClick={() => { for (const bill of bills.data) tools.pay_bill({ id: bill.id }); setConfirming(false); }} />}>
        <Text>This pays {bills.data.length} bills, {money(totalCents)} in total.</Text>
      </Modal>
    </Stack>
  );
}
\`\`\`

The ask: "compare the plans side by side." An ask that names the things to compare
gets a fixed \`columns\` — \`minChildWidth\` is for tiles whose count the data decides.

\`\`\`tsx
import { Button, Card, Grid, KeyValue, Stack, Text, tools, useQuery } from "@vendo/screen";

const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function ComparePlans() {
  const plans = useQuery("list_plans");

  return (
    <Stack gap={12}>
      <Text text="Every plan, side by side" variant="heading" />
      <Grid columns={3} gap={8}>
        {plans.data.map((plan) => (
          <Card key={plan.id} title={plan.name}>
            <Stack gap={6}>
              <Text text={money(plan.price_cents)} variant="heading" />
              <KeyValue record={plan} items={[{ key: "seats", label: "Seats" }, { key: "support", label: "Support" }]} />
              <Button label="Switch" onClick={() => tools.switch_plan({ id: plan.id })} />
            </Stack>
          </Card>
        ))}
      </Grid>
    </Stack>
  );
}
\`\`\`

The ask: "let me work through the open tickets one at a time." Three habits: the
selection starts on the FIRST row, never on nothing; the row action is on EVERY row,
and \`disabled\` only where THAT ROW has nothing to do (a ticket already closed), with
the reason on it; and the filter's choices are read
off the data rather than typed out, so they cannot disagree with it.

\`\`\`tsx
import { useState } from "react";
import { Button, DataTable, KeyValue, Row, Select, SplitPane, Stack, Tooltip, tools, useQuery } from "@vendo/screen";

export default function Tickets() {
  const tickets = useQuery("list_tickets");
  const rows = tickets.data;
  const [openId, setOpenId] = useState(rows[0]?.id);
  const [category, setCategory] = useState("");
  const shown = category === "" ? rows : rows.filter((row) => row.category === category);

  return (
    <SplitPane size="45%">
      <Stack gap={8}>
        <Select label="Category" placeholder="All categories" value={category}
          options={[...new Set(rows.map((row) => row.category))]}
          onChange={(e) => setCategory(e.target.value)} />
        <DataTable rows={shown} columns={["subject", "status"]} rowActions={(row) => (
          <Row gap={6}>
            <Button label="Open" disabled={row.id === openId} onClick={() => setOpenId(row.id)} />
            <Tooltip label={row.status === "closed" ? "Already closed" : "Close this ticket"}>
              {/* openId is sibling state to this press — read it with prev, never the render's copy. */}
              <Button label="Close" tone="danger" disabled={row.status === "closed"} onClick={() => { tools.close_ticket({ id: row.id }); setOpenId((prev) => (prev === row.id ? rows.find((other) => other.id !== row.id)?.id : prev)); }} />
            </Tooltip>
          </Row>
        )} />
      </Stack>
      <KeyValue record={rows.find((row) => row.id === openId)} items={["subject", "category", "assignee", "status"]} />
    </SplitPane>
  );
}
\`\`\`

---

`;

/**
 * What each variable is FOR, one short line each — never what it is SET to: the
 * values are this host's and per-theme, and the briefing pack carries them.
 *
 * Only the MEANINGS live here. The names the section prints are walked off
 * `VENDO_THEME_VARIABLE_NAMES`, which is read off `themeCssVariables` itself, so
 * a variable added or renamed reaches the manual the day it is emitted and a
 * meaning left behind fails the drift test instead of teaching a dead name.
 */
const VARIABLE_MEANINGS: Record<string, string> = {
  "--vendo-color-success": "a completed or positive state",
  "--vendo-color-warning": "something that needs attention, not yet wrong",
  "--vendo-color-info": "a state in progress — neither good news nor bad",
  "--vendo-color-surface-raised": "a panel resting on a surface",
  "--vendo-color-background": "the page behind everything",
  "--vendo-color-surface": "a panel resting on the page",
  "--vendo-color-text": "body text",
  "--vendo-color-muted": "secondary text and labels",
  "--vendo-color-accent": "the brand color — the primary action",
  "--vendo-color-accent-text": "text and icons sitting on the accent",
  "--vendo-color-danger": "destructive and error",
  "--vendo-color-border": "hairlines, outlines and dividers",
  "--vendo-color-scheme": "`light` or `dark`, derived from the background",
  "--vendo-font-family": "the body text face",
  // The ONE name the emitter may not set (`if (type.headingFamily)`), so the one
  // meaning that has to carry its own absence and the fallback to write instead.
  "--vendo-heading-family": "the heading face, set only when this host names one — write it as "
    + "`var(--vendo-heading-family, var(--vendo-font-family))`",
  "--vendo-mono-family": "the monospace face, for code and figures",
  "--vendo-font-size": "the body text size",
  "--vendo-base-size": "that same size, as the anchor the type scale derives from",
  "--vendo-font-weight-normal": "the body weight",
  "--vendo-font-weight-emphasis": "the weight for emphasis and headings",
  "--vendo-letter-spacing": "the body tracking",
  "--vendo-line-height": "the body leading",
  "--vendo-line-height-heading": "the tighter leading a heading takes",
  "--vendo-radius-small": "the corner radius of a control or badge",
  "--vendo-radius-medium": "the corner radius of a card or input",
  "--vendo-radius-large": "the corner radius of a panel or sheet",
  "--vendo-shadow-small": "the hover lift",
  "--vendo-shadow-medium": "anything resting above a surface",
  "--vendo-shadow-large": "an overlay floating over the page",
  "--vendo-border-width": "the hairline thickness",
  "--vendo-chart-1": "the first chart series color — the accent itself",
  "--vendo-chart-2": "the second chart series color",
  "--vendo-chart-3": "the third chart series color",
  "--vendo-chart-4": "the fourth chart series color",
  "--vendo-chart-5": "the fifth chart series color",
  "--vendo-chart-6": "the sixth chart series color",
  "--vendo-density": "`comfortable` or `compact` — which spacing scale is in force",
  "--vendo-density-control-height": "the height of a button or input",
  "--vendo-density-control-padding": "the padding inside a button or input",
  "--vendo-density-card-padding": "the padding inside a card",
  "--vendo-density-content-gap": "the gap between blocks stacked in a column",
  "--vendo-density-inline-gap": "the gap between items sitting in a row",
  "--vendo-density-field-gap": "the gap between a label and its field",
  "--vendo-density-table-padding": "the padding inside a table cell",
  "--vendo-density-badge-height": "the height of a badge",
  "--vendo-density-badge-padding": "the padding inside a badge",
  "--vendo-density-stat-padding": "the padding inside a stat",
  "--vendo-density-tabs-padding": "the padding around a tab strip",
  "--vendo-density-tab-height": "the height of one tab",
  "--vendo-density-tab-padding": "the padding inside one tab",
  "--vendo-motion": "`full` or `reduced`",
  "--vendo-motion-duration": "one transition's duration — `0ms` when motion is reduced",
  "--vendo-motion-easing": "the easing curve a transition uses",
};

/** The VARIABLES section, generated the way the catalog is. */
const variablesPromptSection = (): string => `---

# The host's CSS variables

- Every one of these is already set on your screen, at this product's own values,
  unless its own line says otherwise.
- Use the NAME, never a copied value: the values are in the brief, and a copy
  stops being the product's the moment its theme changes.
- A name outside this list resolves to nothing, and the declaration it was in
  silently falls back.

${VENDO_THEME_VARIABLE_NAMES.map((name) => `\`${name}\` — ${VARIABLE_MEANINGS[name]}`).join("\n")}
`;

/** The reference as it lands on disk. */
export const VENDO_FORMAT_REFERENCE = `${CHAPTER}${componentsPromptSection()}\n\n${variablesPromptSection()}`;
