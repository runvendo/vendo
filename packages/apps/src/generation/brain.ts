/**
 * The brain: one smart model, one ongoing conversation per app
 * (docs/superpowers/specs/2026-07-28-generation-pipeline-v2-design.md, "The
 * idea"). Every request — a person's words, or a machine's finding used as an
 * instruction — becomes ONE model call whose answer is read into exactly one
 * {@link BrainOutcome}: the finished app for a tiny ask, a plan for a normal
 * one, old/new edits for a small change, a plan amendment for a structural
 * one, or an honest refusal.
 *
 * This module only THINKS. It never fills a plan, applies an edit, or persists
 * anything: the outcome is handed back and the runtime decides what to run
 * (skeleton + fill workers, applyTextEdits, the checking layer). Pure module,
 * injected deps, no I/O beyond the one model call.
 *
 * Why the app text is not in the session: the conversation carries what was
 * SAID (so "no, the other chart" resolves), while the app itself is re-printed
 * fresh — id-free — into every call. Stale markup in a transcript is the one
 * thing that could make the brain edit text that no longer exists.
 */
import {
  VENDO_TREE_FORMAT,
  WIRE_COMPONENT_NAMES,
  compilePlan,
  printWire,
  type AppPlan,
  type PlanCompileResult,
  type PlanFacts,
  type TextEdit,
} from "@vendoai/core";
import { appendSessionTurns } from "../persistence.js";
import { askModel, asTree, type GeneratedAppDocument, type GenerationDependencies } from "./engine.js";
import { brainPrompt } from "./prompts/brain.js";

/** One thing said in an app's conversation. Persisted on the app record
 *  (`session`), capped and server-authoritative — see persistence.ts. */
export interface BrainTurn {
  role: "user" | "brain";
  text: string;
  at: string;
}

/**
 * What the brain decided this turn.
 *
 * - `direct` — the ask was tiny; this IS the app, as wire markup.
 * - `plan` — a fresh app to build: skeleton now, groups filled by workers.
 * - `edits` — old/new replacements over the app's printed text.
 * - `amend` — a structural change, planned as the NEW parts only.
 * - `cannot` — the host cannot do it; these sentences are user-facing verbatim.
 */
export type BrainOutcome =
  | { kind: "direct"; wire: string }
  | { kind: "plan"; plan: AppPlan }
  | { kind: "edits"; edits: TextEdit[] }
  | { kind: "amend"; plan: AppPlan }
  | { kind: "cannot"; reasons: string[] };

/** The app the brain is editing, as much of it as printing needs. */
export type BrainApp = Pick<GeneratedAppDocument, "name" | "tree" | "components">;

export interface BrainInput {
  /** What to answer: the person's own words, or a machine instruction (a
   *  finding to fix) phrased the same way. */
  instruction: string;
  /** The app as it stands. Present = an edit turn; absent = a create turn. */
  app?: BrainApp;
  /** The conversation so far, oldest first (persistence.sessionOf). */
  session?: readonly BrainTurn[];
}

export interface BrainResult {
  /** Absent only when two tries produced nothing readable; `issues` says what
   *  was wrong with what the brain wrote. */
  outcome?: BrainOutcome;
  /** Sentences for the model or a person, never codes: why there is no
   *  outcome, or — beside an outcome — what was dropped on the way to it. */
  issues: string[];
  /** The conversation to persist: on success the incoming session plus this
   *  turn's two sides (capped, oldest dropped); unchanged on failure, because
   *  a turn that produced nothing is not part of the conversation. */
  session: BrainTurn[];
}

/** One retry. A malformed answer is almost always fixed by being shown what
 *  was wrong with it; a second failure is a real failure, and burning more big
 *  model calls on it just costs the person time. */
const BRAIN_ATTEMPTS = 2;

const FENCE_LINE = /^[ \t]*```[a-zA-Z]*[ \t]*$/gm;
const EDIT_BLOCK = /<Edit>([\s\S]*?)<\/Edit>/g;
const EDIT_OLD = /<Old>([\s\S]*?)<\/Old>/;
const EDIT_NEW = /<New>([\s\S]*?)<\/New>/;
const CANNOT_LINE = /<Cannot>([\s\S]*?)<\/Cannot>/g;

/** Everything from the first `<App` through the last `</App>`; undefined when
 *  the markup never closed (a truncated app is a retry, not a document). */
const extractApp = (text: string): string | undefined => {
  const start = text.indexOf("<App");
  const close = text.lastIndexOf("</App>");
  return start === -1 || close < start ? undefined : text.slice(start, close + "</App>".length);
};

/** The `<Edit><Old>…</Old><New>…</New></Edit>` blocks in an answer, or the
 *  sentences saying why none could be read. Shared with the fill workers'
 *  fix-it turn (generation/fill.ts): there is one edit dialect, so there is one
 *  reader for it. */
export const readEdits = (text: string): { edits?: TextEdit[]; issues: string[] } => {
  const edits: TextEdit[] = [];
  const issues: string[] = [];
  for (const [, body] of text.replace(FENCE_LINE, "").matchAll(EDIT_BLOCK)) {
    const old = EDIT_OLD.exec(body ?? "")?.[1]?.trim();
    const replacement = EDIT_NEW.exec(body ?? "")?.[1]?.trim();
    if (old === undefined || old.length === 0 || replacement === undefined) {
      issues.push("an <Edit> needs an <Old> holding the exact text to replace and a <New> holding what replaces it (empty <New> deletes it); that edit was dropped.");
      continue;
    }
    edits.push({ old, new: replacement });
  }
  if (edits.length === 0) {
    issues.push("no edit came through: write each change as <Edit><Old>the exact text as printed</Old><New>what replaces it</New></Edit>.");
    return { issues };
  }
  return { edits, issues };
};

/**
 * The plan's fact list, plus the island the plan itself declares. A leaf may
 * show the island the same plan asked for, and the component fact check only
 * knows the host's names — so the declared island is admitted on a second
 * read rather than reported as an invented component.
 */
const compileWithDeclaredIsland = (text: string, facts: PlanFacts): PlanCompileResult => {
  const first = compilePlan(text, facts);
  const island = first.plan?.island?.name;
  if (island === undefined || facts.components.includes(island)) return first;
  return compilePlan(text, { ...facts, components: [...facts.components, island] });
};

const planFacts = (deps: GenerationDependencies): PlanFacts => ({
  tools: (deps.tools ?? []).map(({ name }) => name),
  components: [...deps.catalog.map(({ name }) => name), ...WIRE_COMPONENT_NAMES],
});

/** Read one answer. The shape decides the outcome: an `<App>` document is the
 *  app itself, a `<Plan>` is a plan (an amendment when an app already exists),
 *  `<Edit>` blocks are text edits, bare `<Cannot>` lines are a refusal. */
const readAnswer = (
  text: string,
  deps: GenerationDependencies,
  hasApp: boolean,
): { outcome?: BrainOutcome; issues: string[] } => {
  const app = extractApp(text);
  if (app !== undefined) return { outcome: { kind: "direct", wire: app }, issues: [] };
  if (text.includes("<Plan")) {
    const { plan, issues } = compileWithDeclaredIsland(text, planFacts(deps));
    if (plan === undefined || issues.length > 0) return { issues };
    // A plan that plans nothing and only refuses IS the refusal.
    if (plan.groups.length === 0) return { outcome: { kind: "cannot", reasons: plan.cannot }, issues: [] };
    return { outcome: { kind: hasApp ? "amend" : "plan", plan }, issues: [] };
  }
  if (text.includes("<Edit")) {
    const { edits, issues } = readEdits(text);
    return edits === undefined ? { issues } : { outcome: { kind: "edits", edits }, issues };
  }
  const reasons = [...text.matchAll(CANNOT_LINE)]
    .map(([, reason]) => (reason ?? "").trim())
    .filter((reason) => reason.length > 0);
  if (reasons.length > 0) return { outcome: { kind: "cannot", reasons }, issues: [] };
  if (text.includes("<App")) {
    return { issues: ["the app markup stopped before </App>, so there was no app to read; write it again whole."] };
  }
  return {
    issues: ["I could not tell what that answer was: write the finished app as <App>…</App>, a plan as <Plan>…</Plan>, a small change as <Edit> blocks, or a refusal as <Cannot> lines — and nothing else."],
  };
};

/**
 * One line describing what the brain did, for the conversation to remember.
 *
 * Deliberately carries no markup: an app's text belongs in exactly one place in
 * a prompt — the fresh print — and a transcript quoting yesterday's elements is
 * how a model comes to edit text that no longer exists.
 */
const summarize = (outcome: BrainOutcome): string => {
  switch (outcome.kind) {
    case "direct":
      return "built the app directly.";
    case "plan":
    case "amend": {
      const { plan } = outcome;
      const parts = [`${outcome.kind === "plan" ? "planned" : "amended"}: ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"}`];
      const tabs = [...new Set(plan.groups.flatMap(({ tab }) => tab === undefined ? [] : [tab]))];
      if (tabs.length > 0) parts.push(`tabs ${tabs.join(", ")}`);
      if (plan.island !== undefined) parts.push(`island ${plan.island.name}`);
      if (plan.server !== undefined) parts.push(`server ${plan.server.kind}${plan.server.schedule === undefined ? "" : ` (${plan.server.schedule})`}`);
      return `${parts.join("; ")}.`;
    }
    case "edits":
      return `edited the app in ${outcome.edits.length} place${outcome.edits.length === 1 ? "" : "s"}.`;
    case "cannot":
      return `said this host cannot: ${outcome.reasons.join(" ")}`;
  }
};

/** The app as the brain sees it: its own markup, printed WITHOUT ids (the
 *  edit surface is text, and ids are the machine's bookkeeping). */
const appText = (app: BrainApp | undefined): string | undefined => {
  if (app?.tree?.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  return printWire({
    tree: asTree(app.tree),
    components: app.components ?? {},
    name: app.name,
  }, { includeIds: false });
};

const transcript = (session: readonly BrainTurn[]): string => session
  .map(({ role, text }) => `${role === "user" ? "THEY SAID" : "YOU SAID"}: ${text}`)
  .join("\n\n");

/** The variable tail of the call: the conversation, the app as it stands, the
 *  instruction, and (on the retry) the answer that did not work. */
const brainMessage = (
  input: BrainInput,
  previous: { answer: string; issues: string[] } | undefined,
): string => {
  const session = input.session ?? [];
  const printed = appText(input.app);
  // ORDER IS DELIBERATE. The app's CURRENT text is the last thing before the
  // instruction, because the last thing read is the thing attended to — and the
  // one mistake that matters here is quoting an <Old> from something stale.
  // Retry feedback goes ABOVE the print for the same reason: the fresh text
  // must stay the nearest thing to the ask.
  return [
    ...(session.length === 0 ? [] : [`THE CONVERSATION SO FAR (what was said, not what the app says):\n${transcript(session)}`]),
    ...(previous === undefined ? [] : [
      `YOUR LAST ANSWER DID NOT WORK:\n${previous.answer}`,
      `WHAT WAS WRONG WITH IT:\n${previous.issues.map((issue) => `- ${issue}`).join("\n")}\nWrite the whole answer again, fixed.`,
    ]),
    ...(printed === undefined ? [] : [`THE APP AS IT STANDS — the only true copy of it, and what an <Old> must quote:\n${printed}`]),
    // Its OWN marker. The transcript above renders past turns as "THEY SAID",
    // so reusing it here would bury the live ask among everything ever asked.
    `THEY ARE ASKING NOW: ${input.instruction}`,
  ].join("\n\n");
};

/**
 * Take one turn of an app's conversation. One model call, up to one retry when
 * the answer could not be read, and the session to persist alongside. Thinking
 * is the model's own configuration — `deps.model` is the thinking model, and
 * the no-think switch is a separate instance the fill workers get.
 */
export const runBrainTurn = async (
  input: BrainInput,
  deps: GenerationDependencies,
): Promise<BrainResult> => {
  const session = [...(input.session ?? [])];
  const system = brainPrompt(deps);
  let issues: string[] = [];
  let previous: { answer: string; issues: string[] } | undefined;
  for (let attempt = 0; attempt < BRAIN_ATTEMPTS; attempt += 1) {
    const answer = await askModel(deps.model, system, brainMessage(input, previous));
    if (answer.text === undefined) {
      // A failed call is not a malformed answer: there is nothing to show the
      // brain on a retry, so the reason stands as the failure.
      return { issues: answer.issues, session };
    }
    const read = readAnswer(answer.text, deps, input.app !== undefined);
    if (read.outcome !== undefined) {
      const at = new Date().toISOString();
      return {
        outcome: read.outcome,
        issues: read.issues,
        session: appendSessionTurns(session, [
          { role: "user", text: input.instruction, at },
          // A SUMMARY, never the markup. Replaying an old <Edit> body would put a
          // second, stale copy of the app's text in the next prompt, and the
          // brain would quote an <Old> from the version that no longer exists.
          // The conversation carries what was SAID; the fresh print is the only
          // app text in any prompt.
          { role: "brain", text: summarize(read.outcome), at },
        ]),
      };
    }
    issues = read.issues;
    previous = { answer: answer.text, issues: read.issues };
  }
  return { issues, session };
};
