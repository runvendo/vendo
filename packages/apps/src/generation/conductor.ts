/**
 * The conductor: one create, one edit, start to finish.
 *
 * The brain takes ONE turn, and what it answers decides everything after it.
 * A tiny ask comes back finished — compile it and check it. A normal ask comes
 * back as a plan — turn it into the real layout at once, then let fast workers
 * write its groups in parallel. An existing app comes back as edits over its
 * own printed text, or as a plan for the parts that are new. An impossible ask
 * comes back as sentences the person reads instead of an app.
 *
 * Whatever the checking layer still finds is handed BACK to the brain as an
 * instruction, twice; after that the app is returned with what is left stated
 * plainly. Nothing here throws a finding — but nothing here commits either: a
 * `block` that survives these rounds stops the write at the runtime's commit
 * path, which is the one place that can refuse without losing the answer.
 *
 * Nothing here persists, paints, or provisions. The runtime owns the store, the
 * screen, and the sandbox — this module owns the ORDER, which is why the bench
 * lane can drive a whole generation without a store behind it.
 */
import {
  applyTextEdits,
  compileWire,
  printWire,
  recompileWithIdentity,
  type AppDocument,
  type AppPlan,
  type PlanQuery,
  type TextEdit,
  type Tree,
} from "@vendoai/core";
import { createCheckingLayer, judgmentRules } from "../checking/layer.js";
import { reviewerCheck } from "../checking/reviewer.js";
import type { Check, CheckingLayer, Finding } from "../checking/types.js";
import { runBrainTurn, type BrainOutcome, type BrainTurn } from "./brain.js";
import { UNSTORED_APP_ID, asPayload, asTree, type GeneratedAppDocument, type GenerationDependencies } from "./engine.js";
import { fillPlan, type FillOptions } from "./fill.js";
import { runIslandLane } from "./lanes.js";
import { growSkeleton, skeletonFromPlan, type Skeleton } from "./skeleton.js";
import { documentFromEdit, validateCompiledCreate } from "./validation/validate.js";
import { wireCompileOptionsFor } from "./wire-options.js";

/**
 * Fix-it turns one app gets after the checking layer blocks it. Two, for the
 * brain's own reason: a finding is a teaching sentence, and being shown exactly
 * what is wrong fixes it on the first or second try or not at all — a third
 * round has never been the difference between a good app and a bad one, it is
 * just the person waiting longer for the same answer.
 */
const FIX_ROUNDS = 2;

export interface ConductorOptions {
  /** Executes one of the plan's queries against the host's tool registry.
   *  READ-risk tools only — the plan is a proposal, and a proposal must not
   *  have side effects. Absent → workers fill without example rows. */
  runQuery?: FillOptions["runQuery"];
  /** Groups filled at the same time (`AppsConfig.fillConcurrency`). */
  fillConcurrency?: number;
  /** The host's own checks (`AppsConfig.checks`), APPENDED to the built-in fact
   *  checks and the reviewer — a host adds findings, never removes one. */
  checks?: readonly Check[];
}

/** A generation that produced an app, whatever is still wrong with it. */
export interface ConductedApp {
  kind: "app";
  document: GeneratedAppDocument;
  /** The plan it was built from; absent when the brain wrote the app directly. */
  plan?: AppPlan;
  /** The skeleton's slot map, so a later pass (the groups that waited on the
   *  box) can fill into the same containers. Absent on the direct path. */
  skeleton?: Skeleton;
  /** What the plan's queries returned — handed back so the app's first open
   *  reuses the reads instead of repeating them. */
  queryResults: Record<string, unknown>;
  /** What the checking layer still reports after the fix-it rounds. */
  findings: Finding[];
  session: BrainTurn[];
}

/** The host cannot do it. These sentences are user-facing verbatim. */
export interface ConductedRefusal {
  kind: "cannot";
  reasons: string[];
  session: BrainTurn[];
}

/** Nothing readable came back. `issues` says what was wrong with what did. */
export interface ConductedFailure {
  kind: "failure";
  issues: string[];
  session: BrainTurn[];
}

export type ConductedResult = ConductedApp | ConductedRefusal | ConductedFailure;

const hostComponentNames = (deps: GenerationDependencies): string[] =>
  deps.catalog.map(({ name }) => name);

const compileOptionsFor = (deps: GenerationDependencies): Parameters<typeof compileWire>[1] =>
  wireCompileOptionsFor(deps, hostComponentNames(deps));

/** The checking layer for ONE generation run: the built-in fact checks, the AI
 *  reviewer bound to the data this app's queries actually returned, and the
 *  host's own checks. The reviewer's samples are bound at CONSTRUCTION because
 *  they belong to the run, not to a document. */
const checkingFor = (
  deps: GenerationDependencies,
  samples: Readonly<Record<string, unknown>>,
  checks: readonly Check[] | undefined,
): CheckingLayer => {
  const plugged = checks ?? [];
  // The judgment rules the host and every pack contributed are not code — they
  // are lines on the reviewer's rubric, and the reviewer is the only thing that
  // can apply them. Derived once, by the same function the layer exposes them
  // with, so the rubric the reviewer reads and `layer.rubric` can never diverge.
  return createCheckingLayer({
    deps,
    checks: [reviewerCheck(deps, samples, judgmentRules(plugged)), ...plugged],
  });
};

const withId = (document: GeneratedAppDocument): AppDocument =>
  ({ ...document, id: UNSTORED_APP_ID } as AppDocument);

const withoutId = (document: AppDocument): GeneratedAppDocument => {
  const { id: _id, ...rest } = document;
  return rest;
};

/** One finished-app answer as a document: compiled in the production dialect and
 *  put through the ONE create validator. */
const documentFromWire = async (
  wire: string,
  deps: GenerationDependencies,
  request: string,
): Promise<{ document?: GeneratedAppDocument; issues: string[] }> =>
  validateCompiledCreate(compileWire(wire, compileOptionsFor(deps)), deps, request);

/**
 * Apply the brain's old/new edits to an app's printed text. Identity is carried
 * from the previous tree by edit span (text-edit.ts), so every node the change
 * did not touch keeps the id the screen already mounted — a small edit repaints
 * a prop, it never re-mounts the app.
 */
export const applyBrainEdits = async (
  previous: AppDocument,
  edits: readonly TextEdit[],
  deps: GenerationDependencies,
  instruction: string,
): Promise<{ document?: AppDocument; issues: string[] }> => {
  if (previous.tree === undefined) return { issues: ["this app has no tree to edit."] };
  const tree = asTree(previous.tree);
  const printed = printWire({
    tree,
    components: previous.components ?? {},
    name: previous.name,
  }, { includeIds: false });
  const edited = applyTextEdits(printed, [...edits]);
  if (edited.text === undefined) return { issues: [edited.issue as string] };
  return documentFromEdit(
    previous,
    recompileWithIdentity(edited.text, tree, compileOptionsFor(deps)),
    deps,
    instruction,
  );
};

/** What the brain is told to fix. A finding is already a teaching sentence, so
 *  the instruction is the findings themselves — nothing is translated. */
const fixInstruction = (findings: readonly Finding[]): string => [
  "These things are wrong with the app as it stands. Fix each one with an <Edit> over the app text printed above, and change nothing else.",
  ...findings.map(({ where, message }) => (where === undefined ? `- ${message}` : `- ${where}: ${message}`)),
].join("\n");

/**
 * Run the checking layer and hand every BLOCKING finding back to the brain as
 * an instruction, up to {@link FIX_ROUNDS} times. Whatever survives is returned
 * beside the app: a warn rides along, and a block the brain could not fix is
 * returned intact so the commit path can refuse it.
 */
const checkAndFix = async (
  input: {
    document: AppDocument;
    request: string;
    plan?: AppPlan;
    session: BrainTurn[];
  },
  deps: GenerationDependencies,
  checking: CheckingLayer,
  options: ConductorOptions,
): Promise<{ document: AppDocument; findings: Finding[]; session: BrainTurn[] }> => {
  let document = input.document;
  let session = input.session;
  let plan = input.plan;
  for (let round = 0; ; round += 1) {
    const findings = await checking.run({
      document,
      request: input.request,
      ...(plan === undefined ? {} : { plan }),
    });
    const blocking = findings.filter(({ severity }) => severity === "block");
    if (blocking.length === 0 || round >= FIX_ROUNDS) return { document, findings, session };
    const turn = await runBrainTurn({
      instruction: fixInstruction(blocking),
      app: { name: document.name, tree: document.tree, ...(document.components === undefined ? {} : { components: document.components }) },
      session,
    }, deps);
    session = turn.session;
    const outcome = turn.outcome;
    if (outcome?.kind === "edits") {
      const revised = await applyBrainEdits(document, outcome.edits, deps, input.request);
      if (revised.document === undefined) return { document, findings, session };
      document = revised.document;
      continue;
    }
    // A finding the app's TEXT cannot answer: "you never built the Friday
    // reminder" is fixed by planning the reminder, not by editing a label. The
    // brain answers with an amendment and the app grows a part it was missing —
    // which is why reviewer findings come here, to the brain, and not to a group
    // worker who can only rewrite its own section.
    if (outcome?.kind === "amend") {
      if (document.tree === undefined) return { document, findings, session };
      const grown = await growAndFill({
        plan: outcome.plan,
        skeleton: growSkeleton(asTree(document.tree), outcome.plan),
        request: input.request,
      }, deps, options);
      document = { ...document, ...grown.document, id: document.id } as AppDocument;
      // The amendment's own server declaration is what the runtime reads to arm
      // an automation, so it has to replace the plan the checks are measuring.
      plan = outcome.plan;
      continue;
    }
    // Anything else means the brain would not or could not fix it. Stop and
    // report: another round would ask the same question.
    return { document, findings, session };
  }
};

/** Stamp `source: "generated"` on every node showing a generated component. The
 *  skeleton stamps its placeholders `prewired` (it cannot know), and a fill
 *  fragment compiles alone with no island declaration in scope, so this is the
 *  one place the tree learns which of its nodes is an island. */
const stampGenerated = (tree: Tree, names: ReadonlySet<string>): Tree => names.size === 0 ? tree : {
  ...tree,
  nodes: tree.nodes.map((node) => names.has(node.component) ? { ...node, source: "generated" as const } : node),
};

const treeOfDocument = (document: GeneratedAppDocument): Tree => asTree(document.tree);

/** The groups a worker can write NOW: everything the plan did not mark as
 *  waiting on the box's interface. A waiting group binds to code nobody has
 *  written yet, so filling it here would be the app promising a shape. */
const readyGroups = (plan: AppPlan): number[] =>
  plan.groups.flatMap((group, index) => group.waitsForServer === true ? [] : [index]);

/**
 * Turn a plan's groups into real contents: the island the plan asked for, then
 * one fast worker per group. Mechanical — it runs no checks and takes no brain
 * turn, so the fix loop can reuse it when the brain answers a finding with an
 * amendment rather than an edit.
 */
const growAndFill = async (
  input: { plan: AppPlan; skeleton: Skeleton; request: string },
  deps: GenerationDependencies,
  options: ConductorOptions,
): Promise<{ document: GeneratedAppDocument; findings: Finding[]; queryResults: Record<string, unknown> }> => {
  const { plan, skeleton } = input;
  // The plan IS the layout: it reaches the screen before a single group has
  // been written, so the person sees the app's real geometry filling in.
  await Promise.resolve(deps.onPartial?.({ tree: skeleton.tree, name: plan.name })).catch(() => undefined);

  // The island comes FIRST when the plan asked for one: a group whose leaf
  // shows the island has to compile against a component that exists, and only
  // the island lane can make it exist. It is the rare escape, so the serial
  // call it costs is paid by the rare app, never the ordinary one.
  const islandLane = plan.island === undefined
    ? { components: {} as Record<string, string>, componentTools: {} as Record<string, string[]>, findings: [] as Finding[] }
    : await (async () => {
      const lane = await runIslandLane(plan, {
        format: "vendo/app@1",
        name: plan.name,
        ui: "tree",
        tree: asPayload(skeleton.tree),
      }, { ...deps, request: input.request });
      return {
        components: lane.document.components ?? {},
        componentTools: lane.document.componentTools ?? {},
        findings: lane.findings,
      };
    })();

  const filled = await fillPlan(plan, skeleton, deps, {
    groups: readyGroups(plan),
    ...(Object.keys(islandLane.components).length === 0 ? {} : { components: islandLane.components }),
    ...(options.fillConcurrency === undefined ? {} : { concurrency: options.fillConcurrency }),
    ...(options.runQuery === undefined ? {} : { runQuery: options.runQuery }),
  });

  const generatedNames = new Set(Object.keys(islandLane.components));
  const document: GeneratedAppDocument = {
    ...filled.document,
    tree: asPayload(stampGenerated(treeOfDocument(filled.document), generatedNames)),
    ...(generatedNames.size === 0 ? {} : {
      components: islandLane.components,
      componentTools: islandLane.componentTools,
    }),
  };

  return {
    document,
    findings: [...islandLane.findings, ...filled.findings],
    queryResults: filled.queryResults,
  };
};

/** Build a plan's groups, then put the finished app through the checks. */
const buildPlan = async (
  input: { plan: AppPlan; skeleton: Skeleton; request: string; session: BrainTurn[] },
  deps: GenerationDependencies,
  options: ConductorOptions,
): Promise<ConductedApp> => {
  const built = await growAndFill(input, deps, options);
  const checked = await checkAndFix({
    document: withId(built.document),
    request: input.request,
    plan: input.plan,
    session: input.session,
  }, deps, checkingFor(deps, built.queryResults, options.checks), options);
  return {
    kind: "app",
    document: withoutId(checked.document),
    plan: input.plan,
    skeleton: { tree: treeOfDocument(withoutId(checked.document)), slots: input.skeleton.slots },
    queryResults: built.queryResults,
    findings: [...built.findings, ...checked.findings],
    session: checked.session,
  };
};

/**
 * Create an app from a person's words. One brain turn decides whether it is
 * written on the spot, planned and filled, or honestly refused.
 */
export const conductCreate = async (
  input: { prompt: string },
  deps: GenerationDependencies,
  options: ConductorOptions = {},
): Promise<ConductedResult> => {
  const turn = await runBrainTurn({ instruction: input.prompt }, deps);
  if (turn.outcome === undefined) return { kind: "failure", issues: turn.issues, session: turn.session };
  const outcome: BrainOutcome = turn.outcome;
  if (outcome.kind === "cannot") {
    return { kind: "cannot", reasons: outcome.reasons, session: turn.session };
  }
  if (outcome.kind === "direct") {
    const built = await documentFromWire(outcome.wire, deps, input.prompt);
    if (built.document === undefined) {
      return { kind: "failure", issues: [...turn.issues, ...built.issues], session: turn.session };
    }
    const checked = await checkAndFix({
      document: withId(built.document),
      request: input.prompt,
      session: turn.session,
    }, deps, checkingFor(deps, {}, options.checks), options);
    return {
      kind: "app",
      document: withoutId(checked.document),
      queryResults: {},
      findings: checked.findings,
      session: checked.session,
    };
  }
  // A create turn has no app, so the brain answers `plan`, never `amend`.
  if (outcome.kind !== "plan") {
    return {
      kind: "failure",
      issues: [...turn.issues, "the brain answered with edits for an app that does not exist yet."],
      session: turn.session,
    };
  }
  return buildPlan({
    plan: outcome.plan,
    skeleton: skeletonFromPlan(outcome.plan),
    request: input.prompt,
    session: turn.session,
  }, deps, options);
};

/**
 * Change an existing app. Same brain, same conversation — it remembers the plan
 * and every turn, so "no, the other chart" resolves. A small ask comes back as
 * edits over the app's own text; a structural one as a plan for the NEW parts,
 * which grows the skeleton and fills only what it added.
 */
export const conductEdit = async (
  input: { app: AppDocument; instruction: string; session?: readonly BrainTurn[] },
  deps: GenerationDependencies,
  options: ConductorOptions = {},
): Promise<ConductedResult> => {
  const previous = input.app;
  const turn = await runBrainTurn({
    instruction: input.instruction,
    app: { name: previous.name, tree: previous.tree, ...(previous.components === undefined ? {} : { components: previous.components }) },
    ...(input.session === undefined ? {} : { session: input.session }),
  }, deps);
  if (turn.outcome === undefined) return { kind: "failure", issues: turn.issues, session: turn.session };
  const outcome: BrainOutcome = turn.outcome;
  if (outcome.kind === "cannot") {
    return { kind: "cannot", reasons: outcome.reasons, session: turn.session };
  }

  const finish = async (
    document: AppDocument,
    session: BrainTurn[],
  ): Promise<ConductedResult> => {
    const checked = await checkAndFix({
      document,
      request: input.instruction,
      session,
    }, deps, checkingFor(deps, {}, options.checks), options);
    return {
      kind: "app",
      document: withoutId(checked.document),
      queryResults: {},
      findings: checked.findings,
      session: checked.session,
    };
  };

  if (outcome.kind === "edits") {
    const applied = await applyBrainEdits(previous, outcome.edits, deps, input.instruction);
    if (applied.document === undefined) {
      return { kind: "failure", issues: [...turn.issues, ...applied.issues], session: turn.session };
    }
    return finish(applied.document, turn.session);
  }

  if (outcome.kind === "direct") {
    // The brain rewrote the whole app rather than editing it — legitimate for a
    // small app, and the document's own history still survives the swap.
    const compiled = compileWire(outcome.wire, compileOptionsFor(deps));
    const built = await documentFromEdit(previous, compiled, deps, input.instruction);
    if (built.document === undefined) {
      return { kind: "failure", issues: [...turn.issues, ...built.issues], session: turn.session };
    }
    return finish(built.document, turn.session);
  }

  // `amend` — the plan holds the NEW parts only. The skeleton GROWS (existing
  // ids untouched, so nothing on the screen re-mounts) and only the added
  // groups are written.
  const plan = outcome.plan;
  if (previous.tree === undefined) {
    return { kind: "failure", issues: ["this app has no tree to amend."], session: turn.session };
  }
  const grown = growSkeleton(asTree(previous.tree), plan);
  const built = await buildPlan({
    plan,
    skeleton: grown,
    request: input.instruction,
    session: turn.session,
  }, deps, options);
  if (built.kind !== "app") return built;
  // The amendment's document is the grown tree; everything else about the app —
  // its name, its trigger, its machine, its pins — is the stored app's.
  return {
    ...built,
    document: {
      ...structuredClone(previous),
      name: previous.name,
      tree: built.document.tree,
      ...(built.document.components === undefined ? {} : { components: built.document.components }),
      ...(built.document.componentTools === undefined ? {} : { componentTools: built.document.componentTools }),
    } as GeneratedAppDocument,
  };
};

/**
 * Fill the groups that waited on the box, now that it has reported what it
 * actually serves. Every function the box named travels with a real sample of
 * its output, so these groups bind against truth instead of a signature nobody
 * has implemented.
 */
export const fillAfterServer = async (
  input: {
    plan: AppPlan;
    skeleton: Skeleton;
    document: GeneratedAppDocument;
    /** The interface the box reported: one entry per function, with a real
     *  sample of its output when one could be taken. */
    functions: ReadonlyArray<{ name: string; sampleOutput?: unknown }>;
    request: string;
  },
  deps: GenerationDependencies,
  options: ConductorOptions = {},
): Promise<{ document: GeneratedAppDocument; findings: Finding[] }> => {
  const waiting = input.plan.groups
    .flatMap((group, index) => group.waitsForServer === true ? [index] : []);
  if (waiting.length === 0 || input.functions.length === 0) {
    return { document: input.document, findings: [] };
  }
  const queries: PlanQuery[] = input.functions.map(({ name }) => ({
    id: name,
    tool: `fn:${name}`,
    input: {},
  }));
  const samples = Object.fromEntries(
    input.functions.flatMap(({ name, sampleOutput }) =>
      sampleOutput === undefined ? [] : [[name, sampleOutput] as const]),
  );
  // The fn: declarations join the tree so the waiting groups' bindings resolve
  // exactly as a host query's would.
  const tree = treeOfDocument(input.document);
  const declared = new Set((tree.queries ?? []).map(({ name }) => name));
  const filled = await fillPlan(input.plan, {
    tree: {
      ...tree,
      queries: [
        ...(tree.queries ?? []),
        ...queries.filter(({ id }) => !declared.has(id)).map(({ id, tool, input: args }) => ({
          name: id,
          tool,
          input: args as Record<string, never>,
        })),
      ],
    },
    slots: input.skeleton.slots,
  }, deps, {
    groups: waiting,
    serverInterface: { queries, samples },
    ...(options.fillConcurrency === undefined ? {} : { concurrency: options.fillConcurrency }),
  });
  return { document: filled.document, findings: filled.findings };
};
