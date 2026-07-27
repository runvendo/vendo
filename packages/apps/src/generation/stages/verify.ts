/**
 * The verification passes — the blind end pass (a no-think read-through of
 * the finished app) and the data-sighted pass (the same read-through with the
 * ACTUAL resolved query values in hand) — plus the patch-guard helpers they
 * share with the rest of the pipeline (endPassViolations, extractEdit,
 * recompile). Both passes are structurally unable to break the app: a patch
 * survives only if it compiles clean, stays copy-only, and re-validates;
 * otherwise the original document ships.
 */
import {
  compileWirePatch,
  printWire,
  isPathBinding,
  isStateBinding,
  type Tree,
} from "@vendoai/core";
import type { GeneratedAppDocument, PipelineContext } from "../engine.js";
import {
  buildRebindSchema,
  deriveRebindSlots,
  NO_VALID_FIX,
  rebindChoices,
  strictToolCall,
} from "./repair.js";
import { modelCallParams } from "../../model-params.js";
import { recompile } from "../wire-options.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// End pass — one no-think read-through emitting 0–4 validated proofread
// patches; priority one is label-vs-binding truth (the lying-label class).
// ---------------------------------------------------------------------------

const END_PASS_CONTRACT = `You are the Vendo end-pass editor: one quick read-through of a finished app against the user's ask. Return ONLY one vendo-genui/v2 <Edit>...</Edit> patch document. No prose, no markdown, no JSON.
PROOFREAD ONLY, AT MOST 4 ops. Priority one — labels must tell the truth about their bindings: a stat, badge, title, or caption claiming "total", "all accounts", "this month", or a specific figure must match what its bound data actually is. When it doesn't, RELABEL to describe the real data (never invent numbers, never rebind) — e.g. a card bound to one checking account labeled "Total balance" becomes <Set id="..." label="Checking balance"/>. Prefer emitting a fix when a label overstates its binding; an unfixed lying label is worse than an extra op. Then: deduplicate repeated titles/stats, retitle so the app answers the ask, drop a redundant node. Never restructure, never add features, never touch queries or islands.
Ops (patch the CURRENT_APP wire against its id="..." anchors):
- <Set id="node-id" attr=.../> merges attributes into the node's props. Set/Unset may touch ONLY copy props (label, title, text, caption, description, subtitle, heading, placeholder, helper, emptyLabel, badgeLabel) with plain string values — touching any other attribute, a binding, or a non-string value drops your whole patch.
- <Unset id="node-id" propName/> removes the named props.
- <Remove id="node-id"/> removes a redundant node and its subtree.
- <SetName name="..."/> renames the app.
If nothing needs polish, emit exactly <Edit></Edit>.`;

/** The contract's "relabel, never rebind, never restructure" was prompt-only
 *  at first: any compiling <Set> (including one that overwrites a live value
 *  or binding with an invented figure) survived. This guard makes the
 *  contract structural. A surviving patch may only rename the app, remove
 *  nodes, and set/unset STRING copy props; anything else — new nodes,
 *  component/island changes, query or data changes, a binding on either side
 *  of a change, a non-copy prop, a non-string value — drops the whole patch
 *  (the original document ships, per the pass's drop-silently invariant). */
const END_PASS_COPY_PROPS = new Set([
  "label", "title", "text", "caption", "description", "subtitle",
  "heading", "placeholder", "helper", "emptyLabel", "badgeLabel",
]);

/** True when `after` only removes entries from `before` (order preserved) —
 *  the shape a <Remove> leaves behind; anything else is a restructure. */
const onlyRemovals = (before: readonly string[], after: readonly string[]): boolean => {
  let cursor = 0;
  for (const id of before) if (after[cursor] === id) cursor += 1;
  return cursor === after.length;
};

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const endPassViolations = (
  base: Tree,
  patched: Tree,
  baseComponents: Record<string, string>,
  patchedComponents: Record<string, string>,
): string[] => {
  const violations: string[] = [];
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  for (const node of patched.nodes) {
    const before = baseNodes.get(node.id);
    if (before === undefined) {
      violations.push(`adds node ${node.id}`);
      continue;
    }
    if (node.component !== before.component) violations.push(`changes component on ${node.id}`);
    if (!onlyRemovals(before.children ?? [], node.children ?? [])) {
      violations.push(`restructures children of ${node.id}`);
    }
    const beforeProps = (before.props ?? {}) as Record<string, unknown>;
    const afterProps = (node.props ?? {}) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)])) {
      const beforeValue = beforeProps[key];
      const afterValue = afterProps[key];
      if (sameJson(beforeValue, afterValue)) continue;
      if (!END_PASS_COPY_PROPS.has(key)) {
        violations.push(`touches non-copy prop "${key}" on ${node.id}`);
        continue;
      }
      if (isPathBinding(beforeValue) || isStateBinding(beforeValue)) {
        violations.push(`unbinds "${key}" on ${node.id}`);
      }
      if (afterValue !== undefined && typeof afterValue !== "string") {
        violations.push(`sets non-string copy "${key}" on ${node.id}`);
      }
    }
  }
  if (!sameJson(base.queries ?? [], patched.queries ?? [])) violations.push("touches queries");
  if (!sameJson(base.data ?? {}, patched.data ?? {})) violations.push("touches data");
  if (!sameJson(baseComponents, patchedComponents)) violations.push("touches islands");
  return violations;
};

/** Same fence tolerance as the engine's extractWire, for <Edit> documents
 *  (shared by the edit dialect and the end pass). */
export const extractEdit = (text: string): string => {
  const start = text.indexOf("<Edit");
  if (start === -1) return text;
  const closeTag = "</Edit>";
  const close = text.lastIndexOf(closeTag);
  return close === -1 ? text.slice(start) : text.slice(start, close + closeTag.length);
};

// recompile moved to ../wire-options.js (it belongs with the compile options
// it applies); re-exported so existing importers keep their path.
export { recompile };

/** The end pass. Runs only under the `endPass` flag (the default flips when
 *  the A/B earns it); a patch survives only if it compiles clean, applies at
 *  most 4 ops, and the patched app re-validates — otherwise the original
 *  document ships untouched. Structurally cannot break the app. */
export const endPass = async (
  document: GeneratedAppDocument,
  userRequest: string,
  context: PipelineContext,
): Promise<GeneratedAppDocument> => {
  if (context.deps.pipeline?.endPass !== true) return document;
  const { deps } = context;
  const endPassStart = Date.now();
  const finish = (polished: GeneratedAppDocument): GeneratedAppDocument => {
    deps.onPipeline?.({ stage: "end-pass", applied: polished !== document, ms: Date.now() - endPassStart });
    return polished;
  };
  try {
    const base = {
      tree: structuredClone(document.tree) as unknown as Tree,
      components: { ...(document.components ?? {}) },
      name: document.name,
    };
    const wire = printWire(base, { includeIds: true });
    // The no-think switch: the paint model is the configured thinking-disabled
    // instance; the read-through never needs reasoning depth.
    const model = deps.paint?.model ?? deps.model;
    const { generateText } = await import("ai");
    const result = await generateText({
      model,
      system: END_PASS_CONTRACT,
      prompt: `USER_ASK: ${userRequest}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${wire}`,
      ...modelCallParams(model),
      maxRetries: 0,
    });
    deps.onTiming?.({ lane: "end-pass", phase: "complete", atMs: Date.now() - context.startedAt, thinking: false });
    const patched = compileWirePatch(extractEdit(result.text), base, {
      hostComponents: [...context.hostComponents],
      ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
    });
    if (!patched.complete || patched.issues.length > 0 || patched.bindingErrors.length > 0) return finish(document);
    if (patched.appliedOps === 0 || patched.appliedOps > 4 || patched.extensionOps.length > 0) return finish(document);
    // Structural proofread guard: the patch may only relabel, remove, and
    // rename — a Set that rebinds or rewrites data drops the whole patch.
    if (endPassViolations(base.tree, patched.tree, base.components, patched.components).length > 0) {
      return finish(document);
    }
    const validated = await context.validate(recompile({
      tree: patched.tree,
      components: patched.components,
      ...(patched.name === undefined ? {} : { name: patched.name }),
    }, context));
    return finish(validated.document ?? document);
  } catch {
    return finish(document);
  }
};

// ---------------------------------------------------------------------------
// Data-sighted verification — the 2026-07-21 gate's lesson (14/21 fails were
// headline lies the model wrote BLIND: queries resolve after generation, so
// labels are claims about values the writer never saw, and the blind end pass
// could not check them either). This pass runs at the runtime seam AFTER
// queries resolve: the model sees the app AND the actual values, and may emit
// the same copy-only, revalidated patch the end pass is limited to.
// ---------------------------------------------------------------------------

const DATA_VERIFY_CONTRACT = `You are the Vendo verification editor. You see a finished app AND the ACTUAL data its queries returned. Compare every label, title, badge text, caption, and the app name against the real values beneath them: a label claiming "total", "all", "this month", "largest", or a specific meaning must be TRUE of the value actually displayed. A raw identifier under a count label, a stale period under a "current" label, a single row's value under an aggregate label — these are lies to fix. Return ONLY one vendo-genui/v2 <Edit>...</Edit> patch document. No prose, no markdown, no JSON.
AT MOST 4 ops, copy-only: <Set id="..." label=.../> (or another string copy prop), <SetName name="..."/>, <Remove id="..."/> for a node whose claim cannot be made true by rewording. RELABEL to describe what the data actually is — never invent numbers, never rebind, never touch queries or islands. If every claim is truthful, emit exactly <Edit></Edit>.`;

/** A trimmed, prompt-safe digest of the resolved query data: arrays capped at
 *  3 sample rows (+count), long strings truncated, whole digest hard-capped.
 *  The verifier needs representative VALUES, not the full payload. */
export const dataDigest = (data: Record<string, unknown>, capBytes = 6000): string => {
  const trimValue = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    if (Array.isArray(value)) {
      const rows = value.slice(0, 3).map((item) => trimValue(item, depth + 1));
      return value.length > 3 ? [...rows, `… (+${value.length - 3} more rows)`] : rows;
    }
    if (isRecord(value) && depth < 6) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, trimValue(child, depth + 1)]));
    }
    return value;
  };
  const digest = JSON.stringify(trimValue(data, 0), null, 1) ?? "{}";
  return digest.length > capBytes ? `${digest.slice(0, capBytes)}\n… (digest truncated)` : digest;
};

/** How many bindings one verify pass may repoint. Deliberately small: a
 *  rebind is surgery, and an app needing more than two is a generation
 *  failure the verify pass must not paper over. */
const REBIND_CAP = 2;

const REBIND_SYSTEM = `You verify Vendo apps against the ACTUAL data their queries returned. For each listed binding, keep it (answer ${NO_VALID_FIX}) unless the resolved value contradicts the node's label or the user's ask — a label claiming "total", "all accounts", or "this week" bound to a single row's value, a swapped series, a wrong-category field. Then choose the field path whose value makes the claim true. Every answer comes from that binding's enum; there is no other fix.`;

/** The rebind arm of the data-sighted verify (pipeline.rebind, default OFF).
 *  Re-gate 2026-07-26: wrong-data-binding is the top model-error class in
 *  every arm, and the copy-only pass — which ran on every B/C create and
 *  applied 15 patches — caught NONE of them: a relabel can make a lying
 *  label honest but cannot point a binding at the right field.
 *
 *  Built from structured repair's parts: ONE strict tool call over the
 *  closed fix space (deriveRebindSlots/buildRebindSchema — enums of real,
 *  kind-compatible field paths plus the keep arm). NO free-text binding edit
 *  exists on this path: the model only picks enum values, the splice is
 *  deterministic, and the rebound tree recompiles and re-validates in full.
 *  Any failure — a failed call, an out-of-enum answer (the whole patch
 *  drops, never clamps), more than REBIND_CAP rebinds, a validation miss —
 *  returns undefined and the incoming document ships unchanged. */
const rebindPass = async (
  document: GeneratedAppDocument,
  userRequest: string,
  resolvedData: Record<string, unknown>,
  context: PipelineContext,
): Promise<{ document: GeneratedAppDocument; rebinds: number } | undefined> => {
  const { deps } = context;
  const base = {
    tree: structuredClone(document.tree) as unknown as Tree,
    components: { ...(document.components ?? {}) },
    name: document.name,
  };
  const slots = deriveRebindSlots(base.tree, deps, resolvedData);
  if (slots.length === 0) return undefined;
  const wire = printWire(base, { includeIds: true });
  const chosen = await strictToolCall(
    deps,
    "rebind_bindings",
    "For each listed binding choose the correct field path from its closed enum, or the no-valid-fix arm to keep the current binding.",
    buildRebindSchema(slots),
    REBIND_SYSTEM,
    `USER_ASK: ${userRequest}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${wire}\nACTUAL data the queries returned (trimmed sample; top-level keys are query names — a field path /query/field points into that query's value):\n${dataDigest(resolvedData)}`,
  );
  if (chosen === undefined) return undefined;
  const picks = rebindChoices(slots, chosen);
  if (picks === undefined || picks.length === 0 || picks.length > REBIND_CAP) return undefined;
  const nodes = new Map(base.tree.nodes.map((node) => [node.id, node]));
  for (const pick of picks) {
    const bound = nodes.get(pick.nodeId)?.props?.[pick.prop];
    if (!isPathBinding(bound) || bound.$path !== pick.from) return undefined;
    // Only $path moves; $reshape and friends ride along unchanged (the kind
    // filter kept the delivered kind, so the reshape still applies).
    (bound as { $path: string }).$path = pick.to;
  }
  const validated = await context.validate(recompile(base, context));
  if (validated.document === undefined) return undefined;
  return { document: validated.document, rebinds: picks.length };
};

/** The data-sighted verification pass. Same survival gauntlet as the end
 *  pass — compile clean, ≤4 ops, copy-only structural guard, full
 *  revalidation — so it structurally cannot break the app; the only new
 *  input is the resolved data digest. Under `pipeline.rebind` the strict
 *  rebind arm runs FIRST (see rebindPass) so the copy pass then relabels
 *  against the corrected bindings; the resolved data stays valid either way
 *  because neither arm may touch queries. The caller owns the flag decision. */
export const dataSightedVerify = async (
  document: GeneratedAppDocument,
  userRequest: string,
  resolvedData: Record<string, unknown>,
  context: PipelineContext,
): Promise<GeneratedAppDocument> => {
  const { deps } = context;
  const startedAtMs = Date.now();
  let relabels = 0;
  let rebinds = 0;
  let working = document;
  const finish = (verified: GeneratedAppDocument): GeneratedAppDocument => {
    deps.onPipeline?.({ stage: "data-verify", applied: verified !== document, relabels, rebinds, ms: Date.now() - startedAtMs });
    return verified;
  };
  try {
    if (deps.pipeline?.rebind === true) {
      const rebound = await rebindPass(document, userRequest, resolvedData, context);
      if (rebound !== undefined) {
        working = rebound.document;
        rebinds = rebound.rebinds;
      }
    }
    const base = {
      tree: structuredClone(working.tree) as unknown as Tree,
      components: { ...(working.components ?? {}) },
      name: working.name,
    };
    const wire = printWire(base, { includeIds: true });
    const model = deps.paint?.model ?? deps.model;
    const { generateText } = await import("ai");
    const result = await generateText({
      model,
      system: DATA_VERIFY_CONTRACT,
      prompt: `USER_ASK: ${userRequest}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${wire}\nACTUAL data the queries returned (trimmed sample):\n${dataDigest(resolvedData)}`,
      ...modelCallParams(model),
      maxRetries: 0,
    });
    const patched = compileWirePatch(extractEdit(result.text), base, {
      hostComponents: [...context.hostComponents],
      ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
    });
    if (!patched.complete || patched.issues.length > 0 || patched.bindingErrors.length > 0) return finish(working);
    if (patched.appliedOps === 0 || patched.appliedOps > 4 || patched.extensionOps.length > 0) return finish(working);
    if (endPassViolations(base.tree, patched.tree, base.components, patched.components).length > 0) {
      return finish(working);
    }
    const validated = await context.validate(recompile({
      tree: patched.tree,
      components: patched.components,
      ...(patched.name === undefined ? {} : { name: patched.name }),
    }, context));
    if (validated.document === undefined) return finish(working);
    relabels = patched.appliedOps;
    return finish(validated.document);
  } catch {
    return finish(working);
  }
};
