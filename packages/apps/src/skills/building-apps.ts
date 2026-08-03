/**
 * The `building-apps` skill: the app-building pattern as a job description a
 * harness can hand to its own staff, rather than as a pipeline we run.
 *
 * The text is a re-expression of what today's generation prompts say
 * (`generation/prompts/brain.ts`, `worker.ts`) — the plan, the blinkered fill
 * groups, edit-like-a-file, never invent data, the honest cannot — restated for
 * a reader with hands and a workspace instead of a single scripted call.
 *
 * Two things it must carry and does:
 *
 * - **Delegation advice is a sentence in the body**, never a pack property and
 *   never our machinery (architecture §6). A harness maps it to its native
 *   subagents, or ignores it; the checks floor holds either way.
 * - **Write early, write per group.** The screen re-renders on every parsing
 *   save of a hot-path file (build contract §1.6), so writing the plan file
 *   first and the app file per group is what gives the person a growing app.
 *   One big write at the end is legal and worse.
 *
 * Yousef iterates on this text — keep it one screen per section.
 */
import type { PackSkill } from "@vendoai/core";

const BODY = `# Building an app

Somebody asked for something they want to look at or use. You are going to build
it out of this product's own components and its own live data.

**Run me in a fresh subagent.** This is a big, loud job with a lot of reading in
it, and the assistant talking to the person should stay light. Hand the whole
thing over, let it finish, and keep one line about what came back.

## Write early. Write as you go.

The person is watching. Their screen re-renders every time you save a file that
parses, so:

1. Save \`plan.vendo\` **first**. The plan IS the layout — the moment it lands, the
   skeleton of their app appears on screen.
2. Save \`app.vendo\` again **after every group you fill in**, so the app grows a
   section at a time in front of them.

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
<Plan name="Invoices workspace">
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

A group is the handful of parts — five at most — that tell one story together.
Tabs come from the groups' tab labels in order of first appearance; you never
write a tab, and a group inside a group does not exist. Arrangement inside a
group is attributes (\`col\`, \`row\`, \`span\`), never nesting. Every query a leaf
reads is declared at the top. Two groups showing the same thing is a worse app
than one group.

Write each \`purpose\` so a stranger could build that part from it and nothing
else — because that is exactly what happens next.

## 3. Fill the groups in — one worker per group, blinkered

Give each group to its own worker, in parallel. A worker sees **only** its own
group, the docs for the components its leaves name, and real sample rows from its
queries. The blinkers are the design, not a limitation: a worker that cannot see
the rest of the app cannot quietly contradict it.

Tell each worker:

- Write only the markup inside its section — one element per part, in order.
- **Show what is in the data.** Every number, name, date and status on screen is
  a reference to a query: \`rows={invoices}\`, \`cents={invoice.total_cents}\`. Text
  you write yourself is fine for labels and headings, never for data.
- **Never do arithmetic yourself.** Write the calculation and let the runtime
  compute it fresh on every render: \`value={sum(transactions.amount_cents)}\`.
  Inside those braces: field paths, numbers, \`+ - * / ( )\`, and \`sum\`, \`count\`,
  \`average\`, \`min\`, \`max\`, \`difference\`, \`days_until\`, \`group_by\`. Nothing else.
- When a part's data is genuinely missing, let the component render its own empty
  state. Never fill the hole with an example.

A made-up figure is indistinguishable from a real one to the person reading it,
which makes it the worst thing this app can ship.

## 4. Check it, then fix it

Run \`validate\` on the file. It reads like a compiler: does it parse, do the tools
and components and fields exist, do the types fit. Every issue it reports is a
sentence that names the real alternative — fix from it and validate again.

Fix by editing the text, never by rewriting the file:

\`\`\`
<Edit>
  <Old><Stat label="Total" value={sum(invoices.amount_cents)}/></Old>
  <New><Stat label="Total outstanding" value={sum(invoices.amount_cents)}/></New>
</Edit>
\`\`\`

\`<Old>\` is copied exactly from the file and must appear there exactly once —
include a surrounding line if it would otherwise match twice. An empty \`<New>\`
deletes. One \`<Edit>\` per replacement.

There are checks after you that you cannot see and cannot skip. They are not
your enemy; they are the reason you can move fast.

## 5. The one door for a question

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
};
