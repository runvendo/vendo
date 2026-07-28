/**
 * Filling the plan (generation pipeline rebuild, Task 7). The brain wrote a
 * plan; skeleton.ts turned it into the app's real layout with a pending
 * placeholder per leaf. This module writes the contents: ONE fast no-think
 * model call per GROUP, running in parallel under a concurrency dial, each
 * fragment spliced into its slot the moment it lands so the app grows on the
 * screen instead of appearing all at once.
 *
 * Three properties are load-bearing:
 *
 * - BLINKERED WORKERS. A worker sees its own group, the queries that group
 *   reads, and the docs for the components its leaves name. Nothing else. That
 *   is why the calls can run at the same time without coordinating, and why
 *   each one is small enough to be fast.
 * - QUERIES FIRST. The plan's read-risk queries run BEFORE any worker, so every
 *   worker writes against real example rows instead of a guessed shape. The
 *   results come back out for the app's first open, so nothing is read twice.
 *   A tool that can change data is never executed here — the plan is a
 *   proposal, and a proposal must not have side effects.
 * - SECTION-SIZED FAILURE. Each fragment is checked on its own (the fact
 *   checks, scoped to the nodes that worker wrote) and gets two fix-it turns.
 *   A section that still cannot be built says so where it stands; the rest of
 *   the app ships.
 *
 * Pure module: injected deps, no I/O beyond the model calls and the query seam.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  applyTextEdits,
  compileWire,
  printWire,
  recompileWithIdentity,
  type AppPlan,
  type PlanGroup,
  type PlanQuery,
  type Tree,
  type TreeQuery,
  type WireCompileResult,
} from "@vendoai/core";
import { createCheckingLayer } from "../checking/layer.js";
import type { Finding } from "../checking/types.js";
import { modelCallParams } from "../model-params.js";
import { readEdits } from "./brain.js";
import { spliceFragment, type Skeleton } from "./skeleton.js";
import { workerFillMessage, workerFixMessage, workerSystemPrompt } from "./prompts/worker.js";
import { wireCompileOptionsFor } from "./wire-options.js";
import { cacheableGenerationMessages, type GeneratedAppDocument, type GenerationDependencies } from "./engine.js";

/** Groups filled at once when the host set no dial. Two, not one, because the
 *  point is parallelism; two, not eight, because every worker is a model call
 *  against the same key and a burst of them is what trips a provider's rate
 *  limit mid-build. */
const DEFAULT_FILL_CONCURRENCY = 2;

/** Fix-it turns a section gets after its first attempt. Two: a fact finding is
 *  almost always fixed by being told exactly what it is, and a third round on
 *  the same section has never been the difference between a good app and a bad
 *  one — it is just the person waiting longer for the same answer. */
const FIX_ROUNDS = 2;

/** What a section that could not be built says, in the person's own terms. It
 *  is a plain sentence and not a raw placeholder ON PURPOSE: a leftover pending
 *  node would keep shimmering forever, and a leftover HOST-catalog leaf would
 *  read to the checks as an unknown prewired component. */
const FILL_FAILED_TEXT = "This section could not be built — retry the edit.";

export interface FillOptions {
  /** Groups filled at the same time (`AppsConfig.fillConcurrency`). */
  concurrency?: number;
  /**
   * Executes one of the plan's queries against the host's tool registry.
   * fillPlan calls this for READ-risk tools only. Absent (no registry wired)
   * means workers fill without example rows — slower to get right, never wrong.
   */
  runQuery?: (query: PlanQuery) => Promise<unknown>;
}

export interface FillResult {
  /** The app: the plan's skeleton with every group's contents written in. */
  document: GeneratedAppDocument;
  /** What is still wrong after the fix-it rounds — one per section that could
   *  not be built, plus any query the plan declared that could not run. Always
   *  `warn`: a missing section is not a reason to withhold the app. */
  findings: Finding[];
  /** What the plan's queries returned, keyed by query id — handed back so the
   *  app's first open reuses the reads instead of repeating them. */
  queryResults: Record<string, unknown>;
}

/** `node "n3"` / `node "n3" prop "rows"` → `n3`; anything else → undefined. */
const NODE_LOCUS = /^node "([^"]+)"/;

/** Run `tasks` with at most `limit` of them in flight, starting in order. */
const withLimit = async (limit: number, tasks: ReadonlyArray<() => Promise<void>>): Promise<void> => {
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) return;
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, lane));
};

/**
 * The plan's queries, executed before anything is built. Read-risk only, all at
 * once: they feed every worker's prompt, so a serial pass here would delay the
 * whole fill.
 */
const runPlanQueries = async (
  plan: AppPlan,
  deps: GenerationDependencies,
  options: FillOptions,
): Promise<{ results: Record<string, unknown>; findings: Finding[] }> => {
  const run = options.runQuery;
  const results: Record<string, unknown> = {};
  const findings: Finding[] = [];
  if (run === undefined) return { results, findings };
  const risk = new Map((deps.tools ?? []).map((tool) => [tool.name, tool.risk]));
  await Promise.all(plan.queries.map(async (query) => {
    if (risk.get(query.tool) !== "read") {
      findings.push({
        severity: "warn",
        where: `query "${query.id}"`,
        message: `names tool "${query.tool}", which is not a read — plan queries run before the app is built, so only reads execute here and this section was written without example rows. A section that has to act on data belongs behind a control the person presses.`,
      });
      return;
    }
    try {
      results[query.id] = await run(query);
    } catch (error) {
      findings.push({
        severity: "warn",
        where: `query "${query.id}"`,
        message: `could not be read while planning (${error instanceof Error ? error.message : "unknown error"}), so its sections were written from the tool's shape alone; the app still reads it live when it opens.`,
      });
    }
  }));
  return { results, findings };
};

/** The plan's `<Query>` declarations, printed in the same dialect the brain
 *  writes them in (printWire owns the input-expression printing), so a
 *  fragment's `{invoices.total}` resolves exactly as it would in a whole app. */
const queryDeclarations = (queries: readonly TreeQuery[]): string => {
  if (queries.length === 0) return "";
  const printed = printWire({
    tree: {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      queries: [...queries],
    },
    components: {},
  }, { includeIds: false });
  // `<App>` first line, `</App>` last: what is between them is the query block.
  return printed.split("\n").slice(1, -1).join("\n");
};

/** A worker's fragment as a compilable document — this exact text is what the
 *  fix-it turn's edits apply to. */
const fragmentDocument = (name: string, queries: readonly TreeQuery[], fragment: string): string => [
  `<App name="${name.replaceAll('"', "'")}">`,
  queryDeclarations(queries),
  fragment,
  "</App>",
].filter((line) => line !== "").join("\n");

const FENCE_LINE = /^[ \t]*```[a-zA-Z]*[ \t]*$/gm;

/** The markup a worker meant to write: fences dropped, and — when it wrapped
 *  its section in a whole `<App>` despite being asked not to — the inside of
 *  that app (the region-parallel lane's own tolerance). */
const fragmentMarkup = (answer: string): string => {
  const text = answer.replace(FENCE_LINE, "").trim();
  const start = text.indexOf("<App");
  if (start === -1) return text;
  const open = text.indexOf(">", start);
  if (open === -1) return text;
  const close = text.lastIndexOf("</App>");
  return (close === -1 ? text.slice(open + 1) : text.slice(open + 1, close)).trim();
};

/** One worker call: the fast, thinking-disabled model instance when the host
 *  configured one, otherwise the main model. Text is accumulated off the stream
 *  — a fragment is small and lands atomically. */
const askWorker = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
): Promise<string | undefined> => {
  const model = deps.paint?.model ?? deps.model;
  try {
    const { streamText } = await import("ai");
    const result = streamText({
      model,
      messages: cacheableGenerationMessages(system, prompt),
      ...modelCallParams(model),
      maxRetries: 0,
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    return text.trim().length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
};

/** The honest stand-in for a section that could not be built. Spliced through
 *  the same seam as a real fragment, so the failed group's placeholders leave
 *  the tree exactly as a successful fill's would. */
const disclaimSlot = (tree: Tree, slotNodeId: string): Tree => spliceFragment(tree, slotNodeId, {
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", source: "prewired", children: ["failed"] },
    { id: "failed", component: "Text", source: "prewired", props: { text: FILL_FAILED_TEXT } },
  ],
});

const groupLocus = (group: PlanGroup, index: number): string =>
  `group "${group.title ?? group.tab ?? `#${index + 1}`}"`;

/**
 * Fill every group of `plan` into `skeleton`, in parallel under the concurrency
 * dial. Returns the finished app, whatever is still wrong with it, and the
 * query results for the app's first open.
 */
export const fillPlan = async (
  plan: AppPlan,
  skeleton: Skeleton,
  deps: GenerationDependencies,
  options: FillOptions = {},
): Promise<FillResult> => {
  const { results: queryResults, findings: queryFindings } = await runPlanQueries(plan, deps, options);
  const findings: Finding[] = [...queryFindings];
  const compileOptions = wireCompileOptionsFor(deps, deps.catalog.map(({ name }) => name));
  const checking = createCheckingLayer({ deps });
  // The slot map is in plan order (skeleton.ts's Skeleton contract), so the
  // worker for plan.groups[i] splices into the i-th slot.
  const slots = Object.values(skeleton.slots);

  let tree = skeleton.tree;
  // The document's `tree` is the open UIPayload the store speaks; a v2 Tree is
  // one, structurally (the same cast the brain makes when it prints an app).
  const document = (of: Tree): GeneratedAppDocument =>
    ({ format: VENDO_APP_FORMAT, name: plan.name, tree: of as unknown as GeneratedAppDocument["tree"] });
  const emitted: Array<Promise<void>> = [];
  /** Commit a splice and show it: the app grows a section at a time. */
  const commit = (next: Tree): void => {
    tree = next;
    if (deps.onPartial === undefined) return;
    emitted.push(Promise.resolve(deps.onPartial({ tree, name: plan.name })).catch(() => undefined));
  };

  /** What is wrong with one candidate fragment: its own compile issues, plus
   *  the fact findings anchored on the nodes THIS worker wrote. Everything else
   *  the checks report belongs to the plan or to another group — a worker that
   *  cannot fix a finding must never be asked to. */
  const problemsWith = async (compiled: WireCompileResult, candidate: Tree, slot: string): Promise<string[]> => {
    const mine = new Set(candidate.nodes
      .map(({ id }) => id)
      .filter((id) => id.startsWith(`${slot}-`)));
    // `request` is the reviewer's input; no fact check reads it, and the
    // reviewer does not run per fragment (it judges the finished app).
    const found = await checking.run({ app: document(candidate), request: plan.name, plan });
    return [
      ...compiled.issues.map((issue) => issue.message),
      ...found
        .filter((finding) => mine.has(NODE_LOCUS.exec(finding.where)?.[1] ?? ""))
        .map((finding) => `${finding.where} ${finding.message}`),
    ];
  };

  const fillGroup = async (index: number): Promise<void> => {
    const group = plan.groups[index] as PlanGroup;
    const slot = slots[index];
    if (slot === undefined) return;
    const system = workerSystemPrompt(deps, group);
    const reads = new Set(group.leaves.flatMap((leaf) => leaf.query === undefined ? [] : [leaf.query]));
    const fillMessage = (problems: readonly string[]): string => workerFillMessage({
      appName: plan.name,
      group,
      queries: plan.queries.filter((query) => reads.has(query.id)),
      samples: Object.fromEntries(Object.entries(queryResults).filter(([id]) => reads.has(id))),
      problems,
    }, deps);

    let problems: string[] = [];
    /** The fragment document as it stands, and the tree it compiled to — the
     *  text a fix-it edit quotes, and the identity a fixed fragment carries. */
    let written: { text: string; tree: Tree } | undefined;
    for (let round = 0; round <= FIX_ROUNDS; round += 1) {
      const answer = await askWorker(deps, system, written === undefined
        ? fillMessage(problems)
        : workerFixMessage(written.text, problems));
      if (answer === undefined) {
        problems = ["the fill worker's model call came back with nothing at all."];
        continue;
      }
      let text: string;
      let compiled: WireCompileResult;
      if (written === undefined) {
        // The PLAN's own declarations, not the tree's: a query some other
        // group's fragment minted while this one was writing is not this
        // worker's business, and reading the growing tree here would make the
        // fragment text depend on which groups happened to land first.
        text = fragmentDocument(plan.name, skeleton.tree.queries ?? [], fragmentMarkup(answer));
        compiled = compileWire(text, compileOptions);
      } else {
        const edits = readEdits(answer);
        if (edits.edits === undefined) {
          problems = edits.issues;
          continue;
        }
        const edited = applyTextEdits(written.text, edits.edits);
        if (edited.text === undefined) {
          problems = [edited.issue as string];
          continue;
        }
        text = edited.text;
        // Identity carry: the nodes the fix did not touch keep the ids the
        // screen already mounted, so a repaired section does not re-mount whole.
        compiled = recompileWithIdentity(text, written.tree, compileOptions);
      }
      const candidate = spliceFragment(tree, slot, compiled.tree);
      problems = await problemsWith(compiled, candidate, slot);
      written = { text, tree: compiled.tree };
      if (problems.length === 0) {
        // Re-splice onto the CURRENT tree: another group may have landed while
        // this one was being checked, and the two slots are disjoint.
        commit(spliceFragment(tree, slot, compiled.tree));
        return;
      }
    }
    commit(disclaimSlot(tree, slot));
    findings.push({
      severity: "warn",
      where: groupLocus(group, index),
      message: `could not be built after ${FIX_ROUNDS} fix-it attempts, so it shows a note asking for a retry instead of made-up content. What was still wrong: ${problems.join("; ")}`,
    });
  };

  await withLimit(
    options.concurrency ?? DEFAULT_FILL_CONCURRENCY,
    plan.groups.map((_, index) => () => fillGroup(index)),
  );
  await Promise.all(emitted);
  return { document: document(tree), findings, queryResults };
};
