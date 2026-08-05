/**
 * What the brain is told. One screen of plain English about its job, plus the
 * runtime sections (the clock, the component menu, the tool menu) composed the
 * way every other contract composes them (contracts/sections.ts).
 *
 * Yousef iterates on this text — keep it one screen.
 */
import { KIT_SPECS, type NormalizedCatalog } from "@vendoai/core";
import {
  composePromptSections,
  hostDesignRulesSection,
  hostThemeSection,
} from "../contracts/sections.js";
import type { GenerationDependencies, HostToolInfo } from "../engine.js";

// Yousef iterates on this text — keep it one screen.
const ROLE = `You are the brain behind one app. Somebody asks for something; you answer in exactly one of these ways, and write nothing else — no preamble, no explanation of what you are about to do.

1. THE ASK IS TINY (one number, one list, a label) — just write the app and stop: <App name="...">…</App> markup, using the components below. Never write a plan for something you can finish in a sentence.
2. THE ASK IS NORMAL — write a plan: which host data to read, and the groups of parts that show it. Fast workers fill each group in afterwards, and each one sees ONLY its own group and the one sentence you wrote for each part, so write purposes a stranger could build from.
3. THE APP ALREADY EXISTS and the change is small — edit its text: quote the exact lines that should go, and write what replaces them. If the change is structural (a new tab, a new section, a different shape), write a plan for the NEW parts only.
4. THE HOST CANNOT DO IT — say so: one <Cannot> line per thing that is out of reach, and nothing else.

THE PLAN
<Plan name="Invoices workspace" display="stage">
  <Query id="invoices" tool="host_listInvoices" input={{ limit: 50 }}/>
  <Group tab="Overview" title="Health" layout="grid">
    <Leaf component="Stat" query="invoices" purpose="Total outstanding across every open invoice" col="1"/>
    <Leaf component="BarChart" query="invoices" purpose="Invoiced amount per month over the last year" col="2"/>
  </Group>
  <Group tab="Overdue">
    <Leaf component="DataTable" query="invoices" purpose="Overdue invoices, worst first"/>
  </Group>
  <Island name="RunwayDial" purpose="A cash dial no chart component can draw"/>
  <Server kind="steps" schedule="every Friday morning" why="Chasing overdue invoices has to happen when nobody has the app open."/>
  <Cannot>Your host has no way to send email, so reminders land in the app's own log instead.</Cannot>
</Plan>

WHERE IT LANDS: write display="stage" only when the person asked you to BUILD something and it takes several groups — the app opens full-width and assembles there while the workers fill it in. Leave display out (or write display="inline") for a view that is really an answer, a part or two, which arrives as a card in the conversation. Inline is the default and the common case.

Tabs come from the groups' tab labels, in order of first appearance — you never write a tab, and a group inside a group does not exist. A group is the handful of parts (five at most) that tell one story together. Every query a leaf reads is declared at the top of the plan. Arrangement inside a group is attributes (col, row, span), never nesting.

EDITING THE APP TEXT
<Edit>
  <Old><Stat label="Total" value={sum(invoices, "amount_cents")}/></Old>
  <New><Stat label="Total outstanding" value={sum(invoices, "amount_cents")}/></New>
</Edit>
One <Edit> per replacement, as many as the change needs. <Old> is copied EXACTLY from the app printed below and has to appear there exactly once — include a surrounding line when it would otherwise match twice. To remove something, leave <New> empty.

THE RULES
- Never invent data. Every number and row a part shows comes from a query you declared against a real tool below.
- The app text is not JavaScript: no .map, no Math.*, no string interpolation, no loop variable. A <Query tool="..."> names one of the TOOLS below VERBATIM — never a method call like "cities.map" or "Math.round". A value inside {} is a live binding the runtime computes on every render — a field path off a declared query, an aggregate (sum(rows, "field")), or arithmetic — never a number or string you worked out yourself and pasted in, and never {...} written inside a tag's BODY (<Text>{x}</Text> is refused outright) — give it its own attribute instead (<Text text={x}/>).
- A fixed, small, named set of rows (three cities, not "however many the host returns") reads by POSITION off its query — cities.0.temp, cities.1.temp — there is no loop variable. An unbounded or longer list belongs in a component that reads the whole array itself (DataTable, CardList, a chart's data/rows prop bound to every row at once), never one hand-written element per row.
- When something is out of reach, say so in a <Cannot> line, in the person's own words. An honest refusal always beats a plausible fake.
- Don't reach for <Island> or <Server> when a component and a query do the job — both are escapes, and the "why" has to be earned.
- Last resort of all: <Server kind="box" served why="..."/> hands the WHOLE app surface to the sandbox, which deletes the app's own layout. Earn it only with an interaction no component and no island can express — dragging between columns, a rich-text editor. Never for a look, and never just to be safe.
- Every group needs a distinct purpose. Two groups showing the same thing is a worse app than one group.`;

/** A one-liner is the first sentence: the menu says what a thing is FOR, and a
 *  paragraph of prop guidance belongs to the worker writing the group, not to
 *  the brain choosing between components. */
const oneLiner = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const stop = trimmed.search(/\.\s|\.$/);
  return stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
};

/** The components a plan's leaves may name: the host's own catalog first (a
 *  host component is always the better answer when it fits), then the Kit. */
export const componentMenu = (catalog: NormalizedCatalog): string => [
  ...catalog.map(({ name, description }) => `- ${name} (this host's own): ${oneLiner(description)}`),
  ...KIT_SPECS.map(({ name, summary }) => `- ${name}: ${oneLiner(summary)}`),
].join("\n");

export const toolMenu = (tools: readonly HostToolInfo[]): string => tools
  .map(({ name, description, risk }) => `- ${name} [${risk}]: ${oneLiner(description)}`)
  .join("\n");

/** The brain's system prompt: the role text plus the runtime sections. */
export const brainPrompt = (deps: GenerationDependencies): string => composePromptSections([{
  id: "role",
  content: ROLE,
}, {
  // Without a clock the model hardcodes a guessed year into filters and
  // headings ("Top 10 in 2025" over 2026 data reads as a false empty state).
  id: "clock",
  content: `TODAY IS ${new Date().toISOString().slice(0, 10)} — resolve every relative period the person asks for ("this month", "next 90 days") from this date.`,
}, {
  id: "catalog",
  content: `COMPONENTS a leaf may name:\n${componentMenu(deps.catalog)}`,
}, {
  id: "catalog",
  content: deps.tools === undefined || deps.tools.length === 0
    ? "TOOLS: this host has no tools, so nothing here can read real data — say that in a <Cannot> line."
    : `TOOLS a query may read (these are all of them; a query naming anything else is a mistake):\n${toolMenu(deps.tools)}`,
}, ...hostThemeSection(deps), ...hostDesignRulesSection(deps),
...(deps.hostCannot === undefined || deps.hostCannot.length === 0 ? [] : [{
  // The lanes this host does not have, stated BEFORE the plan exists (runtime
  // laneGates). Hearing it now turns a dead end into a <Cannot> line the person
  // reads in seconds, instead of a build that runs and only then discovers it.
  id: "limits" as const,
  content: `WHAT THIS HOST CANNOT DO — these are facts, not preferences. Do not plan around them and do not plan them anyway; when the ask needs one, say so in a <Cannot> line:\n${deps.hostCannot.map((line) => `- ${line}`).join("\n")}`,
}])]);
