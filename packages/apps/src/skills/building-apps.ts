/**
 * The `building-apps` skill: the app-building pattern as a job description a
 * harness can hand to its own staff, rather than as a pipeline we run.
 *
 * The text is a re-expression of what today's generation prompts say
 * (`generation/prompts/brain.ts`, `worker.ts`) — the plan, the blinkered fill
 * groups, edit-like-a-file, never invent data, the honest cannot — restated for
 * a reader with hands and a workspace instead of a single scripted call.
 *
 * Four things it must carry and does:
 *
 * - **Delegation advice is a sentence in the body**, never a pack property and
 *   never our machinery (architecture §6). A harness maps it to its native
 *   subagents, or ignores it; the checks floor holds either way. Which is why the
 *   body names `Task` CONDITIONALLY: the same text is read by `claudeCode()`, which
 *   has it, and by `vendo()`'s hired specialist, which has no hiring tool at all
 *   (depth is bounded at one).
 * - **Every path is workspace-RELATIVE.** The `/host` mount is a WORKSPACE path; on
 *   disk it lands under the machine's root (`/workspace/host/...` in a box, a temp
 *   dir on `machine: "local"`) and the session's cwd IS that root, so
 *   `host/components/` resolves on both legs and `/host/components/` on neither.
 * - **Write early, write per group.** The screen re-renders on every parsing save of
 *   a hot-path file (build contract §1.6), so writing the plan file first and the
 *   app file per group is what gives the person a growing app.
 * - **Validate is the floor, not a nicety** (harness-redesign D4/D7): with the
 *   engine off this surface, the builder's own `validate` call is the only check
 *   between a guess and a shipped app.
 *
 * Syntax depth lives in the companion `references/format.md`
 * (`./format-reference.ts`), so this body stays the job description.
 *
 * Yousef iterates on this text — keep it one screen per section.
 */
import type { PackSkill } from "@vendoai/core";
import { VENDO_FORMAT_REFERENCE } from "./format-reference.js";

const BODY = `# Building an app

Somebody asked for something they want to look at or use. You are going to build
it out of this product's own components and its own live data.

**Run me in a fresh subagent**, through whatever your delegation tool is — the
\`Task\` tool, where you have one. This is a big, loud job with a lot of reading in
it, and the assistant talking to the person should stay light. Hand the whole
thing over, let it finish, and keep one line about what came back. If you have no
way to delegate, do the job yourself, in the order below — everything here still
holds.

Put the person's ask in that brief **verbatim** — their sentence, their words —
plus anything the conversation already settled ("only this quarter", "they mean
the EU entity"). A paraphrase is where their app quietly becomes yours.

Two references, on disk, whenever you need them. Both paths are relative to the
directory you are working in:

- \`host/skills/building-apps/references/format.md\` — the whole \`.vendo\` syntax.
  It is the \`references/format.md\` beside this skill.
- \`host/components/\` — one file per component you may use: what it is for, its
  full props schema, its examples. Grep it; \`search_components\` is the quick
  lookup when you do not know a name yet.

Tools are named bare here — \`search_components\`, \`validate\`, \`ask_user\`, and this
product's own operations. Your own tool list may show every one of them behind a
server prefix (\`mcp__vendo__validate\`, \`mcp__vendo__host_listTransactions\`): call
them by the exact name your list shows, and if a bare name comes back as no such
tool, look for the prefixed one before concluding it does not exist.

**Your hands are how an app gets built.** You write \`plan.vendo\` and \`app.vendo\`
yourself. If your tool list has no app-creation or app-edit tool, that is
deliberate and not a gap — writing the files IS the mechanism, and the screen
repaints on every save. Do not go searching for a tool that builds the app for you.

## Write early. Write as you go.

The person is watching. Their screen re-renders every time you save a file that
parses, so:

1. Save \`plan.vendo\` **first**. The plan IS the layout — the moment it lands, the
   skeleton of their app appears on screen. Run \`validate\` on it right there: a
   plan that names a tool or a component that does not exist is a whole app built
   on sand.
2. Save \`app.vendo\` again **after every group you fill in**, so the app grows a
   section at a time in front of them. Run \`validate\` on every one of those
   saves, so a mistake is one section old instead of a whole app old.

Both files live in the app's own directory — \`user/apps/app_<something>/\`. A new
app is a new directory, and its name must start with \`app_\`, or nothing paints.

Writing everything once at the end works and feels dead. Don't.

## 1. Decide which of the four answers this is

- **Tiny** — one number, one list, one label. Write the app and stop. Never plan
  something you can finish in a sentence.
- **Normal** — write the plan, then fill it in.
- **It already exists and the change is small** — edit the app's text in place.
  Quote the exact lines that go and write what replaces them. Small edits keep
  everything the person is already looking at exactly where it is.
- **This product cannot do it** — say so, in their words, and build nothing
  around the hole.

## 2. The plan

The plan names the data to read and the groups of parts that show it:

\`\`\`
<Plan name="Invoices workspace" display="stage">
  <Query id="invoices" tool="maple_invoices_list" input={{ limit: 50 }}/>
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

\`display="stage"\` is for what the person asked you to BUILD when it takes
several groups: the app opens full-width and assembles there while you fill it
in. Leave it out (or write \`display="inline"\`) when the view is really an
answer, a part or two — that arrives as a card in the conversation, and it is
the common case.

A group is the handful of parts — five at most — that tell one story together.
Tabs come from the groups' tab labels in order of first appearance; you never
write a tab, and a group inside a group does not exist. Every query a leaf reads
is declared at the top. Two groups showing the same thing is a worse app than one
group.

Write each \`purpose\` so a stranger could build that part from it and nothing
else — because that is exactly what happens next.

## 3. When part of it has to happen while they are away

Some asks are not only a view. "Check every morning", "whenever an invoice comes
in" — part of that has to run when nobody is looking. You do not write the
automation yourself. You DECLARE it, once, in the plan, and the engine turns your
sentence into the thing that fires:

\`\`\`
<Server kind="steps" why="The overdue check has to run at 8am whether or not anyone opens this." schedule="every weekday at 8am"/>
\`\`\`

- \`kind="steps"\` — **every firing does the same thing.** A fixed recipe: read,
  work it out, publish. No model in the loop, so it is free to run at night. This
  is the right answer far more often than it looks.
- \`kind="agentic"\` — **each firing needs judgment.** Which of these actually
  matter, what to say about them. It costs a model call every time it fires, so
  only choose it when a fixed recipe genuinely cannot decide.
- \`why\` is required and it is one sentence: why this cannot happen in the
  browser. Without it the whole thing is dropped.
- \`schedule\` is the cadence **the way the person said it** — "every Friday
  morning". Write their phrasing; the engine stores the cron. Leave it out when
  the trigger is something happening in the product rather than a clock.

A clock ("every morning", "in an hour", "on the 3rd") and things happening inside
this product are what a trigger can wait for. Something calling in from outside
this product is not available. If that is what they asked for, say so plainly and
build nothing around the hole.

**A run that shows nothing did not happen.** Nobody watches it fire, so the only
evidence is on screen: the run publishes its result into the app's own records,
and the app reads those rows back. So the plan needs the group that shows it — a
\`<Server>\` with nothing on the board to read it is an automation firing into the
dark forever.

**Nothing irreversible runs away.** If the away part is sending, messaging,
paying or deleting, that is not an automation and you do not build one. Vendo
will not do a thing it cannot take back while nobody is watching. Say that in
their words, and offer the version that does work: it watches, it publishes what
it found, and they send it themselves in one tap next time they look. The honest
limit goes in \`<Cannot>\`; the away-safe half is what \`<Server>\` declares.

**Arming is never yours.** You declare it — the person turns it on, from a card
that tells them what it will do and what it needs access to. Do not tell them it
is running, do not wait for it to fire, and do not go looking for a tool that
switches it on. There isn't one, and that is the point.

Name it the way they would say it out loud — "Morning overdue check", never
"scheduled steps trigger".

## 4. Know the data before you write it

- **Read the query's output schema off the tool listing.** Most tools declare
  what they return, so the field names are already in front of you. That is where
  you learn them.
- **Call the query once** only when a tool declares no output schema, or when the
  actual values matter (what a status string really says, whether money is cents).
- Look up every component you intend to use: \`host/components/<Name>.md\` for
  this product's own, \`references/format.md\` for the ones that ship with the
  format. Props are checked by name, so a guessed prop is a failed app.

## 5. Fill the groups in — one worker per group, blinkered

Give each group to its own worker — one \`Task\` per group, all launched together,
where you have that tool. Without one, fill the groups yourself, one at a time in
order, and read only what that group needs while you are on it.

A worker sees **only** its own group, the docs for the components its leaves name,
and the shape of its queries. The blinkers are the design, not a limitation: a
worker that cannot see the rest of the app cannot quietly contradict it.

Tell each worker:

- Write only the markup inside its section — one element per part, in order.
- **Show what is in the data.** Every number, name, date and status on screen is
  a reference to a query: \`rows={invoices.data}\`, \`cents={invoice.total_cents}\`.
  Text you write yourself is fine for labels and headings, never for data.
- **Never do the arithmetic yourself, and never paste in a value you fetched.**
  Write the calculation and let it compute fresh on every render:
  \`value={sum(transactions, "amount_cents")}\`. Inside those braces: field paths,
  numbers, quoted strings, \`+ - * / ( )\`, and \`sum\`, \`count\`, \`average\`,
  \`min\`, \`max\`, \`difference\`, \`days_until\`, \`group_by\`. Nothing else. Every
  aggregate names the field it reads, with the rows first.
- **Never specify a font, a colour, or anything about the branding.** The
  components already carry this product's own look; anything you add fights it.
- When a part's data is genuinely missing, let the component render its own empty
  state. Never fill the hole with an example.

A made-up figure is indistinguishable from a real one to the person reading it,
which makes it the worst thing this app can ship. Baking in a number you looked
up once is the same lie with a delay: it is right on the screen you built it on
and wrong every day after.

## 6. Check it, then fix it

Run \`validate\` on the app document one last time, over the whole thing — the
final gate after the per-save runs above. It reads like a compiler: does it parse, do the tools and components and fields and props exist,
do the types fit. Every issue it reports is a sentence that names the real
alternative — fix from it and validate again.

**You are not done until \`validate\` comes back clean.** Not "mostly clean", and
not "the rest looks cosmetic". A worker reports done when its section validates;
you report done when the app does.

Fix by editing the text in place, never by rewriting the file. Quote the exact
text that goes and write what replaces it — and quote enough of it to match in
exactly one place. Everything the person is already looking at then stays where
it is; a rewritten file moves the whole app under them.

Where an app is changed through this product's own app tools instead of by hand,
the same change is written as an edit block, under the same rule:

\`\`\`
<Edit>
  <Old><Stat label="Total" value={sum(invoices, "amount_cents")}/></Old>
  <New><Stat label="Total outstanding" value={sum(invoices, "amount_cents")}/></New>
</Edit>
\`\`\`

\`<Old>\` must appear in the app exactly once — include a surrounding line if it
would otherwise match twice. An empty \`<New>\` deletes. One \`<Edit>\` per
replacement.

There are checks after you that you cannot see and cannot skip. They are not
your enemy; they are the reason you can move fast.

## 7. The one door for a question

If the ask is genuinely ambiguous — two readings that build different apps — ask
through \`ask_user\`, once, with the choice stated plainly. Do not ask about
anything you can decide yourself, and do not ask twice. Guessing quietly is
worse than asking; asking about everything is worse than guessing.

## How to talk about it

Whatever you say reaches a person who does not know this app has files, tools, or
a plan in it, and does not want to.

- Say what you did, in their words: "Added a chart of what you invoiced each
  month." Never "wrote app.vendo" or "called maple_invoices_list".
- Name the real things, always. "Sent $1,400 to Acme Utilities", never "sent a
  payment". Friendly is not vague.
- If something is out of reach, say the true thing plainly and stop. An honest
  "this product can't send email" beats anything that sounds like it worked.
`;

export const buildingAppsSkill: PackSkill = {
  name: "building-apps",
  description: "Build or change an app for someone out of the product's own components and live data: plan it, fill it in, validate it, and say what you did in their words.",
  body: BODY,
  // The whole `.vendo` syntax, beside the body rather than in it: the body is the
  // job, this is the manual you open when you need an attribute.
  files: { "references/format.md": VENDO_FORMAT_REFERENCE },
};
