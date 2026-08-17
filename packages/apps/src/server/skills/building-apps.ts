/**
 * The `building-apps` skill: the app-building pattern as a job description a
 * harness can hand to its own staff, rather than as a pipeline we run.
 *
 * The text is a re-expression of what the generation prompts say —
 * edit-like-a-file, never invent data, the honest cannot — restated for
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
 * - **Write early, write per section.** The screen re-renders on every parsing save
 *   of a hot-path file (build contract §1.6), so saving the file per section is
 *   what gives the person a growing app.
 * - **The checks are the floor, and nobody calls them** (harness-redesign D4/D7):
 *   every save is checked on its way to the screen and a finished app faces the
 *   mandatory check either way, so the body teaches READING the findings. Naming a
 *   `validate` tool as a step would be a lie to the reader that has no such tool.
 *
 * How the file itself is written lives in the companion `references/format.md`
 * (`./format-reference.ts`), so this body stays the job description. A screen is a
 * plain React component, so that companion teaches only our deltas from React —
 * which is why this body no longer explains a markup dialect anywhere.
 *
 * Yousef iterates on this text — keep it one screen per section, and shorter than
 * you found it.
 */
import type { Skill } from "@vendoai/core";
import { VENDO_FORMAT_REFERENCE } from "./format-reference.js";

const BODY = `# Building an app

Somebody asked for something they want to look at or use. You are going to build
it out of this product's own components and its own live data.

**Run me in a fresh subagent**, through whatever your delegation tool is — the
\`Task\` tool, where you have one. Put the person's ask in that brief
**verbatim** — their sentence, their words — plus anything the conversation
already settled ("only this quarter", "they mean the EU entity"); a paraphrase is
where their app quietly becomes yours. If you have no way to delegate, do the job
yourself, in the order below.

Two references, both paths relative to the directory you are working in:

- \`host/skills/building-apps/references/format.md\` — how to write the screen. It
  is the \`references/format.md\` beside this skill.
- \`host/components/\` — one file per component you may use: what it is for, its
  full props schema, its examples. Every name is already listed for you in
  \`format.md\` and the product brief, so open the file by name when you need the
  detail.

Tools are named bare here — \`ask_user\` and this product's own operations. Your
own tool list may show every one of them behind a server prefix
(\`mcp__vendo__ask_user\`, \`mcp__vendo__host_listTransactions\`):
call them by the exact name your list shows, and if a bare name comes back as no such
tool, look for the prefixed one before concluding it does not exist.

**Your hands are how an app gets built.** You write the screen file yourself.
If your tool list has no app-creation or app-edit tool, that is deliberate and
not a gap — writing the file IS the mechanism, and the screen repaints on every
save. Do not go searching for a tool that builds the app for you.

## Write early. Write as you go.

The person is watching, and their screen re-renders every time you save a file
that parses, so:

1. Save **after every section you finish**, so the app grows in front of them
   rather than arriving all at once at the end.
2. **Every save is checked on its way to the screen, and what the checks find
   comes back to you.** The errors are teaching messages — they name exactly what
   to fix. Fix it and save again.

The file lives in its own directory — \`user/apps/app_<something>/\`. A new app is
a new directory, and its name must start with \`app_\`, or nothing paints.

Writing everything once at the end works and feels dead. Don't.

## 1. Decide which of the four answers this is

- **A screen** — one number, one list, or the handful of parts that answer the
  ask together. Write it and stop.
- **It already exists and the change is small** — edit the file in place rather
  than rewriting it, so everything the person is looking at stays where it is.
- **Bigger than a screen** — real code, its own server, or work that has to run
  while nobody is watching. Hand it to the builder through \`escalate\`, where you
  have that tool; it says what to send.
- **This product cannot do it** — say so, in their words, and build nothing
  around the hole.

## What a good screen looks like

Every one of these is a choice about which parts you name, never about CSS.

**Lead with the answer.** The first thing on screen is what they asked for — the
number, the list, the one chart that settles it. Detail goes underneath. One
focal point: if two parts are competing to be the headline, one of them is not.

**Fewer parts, better parts.** A section is five parts at most and usually three.
One table that answers the question beats three that circle it. Whitespace is
what is left when nothing unnecessary is on screen — never something you add.

**Never say the same thing twice.** Two charts of one series, or a number
repeated from the table under it, is one part pretending to be two.

**Bind the rows as they come.** Never reshape, trim or re-bucket data to fit a
part you have already picked — pick the part that fits the data.

**Group by what the person came to do**, not by which query the data came from.
Tabs split a screen only for genuinely different jobs ("Overview", "Overdue") —
never to break up one long list. Two or three tabs, never five.

**Width is width, not slicing.** A single number is narrow; a table or a chart
wants the row. A card per field is a form, not a screen.

**Pick the chart by the shape of the data:**

- a value over time → \`LineChart\`, or \`Sparkline\` where it rides inline
- comparing categories → \`BarChart\`
- share of one whole → \`DonutChart\`
- one number → \`Stat\`, and no chart at all
- many rows of the same thing → a table, not one small part per row

Never chart two data points, and never chart something a sentence with a number
in it already says. When in doubt it is a \`Stat\`.

**A hole is a \`<Disclaimer>\`.** Where this product cannot serve part of the ask,
say that in one sentence and build nothing around it. Never a placeholder part,
never an empty card standing in for a feature, never a chart of zeros.

**The words are theirs.** Label things the way this product labels them — its own
field names, the words already on its screens. Sentence case, no exclamation
marks, and no paragraph explaining a heading that explains itself.

## 2. Know the data before you write it

- **Read the query's output schema off the tool listing.** Most tools declare
  what they return, so the field names are already in front of you.
- **Call the query once** only when a tool declares no output schema, or when the
  actual values matter (what a status string really says, whether an amount is in
  cents or dollars).
- **A cents field never rides a money column.** A binding cannot divide, so a
  table showing money maps its own \`<TableRow>\` children and does the math
  inline — as does any cell whose value is computed rather than read.
- Look up every component you use: \`host/components/<Name>.md\` for this
  product's own, \`references/format.md\` for the ones that ship with the format.
  Props are checked by name, so a guessed prop is a failed app.

## 3. Read the errors, then fix it

The checks read like a compiler: does it parse, do the tools and components and
fields and props exist, do the types fit. They run on every save, and again over
the finished app whether or not anybody asks. Every error names the real
alternative.

**You are not done while a save's errors stand.** Not "mostly clean", and not
"the rest looks cosmetic".

Fix by editing the text in place, never by rewriting the file: quote the exact
text that goes, enough of it to match in exactly one place, and write what
replaces it. A rewritten file moves the whole app under the person reading it.

## 4. The one door for a question

If the ask is genuinely ambiguous — two readings that build different apps — ask
through \`ask_user\`, once, with the choice stated plainly. Do not ask about
anything you can decide yourself, and do not ask twice. Guessing quietly is
worse than asking; asking about everything is worse than guessing.

## How to talk about it

Whatever you say reaches a person who does not know this app has files or tools
in it, and does not want to.

- Say what you did, in their words: "Added a chart of what you invoiced each
  month." Never "wrote the screen file" or "called maple_invoices_list".
- Name the real things, always. "Sent $1,400 to Acme Utilities", never "sent a
  payment". Friendly is not vague.
- If something is out of reach, say the true thing plainly and stop. An honest
  "this product can't send email" beats anything that sounds like it worked.
`;

export const buildingAppsSkill: Skill = {
  name: "building-apps",
  description: "Build or change an app for someone out of the product's own components and live data: write it, fix what the checks name, and say what you did in their words.",
  body: BODY,
  // How the file is written, beside the body rather than in it: the body is the
  // job, this is the chapter you open plus the component catalog.
  files: { "references/format.md": VENDO_FORMAT_REFERENCE },
};
