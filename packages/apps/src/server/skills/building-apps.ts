/**
 * The `building-apps` skill: the app-building pattern as a job description a
 * harness can hand to its own staff, rather than as a pipeline we run.
 *
 * The text is a re-expression of what the generation prompts say —
 * edit-like-a-file, never invent data, the honest cannot — restated for
 * a reader with hands and a workspace instead of a single scripted call.
 *
 * Three things it must carry and does:
 *
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

## Two references

Both paths are relative to the directory you are working in.

- \`host/skills/building-apps/references/format.md\` — how to write the screen. It
  is the \`references/format.md\` beside this skill.
- \`host/components/\` — one file per component you may use: what it is for, its
  full props schema, its examples. Every name is already listed for you in
  \`format.md\` and the product brief, so open the file by name when you need the
  detail.

**Your hands are how an app gets built.** You write the screen file yourself.

- If your tool list has no app-creation or app-edit tool, that is deliberate and
  not a gap — writing the file IS the mechanism, and the screen repaints on every
  save.
- Do not go searching for a tool that builds the app for you.

## Write early. Write as you go.

The person is watching, and their screen re-renders every time you save a file
that parses.

- Save **after every section you finish**, so the app grows in front of them
  rather than arriving all at once at the end.
- **Every save is checked on its way to the screen, and what the checks find
  comes back to you.** The errors are teaching messages — they name exactly what
  to fix. Fix it and save again.
- **You are not done while a save's errors stand.** Not "mostly clean", and not
  "the rest looks cosmetic".
- Fix by editing the text in place, never by rewriting the file: quote the exact
  text that goes, enough of it to match in exactly one place, and write what
  replaces it. A rewritten file moves the whole app under the person reading it.
- Writing everything once at the end works and feels dead. Don't.

## Know the data before you write it

- **Read the query's output schema off the tool listing.** Most tools declare
  what they return, so the field names are already in front of you.
- **Call the query once** only when a tool declares no output schema, or when the
  actual values matter (what a status string really says, whether an amount is in
  cents or dollars).
- **A hole is a \`<Disclaimer>\`.** Where this product cannot serve part of the
  ask, say that in one sentence and build nothing around it. Never a placeholder
  part, never an empty card standing in for a feature, never a chart of zeros.
- **A hole is a tool this host does not have — not a verb it does not spell.** If a
  tool here does the thing they asked for under another name, wire it and label the
  control with what that tool actually does ("Send back to In progress", not "Kick
  back to author"). A disabled control explaining the gap is a placeholder part in
  disguise.
`;

export const buildingAppsSkill: Skill = {
  name: "building-apps",
  description: "Build or change an app for someone out of the product's own components and live data: write it, and fix what the checks name.",
  body: BODY,
  // How the file is written, beside the body rather than in it: the body is the
  // job, this is the chapter you open plus the component catalog.
  files: { "references/format.md": VENDO_FORMAT_REFERENCE },
};
