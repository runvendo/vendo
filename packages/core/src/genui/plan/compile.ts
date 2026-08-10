/**
 * The plan dialect compiler
 * (docs/superpowers/plans/2026-07-28-generation-pipeline-rebuild.md, "Locked
 * interfaces"): the brain writes a short `<Plan>` document; this reads it into
 * the flat {@link AppPlan} the skeleton and the fill workers work from.
 *
 * The dialect is the wire grammar's little sibling and reuses its tokenizer
 * (scan.ts / attributes.ts / state.ts) and its stance: pure, deterministic,
 * TOTAL — never throws, a malformed part is dropped and reported, a truncated
 * document yields the plan as far as it got (plans stream).
 *
 * Two deliberate differences from the wire compiler:
 *
 * - The shape is flat BY GRAMMAR. `<Plan>` holds `<Query>`, `<Group>`,
 *   `<Server>` and `<Cannot>`; a group holds `<Leaf>` elements and
 *   nothing else. There is no production for a group inside a group, and tabs
 *   are never written — they derive from the groups' tab labels (planTabs).
 * - Issues are sentences, not codes. A plan issue is the WHOLE explanation
 *   handed back to the model (or to a person) on a retry, so it names what was
 *   wrong and what to write instead. Tokenizer issues are drained into the
 *   same list by message, in source order.
 *
 * Fact checks (does the tool exist, does the component exist, can anything
 * fire this schedule, is that query declared) run here against the caller's
 * {@link PlanFacts}. Grammar problems DROP the offending element — there is
 * nothing to keep; fact problems KEEP it and report, so a retry sees exactly
 * what it wrote.
 */

import { Cron } from "croner";
import { safeErrorMessage } from "../../errors.js";
import type { Json } from "../../ids.js";
import { defineOwn, isPlainObject } from "../tree-node.js";
import { QUERY_NAME_PATTERN } from "../tree.js";
import { parseAttributes, type ParsedAttributes } from "../wire/attributes.js";
import { makeState, opensRoot, prescanDeclarations } from "../wire/compile.js";
import { collectText, readName, scanCloseTag, skipCommentOrBraces, skipElement, skipWhitespace } from "../wire/scan.js";
import { FAILED, type CompileState, type Failed } from "../wire/state.js";
import {
  PLAN_DISPLAYS,
  type AppPlan,
  type PlanDisplay,
  type PlanGroup,
  type PlanLeaf,
  type PlanQuery,
  type PlanServer,
} from "./types.js";

/** What the host actually has, for the fact checks. */
export interface PlanFacts {
  tools: readonly string[];
  components: readonly string[];
}

/** `plan` is absent only when there was no `<Plan>` document to read at all;
 *  otherwise it is the plan as far as it parsed, and `issues` says what a
 *  rewrite has to fix. */
export interface PlanCompileResult {
  plan?: AppPlan;
  issues: string[];
}

/** One worker writes one whole group, and five parts is the most a group can
 *  hold together (spec: groups are the coherence unit). */
const PLAN_MAX_GROUP_LEAVES = 5;

/** A leaf's own fields; every other attribute is an arrangement hint
 *  (col/row/span) and rides along in `attrs`. */
const LEAF_FIELDS: ReadonlySet<string> = new Set(["component", "query", "purpose"]);

const PLAN_CLOSE = "</Plan>";
const CANNOT_CLOSE = "</Cannot>";
const NO_NAMES: ReadonlySet<string> = new Set();

/** At most this many host names are listed in one issue — a teaching sentence
 *  stops teaching once it becomes a catalog dump. */
const MAX_LISTED_NAMES = 12;

/** At most this many issues are handed back. The issue list IS the retry
 *  prompt, and a broken document mints a sentence per stray token, so an
 *  uncapped list is an unbounded prompt (the wire compiler caps its own for
 *  the same reason, wire/state.ts). A plan is a short document: nothing a
 *  rewrite can act on lives past the first few dozen sentences. */
const PLAN_MAX_ISSUES = 64;

const nameList = (names: readonly string[]): string => {
  if (names.length === 0) return "none at all";
  const shown = names.slice(0, MAX_LISTED_NAMES).join(", ");
  return names.length <= MAX_LISTED_NAMES ? shown : `${shown}, and ${names.length - MAX_LISTED_NAMES} more`;
};

/** Names a wrong attribute value inside a sentence without dumping it. */
const describe = (value: unknown): string => {
  if (value === undefined) return "nothing";
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object" && value !== null) return "an object";
  return String(value);
};

const EXCERPT_LENGTH = 60;

const excerpt = (text: string): string => {
  const line = text.replace(/\s+/g, " ");
  return line.length <= EXCERPT_LENGTH ? line : `${line.slice(0, EXCERPT_LENGTH)}…`;
};

interface PlanState {
  state: CompileState;
  issues: string[];
  facts: PlanFacts;
  tools: ReadonlySet<string>;
  components: ReadonlySet<string>;
  /** Every grammar-valid `<Query id>` in the document, pre-scanned, so a leaf
   *  may reference a query declared further down. */
  queryIds: ReadonlySet<string>;
}

/** The tokenizer records its own kebab-coded issues on the compile state; the
 *  plan speaks sentences, so they are drained by message in source order. */
const drain = (plan: PlanState): void => {
  for (const entry of plan.state.issues.splice(0)) plan.issues.push(entry.message);
};

/** Reads one open tag's attributes. Every plan element is a `declaration`:
 *  `id`/`name` are the element's own fields and no action compilation runs. */
const openTag = (plan: PlanState): ParsedAttributes | Failed => {
  const attrs = parseAttributes(plan.state, "declaration");
  drain(plan);
  return attrs;
};

const skipContent = (plan: PlanState, tag: string): void => {
  skipElement(plan.state, tag);
  drain(plan);
};

/** A present, non-blank string attribute. */
const stringAttr = (props: Record<string, Json> | undefined, name: string): string | undefined => {
  const value = props?.[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const groupLabel = (group: PlanGroup): string => {
  const label = group.title ?? group.tab;
  return label === undefined ? "an unlabelled group" : `the group "${label}"`;
};

/** A cadence is written the way a person says it ("every Friday morning") —
 *  the automation planner turns it into a trigger. When the model writes a
 *  CRON instead (a bare `*` field is the tell), it is checked with the same
 *  parser the automations engine fires on, under the same 5-field rule, so an
 *  unfireable schedule is caught while the plan can still be rewritten rather
 *  than silently never firing. */
const CRON_SHAPED = /(?:^|\s)\*/;

const scheduleIssue = (schedule: string): string | undefined => {
  if (!CRON_SHAPED.test(schedule)) return undefined;
  const fields = schedule.trim().split(/\s+/).length;
  if (fields !== 5) {
    return `the schedule "${schedule}" reads as a cron but has ${fields} fields instead of 5. Write a 5-field cron ("0 9 * * 5"), or just say the cadence in words ("every Friday morning").`;
  }
  try {
    new Cron(schedule, { timezone: "UTC", paused: true });
  } catch (error) {
    return `no scheduler can read the schedule "${schedule}" (${safeErrorMessage(error)}). Write a 5-field cron ("0 9 * * 5"), or say the cadence in words ("every Friday morning").`;
  }
  return undefined;
};

const compileQuery = (plan: PlanState, appPlan: AppPlan): void => {
  const attrs = openTag(plan);
  if (attrs === FAILED) return;
  if (!attrs.selfClosing) {
    plan.issues.push("<Query> holds nothing — write it as one self-closing element; its content was ignored.");
    skipContent(plan, "Query");
  }
  const id = attrs.props?.id;
  if (typeof id !== "string" || !QUERY_NAME_PATTERN.test(id) || id === "state") {
    plan.issues.push(
      'a <Query> needs an id that is a plain identifier (and never "state") — <Query id="invoices" tool="..."/> — so leaves can point at it. This query was dropped.',
    );
    return;
  }
  if (appPlan.queries.some((query) => query.id === id)) {
    plan.issues.push(`two queries are called "${id}" — give each one its own id. The second was dropped.`);
    return;
  }
  const tool = stringAttr(attrs.props, "tool");
  if (tool === undefined) {
    plan.issues.push(`query "${id}" needs a tool attribute naming the host tool it reads. The query was dropped.`);
    return;
  }
  if (!plan.tools.has(tool)) {
    plan.issues.push(
      `there is no tool called "${tool}". This host's tools are: ${nameList(plan.facts.tools)}. Point query "${id}" at one of those, or say what you cannot do in a <Cannot> line.`,
    );
  }
  const query: PlanQuery = { id, tool, input: {} };
  const input = attrs.props?.input;
  if (input !== undefined) {
    if (isPlainObject(input)) {
      query.input = input;
    } else {
      plan.issues.push(`query "${id}" input must be an object — input={{ limit: 20 }}. The input was dropped.`);
    }
  }
  appPlan.queries.push(query);
};

const compileLeaf = (plan: PlanState, group: PlanGroup): PlanLeaf | undefined => {
  const attrs = openTag(plan);
  if (attrs === FAILED) return undefined;
  if (!attrs.selfClosing) {
    plan.issues.push("<Leaf> holds nothing — write it as one self-closing element; its content was ignored.");
    skipContent(plan, "Leaf");
  }
  const props = attrs.props ?? {};
  const component = stringAttr(props, "component");
  if (component === undefined) {
    plan.issues.push(
      `a leaf in ${groupLabel(group)} says no component — <Leaf component="DataTable" purpose="..."/> — so nothing could show it. The leaf was dropped.`,
    );
    return undefined;
  }
  const purpose = stringAttr(props, "purpose");
  if (purpose === undefined) {
    plan.issues.push(
      `the ${component} leaf in ${groupLabel(group)} needs a purpose saying in one sentence what it shows, because that sentence is all the worker writing it gets. The leaf was dropped.`,
    );
    return undefined;
  }
  if (!plan.components.has(component)) {
    plan.issues.push(
      `there is no component called "${component}". The components you can use are: ${nameList(plan.facts.components)}. Pick the closest fit.`,
    );
  }
  const leaf: PlanLeaf = { component, purpose };
  const query = stringAttr(props, "query");
  if (query !== undefined) {
    leaf.query = query;
    if (!plan.queryIds.has(query)) {
      plan.issues.push(
        `the ${component} leaf reads a query called "${query}", but this plan declares no <Query id="${query}">. Declare it at the top of the plan, or drop the query attribute.`,
      );
    }
  }
  const arrangement: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (LEAF_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      defineOwn(arrangement, key, String(value));
    } else {
      plan.issues.push(
        `the ${component} leaf's "${key}" is an arrangement hint like col="2", and ${describe(value)} cannot be one. It was dropped.`,
      );
    }
  }
  if (Object.keys(arrangement).length > 0) leaf.attrs = arrangement;
  return leaf;
};

/** A group's children: `<Leaf>` elements only. Returns how many leaves the
 *  per-group cap dropped. Exits on `</Group>`, at EOF, or — rewinding so the
 *  enclosing loop still sees it — on `</Plan>`. */
const compileGroupChildren = (plan: PlanState, group: PlanGroup): number => {
  const state = plan.state;
  let dropped = 0;
  for (;;) {
    const loose = collectText(state).trim();
    if (loose.length > 0) {
      plan.issues.push(
        `"${excerpt(loose)}" sits loose inside ${groupLabel(group)}, which holds <Leaf> elements only; it was ignored.`,
      );
    }
    if (state.index >= state.source.length) return dropped;
    const comment = skipCommentOrBraces(state);
    if (comment === "eof") return dropped;
    if (comment === "skipped") continue;
    if (state.source[state.index + 1] === "/") {
      const before = state.index;
      const close = scanCloseTag(state);
      if (close === FAILED) return dropped;
      if (close.name === "Group") return dropped;
      // Only a tag that closes an ANCESTOR proves the </Group> is missing;
      // rewind so the plan loop sees it too. Anything else closes nothing —
      // say that and keep reading, because a mismatched close must never lose
      // the rest of the document (the wire compiler's closeTag, same rule).
      if (close.name !== "Plan") {
        plan.issues.push(`</${close.name}> closes nothing that is open here; it was ignored.`);
        continue;
      }
      state.index = before;
      plan.issues.push(`${groupLabel(group)} was never closed — its </Group> is missing. It was closed for you.`);
      return dropped;
    }
    state.index += 1;
    const tag = readName(state);
    if (tag.length === 0) {
      if (state.index >= state.source.length) return dropped;
      continue;
    }
    if (tag === "Leaf") {
      const leaf = compileLeaf(plan, group);
      if (leaf === undefined) continue;
      if (group.leaves.length >= PLAN_MAX_GROUP_LEAVES) {
        dropped += 1;
        continue;
      }
      group.leaves.push(leaf);
      continue;
    }
    plan.issues.push(
      tag === "Group"
        ? "a group cannot sit inside a group: a plan is two levels deep — groups hold leaves, and tabs come from each group's tab label. The nested group and everything in it was dropped."
        : `<${tag}> means nothing inside a group, which holds <Leaf> elements only. It was dropped.`,
    );
    const attrs = openTag(plan);
    if (attrs === FAILED) return dropped;
    if (!attrs.selfClosing) skipContent(plan, tag);
  }
};

const compileGroup = (plan: PlanState, appPlan: AppPlan): void => {
  const attrs = openTag(plan);
  if (attrs === FAILED) return;
  const group: PlanGroup = { leaves: [] };
  const tab = stringAttr(attrs.props, "tab");
  if (tab !== undefined) group.tab = tab;
  const title = stringAttr(attrs.props, "title");
  if (title !== undefined) group.title = title;
  const layout = attrs.props?.layout;
  if (layout === "stack" || layout === "grid") {
    group.layout = layout;
  } else if (layout !== undefined) {
    plan.issues.push(
      `a group's layout is "stack" or "grid", and ${describe(layout)} is neither — ${groupLabel(group)} was left as a stack.`,
    );
  }
  const waits = attrs.props?.waitsForServer;
  if (waits === true) {
    group.waitsForServer = true;
  } else if (waits !== undefined) {
    plan.issues.push(
      "waitsForServer is a bare flag — write <Group waitsForServer> when a group fills only after the server reports its interface. It was ignored.",
    );
  }
  appPlan.groups.push(group);
  const dropped = attrs.selfClosing ? 0 : compileGroupChildren(plan, group);
  if (dropped > 0) {
    const parts = dropped === 1 ? "part was" : `${dropped} parts were`;
    plan.issues.push(
      `${groupLabel(group)} holds ${PLAN_MAX_GROUP_LEAVES + dropped} parts, and one group holds at most ${PLAN_MAX_GROUP_LEAVES} — one worker writes a whole group, so split this into two groups (they can share a tab label). The last ${parts} dropped.`,
    );
  }
  if (group.leaves.length === 0) {
    plan.issues.push(
      `${groupLabel(group)} has no parts — a group is the handful of parts that tell one story, so give it at least one <Leaf>.`,
    );
  }
};

const compileServer = (plan: PlanState, appPlan: AppPlan): void => {
  const attrs = openTag(plan);
  if (attrs === FAILED) return;
  if (!attrs.selfClosing) {
    plan.issues.push("<Server> holds nothing — write it as one self-closing element; its content was ignored.");
    skipContent(plan, "Server");
  }
  if (appPlan.server !== undefined) {
    plan.issues.push("a plan declares server work once — the second <Server> was dropped.");
    return;
  }
  const kind = attrs.props?.kind;
  if (kind !== "steps" && kind !== "agentic" && kind !== "box") {
    plan.issues.push(
      `<Server> needs kind="steps" (fixed steps on a schedule), kind="agentic" (a judgment call every run) or kind="box" (a backend the sandbox builds), and ${describe(kind)} is none of those. The server work was dropped.`,
    );
    return;
  }
  const why = stringAttr(attrs.props, "why");
  if (why === undefined) {
    plan.issues.push(
      "<Server> needs a why saying in one sentence why this cannot happen in the browser — the escape has to be earned. The server work was dropped.",
    );
    return;
  }
  const server: PlanServer = { kind, why };
  const served = attrs.props?.served;
  if (served === true) {
    if (kind === "box") {
      server.served = true;
    } else {
      plan.issues.push(
        `only kind="box" can serve the app's whole surface (a machine serves it), and this <Server> is kind="${kind}". The served flag was ignored.`,
      );
    }
  } else if (served !== undefined) {
    plan.issues.push(
      "served is a bare flag — write <Server kind=\"box\" served ...> when the machine must serve the whole app surface. It was ignored.",
    );
  }
  const schedule = stringAttr(attrs.props, "schedule");
  if (schedule !== undefined) {
    server.schedule = schedule;
    const bad = scheduleIssue(schedule);
    if (bad !== undefined) plan.issues.push(bad);
  }
  appPlan.server = server;
};

/** `<Cannot>` carries a sentence a person reads, so its text is taken
 *  verbatim to the first `</Cannot>` (the raw-island capture stance). */
const compileCannot = (plan: PlanState, appPlan: AppPlan): void => {
  const state = plan.state;
  const attrs = openTag(plan);
  if (attrs === FAILED) return;
  const close = attrs.selfClosing ? -1 : state.source.indexOf(CANNOT_CLOSE, state.index);
  if (!attrs.selfClosing && close === -1) {
    state.index = state.source.length;
    return;
  }
  const reason = attrs.selfClosing ? "" : state.source.slice(state.index, close).trim();
  if (!attrs.selfClosing) state.index = close + CANNOT_CLOSE.length;
  if (reason.length === 0) {
    plan.issues.push(
      "<Cannot> carries the sentence the person reads — <Cannot>Your host has no way to send email.</Cannot>. The empty one was dropped.",
    );
    return;
  }
  appPlan.cannot.push(reason);
};

const compilePlanChildren = (plan: PlanState, appPlan: AppPlan): void => {
  const state = plan.state;
  for (;;) {
    const loose = collectText(state).trim();
    if (loose.length > 0) {
      plan.issues.push(
        `"${excerpt(loose)}" sits loose inside <Plan>, where only elements mean anything; it was ignored. An explanation belongs in a <Cannot> line or a leaf's purpose.`,
      );
    }
    if (state.index >= state.source.length) break;
    const comment = skipCommentOrBraces(state);
    if (comment === "eof") break;
    if (comment === "skipped") continue;
    if (state.source[state.index + 1] === "/") {
      const close = scanCloseTag(state);
      if (close === FAILED) break;
      if (close.name === "Plan") return;
      plan.issues.push(`</${close.name}> closes nothing that is open here; it was ignored.`);
      continue;
    }
    state.index += 1;
    const tag = readName(state);
    if (tag.length === 0) {
      if (state.index >= state.source.length) break;
      continue;
    }
    if (tag === "Query") {
      compileQuery(plan, appPlan);
      continue;
    }
    if (tag === "Group") {
      compileGroup(plan, appPlan);
      continue;
    }
    if (tag === "Server") {
      compileServer(plan, appPlan);
      continue;
    }
    if (tag === "Cannot") {
      compileCannot(plan, appPlan);
      continue;
    }
    plan.issues.push(
      tag === "Leaf"
        ? "a <Leaf> belongs inside a <Group>, never straight in the plan — the group is what one worker writes. It was dropped."
        : `<${tag}> is not part of a plan, which holds <Query>, <Group> (of <Leaf> elements), <Server> and <Cannot>. It was dropped.`,
    );
    const attrs = openTag(plan);
    if (attrs === FAILED) break;
    if (!attrs.selfClosing) skipContent(plan, tag);
  }
  plan.issues.push("the plan ended before </Plan>, so it was read only as far as it got. Write it again whole.");
};

/** Models wrap output in prose or a markdown fence despite instructions (the
 *  engine's extractWire tolerance): the plan is everything from the first
 *  `<Plan` through the last `</Plan>`, or the tail while it is still open. */
const extractPlan = (text: string): string => {
  const start = text.indexOf("<Plan");
  if (start === -1) return text;
  const close = text.lastIndexOf(PLAN_CLOSE);
  return close === -1 ? text.slice(start) : text.slice(start, close + PLAN_CLOSE.length);
};

const compilePlanUnsafe = (text: string, facts: PlanFacts): PlanCompileResult => {
  const source = extractPlan(text);
  const declared = prescanDeclarations(source, "Plan");
  const state = makeState(source, declared.queryNames, NO_NAMES, NO_NAMES);
  const plan: PlanState = {
    state,
    issues: [],
    facts,
    tools: new Set(facts.tools),
    components: new Set(facts.components),
    queryIds: declared.queryNames,
  };
  skipWhitespace(state);
  if (!opensRoot(state, "Plan")) {
    return { issues: ['I could not find a plan here: a plan is one <Plan name="...">...</Plan> document and nothing else.'] };
  }
  state.index += 5; // consume "<Plan"
  const head = openTag(plan);
  if (head === FAILED) {
    plan.issues.push("the <Plan ...> tag was cut off before it closed, so there was no plan to read.");
    return { issues: plan.issues };
  }
  const name = stringAttr(head.props, "name");
  if (name === undefined) {
    plan.issues.push('the plan needs a name — <Plan name="Invoices workspace"> — because it becomes the app\'s title.');
  }
  const appPlan: AppPlan = { name: name ?? "", queries: [], groups: [], cannot: [] };
  const display = head.props?.display;
  if (typeof display === "string" && (PLAN_DISPLAYS as readonly string[]).includes(display)) {
    appPlan.display = display as PlanDisplay;
  } else if (display !== undefined) {
    plan.issues.push(
      `a plan's display is ${PLAN_DISPLAYS.map((one) => `"${one}"`).join(" or ")}, and ${describe(display)} is neither — this one arrives inline.`,
    );
  }
  if (!head.selfClosing) compilePlanChildren(plan, appPlan);
  const servedByBox = appPlan.server?.kind === "box" && appPlan.server.served === true;
  if (appPlan.groups.length === 0 && appPlan.cannot.length === 0 && !servedByBox) {
    plan.issues.push(
      "this plan says nothing: it needs at least one <Group> of leaves, or a <Cannot> line explaining honestly why the ask cannot be built here.",
    );
  }
  return { plan: appPlan, issues: plan.issues };
};

const capIssues = (issues: string[]): string[] => {
  if (issues.length <= PLAN_MAX_ISSUES) return issues;
  const omitted = issues.length - PLAN_MAX_ISSUES;
  const problems = omitted === 1 ? "1 further problem was" : `${omitted} further problems were`;
  return [
    ...issues.slice(0, PLAN_MAX_ISSUES),
    `${problems} not listed — fix these first and write the plan again.`,
  ];
};

/**
 * Read one `<Plan>` document into an {@link AppPlan}, checking it against what
 * the host actually has. Pure, deterministic and total: never throws — an
 * unexpected failure degrades to a single issue and no plan.
 */
export function compilePlan(text: string, facts: PlanFacts): PlanCompileResult {
  try {
    const result = compilePlanUnsafe(text, facts);
    return { ...result, issues: capIssues(result.issues) };
  } catch (error) {
    return {
      issues: [`the plan could not be read (${safeErrorMessage(error)}); write it again as one <Plan> document.`],
    };
  }
}
