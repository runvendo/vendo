/**
 * Structured repair — one strict tool-use call over the closed fix space:
 * compile errors the compiler localizes with an enumerable set of legal
 * fixes are fixed by choosing from that set, spliced deterministically into
 * the canonical tree, re-printed, re-compiled and re-validated. Anything
 * outside the closed space falls back to the free-form regeneration loop.
 */
import {
  printWireV2,
  isPathBinding,
  isStateBinding,
  shapeAtPointer,
  type ShapeType,
  type TreeNode,
  type TreeV2,
  type WireCompileResult,
} from "@vendoai/core";
import type {
  GeneratedAppDocument,
  GenerationDependencies,
  PipelineContext,
} from "../engine.js";
import { actionBindingsInProps, actionFaults, hasPayload } from "../validation/actions.js";
import { literalDataFaults } from "../validation/literals.js";
import { DISCLAIMER_TEXT } from "../validation/validate.js";
import { recompile } from "../wire-options.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const NO_VALID_FIX = "__no_valid_fix__";
const OMIT_FIELD = "__omit__";
const MAX_PATH_OPTIONS = 60;
const MAX_PATH_DEPTH = 4;

/** Every legal binding path into a tool's response shape, query-name-prefixed
 *  (JSON-Pointer form, numeric `0` for array elements), bounded so the strict
 *  schema stays small. Includes non-leaf paths — binding a whole array/object
 *  (rows, slices) is legal. */
const enumerateShapePaths = (shape: ShapeType, prefix: string): string[] => {
  const out: string[] = [];
  const walk = (current: ShapeType, path: string, depth: number): void => {
    if (out.length >= MAX_PATH_OPTIONS) return;
    out.push(path);
    if (depth >= MAX_PATH_DEPTH) return;
    if (current.kind === "object") {
      for (const [field, child] of Object.entries(current.fields)) {
        walk(child, `${path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`, depth + 1);
      }
    } else if (current.kind === "array") {
      walk(current.items, `${path}/0`, depth + 1);
    }
  };
  walk(shape, prefix, 0);
  return out;
};

const kindMatchesSchemaType = (kind: ShapeType["kind"], type: string): boolean => {
  if (kind === "json") return true;
  if (type === "array") return kind === "array";
  if (type === "number" || type === "integer") return kind === "number";
  if (type === "string") return kind === "string";
  if (type === "boolean") return kind === "boolean";
  if (type === "object") return kind === "object";
  return true;
};

interface BindingFix {
  kind: "binding";
  nodeId: string;
  prop: string;
  path: string;
  query: string;
  tool: string;
  options: string[];
  requiredProp: boolean;
  message: string;
}

interface QueryToolFix {
  kind: "query-tool";
  query: string;
  tool: string;
  options: string[];
}

interface ActionDisclaimFix {
  kind: "action-disclaim";
  nodeId: string;
  reason: string;
}

interface ActionPayloadFix {
  kind: "action-payload";
  nodeId: string;
  prop: string;
  action: string;
  fields: string[];
  requiredFields: string[];
  options: string[];
  /** Law 2 — true when an EXISTING (ungrounded) payload is replaced whole
   *  rather than a missing one filled. */
  replace?: boolean;
}

/** Law 2 — an action naming a tool absent from the registry: pick the real
 *  tool, or no-valid-fix → honest disclaimer. */
interface ActionToolFix {
  kind: "action-tool";
  nodeId: string;
  prop: string;
  action: string;
  options: string[];
}

/** Law 1 — a literal on a data-classed prop: bind a real field path, or
 *  no-valid-fix → honest disclaimer. */
interface LiteralDataFix {
  kind: "literal-data";
  nodeId: string;
  component: string;
  prop: string;
  options: string[];
}

type RepairFix = BindingFix | QueryToolFix | ActionDisclaimFix | ActionPayloadFix | ActionToolFix | LiteralDataFix;

const hostPropRequirement = (
  deps: GenerationDependencies,
  node: TreeNode | undefined,
  prop: string,
): { required: boolean; type?: string } => {
  if (node === undefined) return { required: false };
  const entry = deps.catalog.find((component) => component.name === node.component);
  const schema = entry?.propsJsonSchema;
  if (!isRecord(schema)) return { required: false };
  const required = Array.isArray(schema.required) && schema.required.includes(prop);
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const propSchema = properties !== undefined && isRecord(properties[prop]) ? properties[prop] as Record<string, unknown> : undefined;
  const type = typeof propSchema?.type === "string" ? propSchema.type : undefined;
  return { required, ...(type === undefined ? {} : { type }) };
};

/** Candidate payload-context bindings: every bounded path into every KNOWN
 *  query shape in the app (the per-row id, the form field values live here). */
const contextPaths = (tree: TreeV2, deps: GenerationDependencies): string[] => {
  const out: string[] = [];
  for (const query of tree.queries ?? []) {
    const shape = deps.toolShapes?.[query.tool];
    if (shape === undefined) continue;
    for (const path of enumerateShapePaths(shape, `/${query.name}`)) {
      if (out.length >= MAX_PATH_OPTIONS) return out;
      out.push(path);
    }
  }
  return out;
};

/** The closed fix space for one failed compile: only failure classes the
 *  compiler localizes with an enumerable set of legal fixes. Everything else
 *  stays with the free-form fallback loop. */
const deriveFixes = (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
): RepairFix[] => {
  const fixes: RepairFix[] = [];
  const nodes = new Map(compiled.tree.nodes.map((node) => [node.id, node]));
  const seenBindings = new Set<string>();
  for (const error of compiled.bindingErrors) {
    const bindingKey = `${error.nodeId} ${error.prop} ${error.path}`;
    if (seenBindings.has(bindingKey)) continue;
    seenBindings.add(bindingKey);
    const shape = deps.toolShapes?.[error.tool];
    if (shape === undefined) continue;
    const node = nodes.get(error.nodeId);
    const requirement = node?.source === "host"
      ? hostPropRequirement(deps, node, error.prop)
      : { required: false as const };
    let options = enumerateShapePaths(shape, `/${error.query}`);
    // Kind-filter only when the broken binding IS the whole prop value on a
    // host node with a declared prop type and carries no reshape (reshape
    // changes the delivered kind) — prevents a fix from introducing the
    // silent kind-mismatch class.
    const propValue = node?.props?.[error.prop];
    const wholeProp = isPathBinding(propValue) && propValue.$path === error.path
      && !("$reshape" in (propValue as unknown as Record<string, unknown>));
    if (wholeProp && requirement.type !== undefined) {
      const filtered = options.filter((path) => {
        const bound = shapeAtPointer(shape, path.slice(`/${error.query}`.length));
        return bound !== undefined && kindMatchesSchemaType(bound.kind, requirement.type as string);
      });
      if (filtered.length > 0) options = filtered;
    }
    fixes.push({
      kind: "binding",
      nodeId: error.nodeId,
      prop: error.prop,
      path: error.path,
      query: error.query,
      tool: error.tool,
      options,
      requiredProp: requirement.required,
      message: error.message,
    });
  }
  if (deps.tools !== undefined && deps.tools.length > 0) {
    const known = new Set(deps.tools.map((tool) => tool.name));
    const readTools = deps.tools.filter((tool) => tool.risk === "read").map((tool) => tool.name);
    for (const query of compiled.tree.queries ?? []) {
      if (query.tool.startsWith("fn:") || known.has(query.tool)) continue;
      fixes.push({ kind: "query-tool", query: query.name, tool: query.tool, options: readTools });
    }
  }
  // Law 1 — literal business data on data-classed props: the legal fixes are
  // the bounded real field paths (or the disclaimer arm).
  for (const fault of literalDataFaults(compiled.tree, deps.catalog)) {
    fixes.push({
      kind: "literal-data",
      nodeId: fault.nodeId,
      component: fault.component,
      prop: fault.prop,
      options: contextPaths(compiled.tree, deps),
    });
  }
  const toolByName = new Map((deps.tools ?? []).map((tool) => [tool.name, tool]));
  const seenActions = new Set<string>();
  for (const fault of actionFaults(compiled.tree, deps.tools)) {
    if (seenActions.has(fault.nodeId)) continue;
    seenActions.add(fault.nodeId);
    // Law 2 — an invented action tool: choose from the real registry.
    if (fault.kind === "unknown-tool" && fault.action !== undefined && fault.prop !== undefined) {
      fixes.push({
        kind: "action-tool",
        nodeId: fault.nodeId,
        prop: fault.prop,
        action: fault.action,
        options: (deps.tools ?? []).map((tool) => tool.name),
      });
      continue;
    }
    // Law 2 — an ungrounded payload is rebuilt whole from the tool's REAL
    // input schema (same strict shape as the missing-payload fill).
    if (fault.kind === "ungrounded-payload" && fault.action !== undefined && fault.prop !== undefined) {
      const schema = toolByName.get(fault.action)?.inputSchema;
      const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
      const fields = properties === undefined ? [] : Object.keys(properties);
      const requiredFields = isRecord(schema) && Array.isArray(schema.required)
        ? schema.required.filter((field): field is string => typeof field === "string")
        : [];
      const options = contextPaths(compiled.tree, deps);
      if (fields.length > 0 && options.length > 0) {
        fixes.push({
          kind: "action-payload",
          nodeId: fault.nodeId,
          prop: fault.prop,
          action: fault.action,
          fields,
          requiredFields,
          options,
          replace: true,
        });
        continue;
      }
      fixes.push({ kind: "action-disclaim", nodeId: fault.nodeId, reason: `action "${fault.action}" carries payload fields (${(fault.unknownFields ?? []).join(", ")}) the tool does not declare` });
      continue;
    }
    if (fault.kind === "missing-payload" && fault.action !== undefined && fault.prop !== undefined) {
      const schema = toolByName.get(fault.action)?.inputSchema;
      const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
      const fields = properties === undefined ? [] : Object.keys(properties);
      const requiredFields = isRecord(schema) && Array.isArray(schema.required)
        ? schema.required.filter((field): field is string => typeof field === "string")
        : [];
      const options = contextPaths(compiled.tree, deps);
      if (fields.length > 0 && options.length > 0) {
        fixes.push({
          kind: "action-payload",
          nodeId: fault.nodeId,
          prop: fault.prop,
          action: fault.action,
          fields,
          requiredFields,
          options,
        });
        continue;
      }
    }
    const reason = fault.kind === "dead-submit"
      ? `submit button ("${fault.label}") with no action`
      : fault.kind === "read-only-submit"
        ? `submit button ("${fault.label}") wired to read-only tool "${fault.action}"`
        : `mutating tool "${fault.action}" invoked with no payload and no derivable payload skeleton`;
    fixes.push({ kind: "action-disclaim", nodeId: fault.nodeId, reason });
  }
  return fixes;
};

const fixKey = (index: number): string => `fix_${index}`;

// ---------------------------------------------------------------------------
// Rebind fix space — consumed by the data-sighted verify (stages/verify.ts).
// Re-gate 2026-07-26: wrong-data-binding is the top model-error class in
// every arm and a copy-only patch cannot fix it. The verify pass may propose
// pointing a binding at a different field, but ONLY through this closed
// space: one strict slot per bound prop, its enum the REAL field paths from
// the tool shapes, kind-filtered to the current binding's delivered kind
// (the kind that already validated against the prop type), plus the
// no-valid-fix (keep) arm. Free-text binding edits do not exist on this path.
// ---------------------------------------------------------------------------

/** One rebindable binding: a whole-prop `$path` into a known query shape. */
export interface RebindSlot {
  nodeId: string;
  component: string;
  prop: string;
  /** The current binding's `$path`. */
  path: string;
  /** The node's own copy label, naming the claim the binding must honor. */
  label?: string;
  /** The RESOLVED value at the current path (trimmed) — the evidence the
   *  verifier judges the binding against. */
  sample?: string;
  options: string[];
}

const decodePointerToken = (token: string): string =>
  token.replace(/~1/g, "/").replace(/~0/g, "~");

/** The resolved value at a query-prefixed JSON-Pointer path, trimmed to ride
 *  a strict-schema description. */
const resolvedSampleAt = (data: Record<string, unknown>, path: string): string | undefined => {
  let current: unknown = data;
  for (const token of path.split("/").slice(1)) {
    const key = decodePointerToken(token);
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  if (current === undefined) return undefined;
  const text = JSON.stringify(current) ?? "";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const MAX_REBIND_SLOTS = 8;

const kindsCompatible = (a: ShapeType["kind"], b: ShapeType["kind"]): boolean =>
  a === b || a === "json" || b === "json";

/** Traversal guard for {@link enumerateShapePathsBreadthFirst}: the walk
 *  itself is bounded (only MATCHING paths spend the option budget, so a
 *  pathological derived shape cannot spin the queue unboundedly). */
const MAX_PATH_WALK = 5000;

/** Breadth-first, filter-during-enumeration {@link enumerateShapePaths}:
 *  every shallow path is visited before ANY deeper one, and only paths the
 *  predicate accepts spend the bounded option budget — so a top-level field
 *  can neither be buried under an earlier sibling's deep descendants nor
 *  crowded out by kind-incompatible paths. The rebind space wants exactly
 *  this: the shallow fields ARE the aggregates (/query/total) the gate's
 *  wrong-binding class needs to reach. */
const enumerateShapePathsBreadthFirst = (
  shape: ShapeType,
  prefix: string,
  matches: (shape: ShapeType) => boolean,
): string[] => {
  const out: string[] = [];
  const queue: Array<{ shape: ShapeType; path: string; depth: number }> = [{ shape, path: prefix, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && out.length < MAX_PATH_OPTIONS && visited < MAX_PATH_WALK) {
    const next = queue.shift();
    if (next === undefined) break;
    visited += 1;
    if (matches(next.shape)) out.push(next.path);
    if (next.depth >= MAX_PATH_DEPTH) continue;
    if (next.shape.kind === "object") {
      for (const [field, child] of Object.entries(next.shape.fields)) {
        queue.push({
          shape: child,
          path: `${next.path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          depth: next.depth + 1,
        });
      }
    } else if (next.shape.kind === "array") {
      queue.push({ shape: next.shape.items, path: `${next.path}/0`, depth: next.depth + 1 });
    }
  }
  return out;
};

/** Every rebindable binding in the tree with its closed set of legal targets:
 *  whole-prop `$path` bindings whose query has a known tool shape, offered
 *  the bounded real paths (across ALL known queries — the true value may live
 *  under a different query) that deliver the same kind the current binding
 *  does. A slot whose only legal target is itself is not a slot. */
export const deriveRebindSlots = (
  tree: TreeV2,
  deps: GenerationDependencies,
  resolvedData: Record<string, unknown>,
): RebindSlot[] => {
  const slots: RebindSlot[] = [];
  const queries = tree.queries ?? [];
  const queryByName = new Map(queries.map((query) => [query.name, query]));
  for (const node of tree.nodes) {
    for (const [prop, value] of Object.entries(node.props ?? {})) {
      if (slots.length >= MAX_REBIND_SLOTS) return slots;
      if (!isPathBinding(value)) continue;
      const tokens = value.$path.split("/");
      const query = queryByName.get(decodePointerToken(tokens[1] ?? ""));
      const shape = query === undefined ? undefined : deps.toolShapes?.[query.tool];
      if (shape === undefined) continue;
      const subPath = tokens.length > 2 ? `/${tokens.slice(2).join("/")}` : "";
      const currentKind = shapeAtPointer(shape, subPath)?.kind;
      if (currentKind === undefined) continue;
      // Per-query candidate lists first — each breadth-first with the kind
      // filter applied DURING enumeration (so neither an earlier field's
      // deep descendants nor a crowd of kind-incompatible siblings can spend
      // the bounded budget before the truthful target is reached) — then
      // round-robined into the bounded enum, so no path-rich query starves
      // another query's fields out of the fix space (review 2026-07-26,
      // Greptile P1 ×3).
      const perQuery: string[][] = [];
      for (const candidateQuery of queries) {
        const candidateShape = deps.toolShapes?.[candidateQuery.tool];
        if (candidateShape === undefined) continue;
        perQuery.push(enumerateShapePathsBreadthFirst(
          candidateShape,
          `/${candidateQuery.name}`,
          (candidate) => kindsCompatible(candidate.kind, currentKind),
        ));
      }
      const options: string[] = [];
      for (let rank = 0; options.length < MAX_PATH_OPTIONS; rank += 1) {
        let drained = true;
        for (const list of perQuery) {
          const candidate = list[rank];
          if (candidate === undefined || options.length >= MAX_PATH_OPTIONS) continue;
          options.push(candidate);
          drained = false;
        }
        if (drained) break;
      }
      if (options.filter((option) => option !== value.$path).length === 0) continue;
      const label = node.props?.["label"] ?? node.props?.["title"];
      const sample = resolvedSampleAt(resolvedData, value.$path);
      slots.push({
        nodeId: node.id,
        component: node.component,
        prop,
        path: value.$path,
        ...(typeof label === "string" ? { label } : {}),
        ...(sample === undefined ? {} : { sample }),
        options,
      });
    }
  }
  return slots;
};

/** The strict flat schema for one rebind round (same discipline as
 *  {@link buildFixSchema}): one property per slot, its enum the slot's legal
 *  paths plus the explicit keep arm, the current binding and its resolved
 *  sample named in the description. */
export const buildRebindSchema = (slots: RebindSlot[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: slots.map((_, index) => fixKey(index)),
  properties: Object.fromEntries(slots.map((slot, index) => [fixKey(index), {
    type: "string",
    enum: [...slot.options, NO_VALID_FIX],
    description: `Node "${slot.nodeId}" (<${slot.component}>${slot.label === undefined ? "" : ` labeled "${slot.label}"`}) prop "${slot.prop}" binds ${slot.path}${slot.sample === undefined ? "" : `, which resolved to ${slot.sample}`}. If that value contradicts the node's label or the user's ask, choose the REAL field path holding the value the label truthfully describes; otherwise ${NO_VALID_FIX} keeps the current binding.`,
  }])),
});

/** Validates one rebind answer set against its slots. `undefined` on ANY
 *  out-of-enum value — enum discipline drops the whole patch, it never
 *  clamps (a wrong rebind is worse than no rebind). Keeps (the no-valid-fix
 *  arm or re-choosing the current path) are filtered out. */
export const rebindChoices = (
  slots: RebindSlot[],
  chosen: Record<string, unknown>,
): Array<{ nodeId: string; prop: string; from: string; to: string }> | undefined => {
  const picks: Array<{ nodeId: string; prop: string; from: string; to: string }> = [];
  for (const [index, slot] of slots.entries()) {
    const value = chosen[fixKey(index)];
    if (typeof value !== "string") return undefined;
    if (value === NO_VALID_FIX) continue;
    if (!slot.options.includes(value)) return undefined;
    if (value !== slot.path) picks.push({ nodeId: slot.nodeId, prop: slot.prop, from: slot.path, to: value });
  }
  return picks;
};

/** The flat strict schema (Anthropic strict: additionalProperties:false +
 *  required everywhere, no recursion): one property per pending failure, its
 *  enum the failure's legal fixes plus the explicit no-valid-fix arm. */
const buildFixSchema = (fixes: RepairFix[]): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  fixes.forEach((fix, index) => {
    if (fix.kind === "binding") {
      properties[fixKey(index)] = {
        type: "string",
        enum: [...fix.options, NO_VALID_FIX],
        description: `Node "${fix.nodeId}" prop "${fix.prop}" binds ${fix.path} — ${fix.message}. Choose the correct field path from query "${fix.query}" (tool ${fix.tool}), or ${NO_VALID_FIX} to drop the binding${fix.requiredProp ? " (the node becomes an honest disclaimer)" : ""}.`,
      };
    } else if (fix.kind === "query-tool") {
      properties[fixKey(index)] = {
        type: "string",
        enum: [...fix.options, NO_VALID_FIX],
        description: `Query "${fix.query}" names unknown tool "${fix.tool}". Choose the real host tool it should call, or ${NO_VALID_FIX} to remove the query (dependent content becomes an honest disclaimer).`,
      };
    } else if (fix.kind === "literal-data") {
      properties[fixKey(index)] = {
        type: "string",
        enum: [...fix.options, NO_VALID_FIX],
        description: `Node "${fix.nodeId}" prop "${fix.prop}" on <${fix.component}> carries hand-typed LITERAL business data — law 1: data props must bind a tool result. Choose the real field path to bind, or ${NO_VALID_FIX} to replace the node with an honest disclaimer.`,
      };
    } else if (fix.kind === "action-tool") {
      properties[fixKey(index)] = {
        type: "string",
        enum: [...fix.options, NO_VALID_FIX],
        description: `Node "${fix.nodeId}" prop "${fix.prop}" invokes unknown tool "${fix.action}" — law 2: actions must name a REAL host tool. Choose the real tool, or ${NO_VALID_FIX} to replace the control with an honest disclaimer.`,
      };
    } else if (fix.kind === "action-payload") {
      properties[fixKey(index)] = {
        type: "object",
        additionalProperties: false,
        required: fix.fields,
        properties: Object.fromEntries(fix.fields.map((field) => [field, {
          type: "string",
          enum: [...fix.options, OMIT_FIELD],
          description: `Binding for payload field "${field}" of tool "${fix.action}"${fix.requiredFields.includes(field) ? " (required)" : ""}, or ${OMIT_FIELD} to leave it out.`,
        }])),
        description: `Node "${fix.nodeId}" prop "${fix.prop}" invokes mutating tool "${fix.action}" with no payload. Bind the context it acts on: choose a data path for each payload field. Omitting every field replaces the control with an honest disclaimer.`,
      };
    } else {
      properties[fixKey(index)] = {
        type: "string",
        enum: [NO_VALID_FIX],
        description: `Node "${fix.nodeId}": ${fix.reason}. No valid wiring exists on this host; confirm ${NO_VALID_FIX} to replace it with an honest disclaimer.`,
      };
    }
  });
  return {
    type: "object",
    additionalProperties: false,
    required: fixes.map((_, index) => fixKey(index)),
    properties,
  };
};

/** One strict tool-use call choosing a fix per failure. Returns undefined on
 *  any model/transport failure — the caller falls back to the free-form loop.
 *  Shared with the outline planner (stages/parallel.ts). */
export const strictToolCall = async (
  deps: GenerationDependencies,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  system: string,
  prompt: string,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const { generateText, jsonSchema } = await import("ai");
    const result = await generateText({
      model: deps.model,
      system,
      prompt,
      tools: {
        [toolName]: {
          description,
          inputSchema: jsonSchema(inputSchema as never),
          // Anthropic strict tool use (GA): the arguments MUST validate
          // against the schema — enum values become unsamplable otherwise.
          strict: true,
        } as never,
      },
      toolChoice: { type: "tool", toolName },
      temperature: 0,
      maxRetries: 0,
    });
    const call = result.toolCalls.find((candidate) => candidate.toolName === toolName);
    if (call === undefined || !isRecord(call.input)) return undefined;
    return call.input;
  } catch {
    return undefined;
  }
};

// Defined beside the empty-document gate (which must exempt it) and
// re-exported here so existing importers keep their path.
export { DISCLAIMER_TEXT };

const disclaimNode = (tree: TreeV2, nodeId: string): void => {
  const node = tree.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  node.component = "Text";
  node.source = "prewired";
  node.props = { text: DISCLAIMER_TEXT };
  delete node.children;
};

/** Any `$path`/`$state` binding reachable in a props tree. */
const hasDeepBinding = (container: Record<string, unknown> | unknown[]): boolean => {
  const values = Array.isArray(container) ? container : Object.values(container);
  for (const value of values) {
    if (isPathBinding(value) || isStateBinding(value)) return true;
    if (isRecord(value) || Array.isArray(value)) {
      if (hasDeepBinding(value as Record<string, unknown>)) return true;
    }
  }
  return false;
};

/** A "successful" build whose every substantive region resolved to the
 *  disclaimer above is indistinguishable from a dead build in the host chat:
 *  the record persists, no failure is recorded, and the embed renders an app
 *  that only says "not available" (0.4.5 E2E cert, defect D). Detect that
 *  degenerate shape so the runtime can fail the build LOUDLY instead.
 *
 *  A tree is disclaimer-only when at least one disclaimer landed and no
 *  reachable node carries real capability: no generated island, no host
 *  catalog component, no data binding, no action binding. Static copy alone
 *  (headings around the disclaimers) does not rescue it — that is exactly the
 *  shape the cert screenshots show. A tree with NO disclaimers is never
 *  degenerate here, whatever else it lacks. */
export const isDisclaimerOnlyTree = (tree: TreeV2): boolean => {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const pending = [tree.root];
  let disclaimers = 0;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (node === undefined) continue;
    pending.push(...(node.children ?? []));
    if (node.source === "generated" || node.source === "host") return false;
    // Containment, not equality (review 2026-07-26): repair recompilation
    // merges adjacent Text nodes, so a disclaimed region can arrive embedded
    // in a longer string ("Overview\n  This part…"). A merged heading+
    // disclaimer is still a disclaimer — static copy does not rescue the
    // tree either way (see doc above) — and equality let exactly those
    // all-disclaimed builds persist instead of failing with the
    // host-capability reason.
    if (node.component === "Text" && typeof node.props?.["text"] === "string"
      && node.props["text"].includes(DISCLAIMER_TEXT)) {
      disclaimers += 1;
      continue;
    }
    if (node.props === undefined) continue;
    if (actionBindingsInProps(node.props).length > 0) return false;
    if (hasDeepBinding(node.props)) return false;
  }
  return disclaimers > 0;
};

/** Deletes the value at the walk position where `predicate` matches, deep in
 *  a props tree (object keys deleted, array elements spliced). Returns how
 *  many values were removed. */
const removeDeep = (
  container: Record<string, unknown> | unknown[],
  predicate: (value: unknown) => boolean,
): number => {
  let removed = 0;
  if (Array.isArray(container)) {
    for (let index = container.length - 1; index >= 0; index -= 1) {
      const value = container[index];
      if (predicate(value)) {
        container.splice(index, 1);
        removed += 1;
      } else if (isRecord(value) || Array.isArray(value)) {
        removed += removeDeep(value as Record<string, unknown>, predicate);
      }
    }
    return removed;
  }
  for (const [key, value] of Object.entries(container)) {
    if (predicate(value)) {
      delete container[key];
      removed += 1;
    } else if (isRecord(value) || Array.isArray(value)) {
      removed += removeDeep(value as Record<string, unknown>, predicate);
    }
  }
  return removed;
};

const replaceBindingPath = (
  container: Record<string, unknown> | unknown[],
  fromPath: string,
  toPath: string,
): void => {
  const values = Array.isArray(container) ? container : Object.values(container);
  for (const value of values) {
    if (isPathBinding(value) && value.$path === fromPath) {
      (value as { $path: string }).$path = toPath;
    } else if (isRecord(value) || Array.isArray(value)) {
      replaceBindingPath(value as Record<string, unknown>, fromPath, toPath);
    }
  }
};

const bindingReferencesQuery = (value: unknown, queryName: string): boolean =>
  isPathBinding(value) && (value.$path === `/${queryName}` || value.$path.startsWith(`/${queryName}/`));

const pruneUnreachable = (tree: TreeV2): void => {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const pending = [tree.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(nodes.get(id)?.children ?? []));
  }
  tree.nodes = tree.nodes.filter((node) => reachable.has(node.id));
};

/** Applies chosen fixes to a deep-cloned tree. Every splice is deterministic:
 *  the chosen value was already validated against the fix's enum. */
const spliceFixes = (
  compiled: WireCompileResult,
  fixes: RepairFix[],
  chosen: Record<string, unknown>,
): { tree: TreeV2; components: Record<string, string>; name?: string } => {
  const tree = structuredClone(compiled.tree);
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  fixes.forEach((fix, index) => {
    const value = chosen[fixKey(index)];
    if (fix.kind === "binding") {
      const node = nodes.get(fix.nodeId);
      if (node?.props === undefined) return;
      const pick = typeof value === "string" && fix.options.includes(value) ? value : NO_VALID_FIX;
      if (pick === NO_VALID_FIX) {
        removeDeep(node.props, (candidate) => isPathBinding(candidate) && candidate.$path === fix.path);
        if (node.props[fix.prop] === undefined && fix.requiredProp) disclaimNode(tree, fix.nodeId);
      } else {
        replaceBindingPath(node.props, fix.path, pick);
      }
    } else if (fix.kind === "query-tool") {
      const pick = typeof value === "string" && fix.options.includes(value) ? value : NO_VALID_FIX;
      const query = (tree.queries ?? []).find((candidate) => candidate.name === fix.query);
      if (query === undefined) return;
      if (pick === NO_VALID_FIX) {
        tree.queries = (tree.queries ?? []).filter((candidate) => candidate.name !== fix.query);
        for (const node of tree.nodes) {
          if (node.props === undefined) continue;
          const removed = removeDeep(node.props, (candidate) => bindingReferencesQuery(candidate, fix.query));
          if (removed > 0) {
            const stillRenders = Object.keys(node.props).length > 0;
            if (!stillRenders || node.source === "host") disclaimNode(tree, node.id);
          }
        }
      } else {
        query.tool = pick;
      }
    } else if (fix.kind === "literal-data") {
      const node = nodes.get(fix.nodeId);
      if (node?.props === undefined) return;
      const pick = typeof value === "string" && fix.options.includes(value) ? value : NO_VALID_FIX;
      if (pick === NO_VALID_FIX) {
        disclaimNode(tree, fix.nodeId);
      } else {
        node.props[fix.prop] = { $path: pick };
      }
    } else if (fix.kind === "action-tool") {
      const node = nodes.get(fix.nodeId);
      if (node?.props === undefined) return;
      const pick = typeof value === "string" && fix.options.includes(value) ? value : NO_VALID_FIX;
      if (pick === NO_VALID_FIX) {
        disclaimNode(tree, fix.nodeId);
      } else {
        const rename = (container: Record<string, unknown> | unknown[]): void => {
          const values = Array.isArray(container) ? container : Object.values(container);
          for (const candidate of values) {
            if (isRecord(candidate) && candidate.action === fix.action) {
              candidate.action = pick;
            } else if (isRecord(candidate) || Array.isArray(candidate)) {
              rename(candidate as Record<string, unknown>);
            }
          }
        };
        rename(node.props);
      }
    } else if (fix.kind === "action-payload") {
      const node = nodes.get(fix.nodeId);
      if (node?.props === undefined) return;
      const picks = isRecord(value) ? value : {};
      const payload: Record<string, unknown> = {};
      for (const field of fix.fields) {
        const pick = picks[field];
        if (typeof pick === "string" && fix.options.includes(pick)) {
          payload[field] = { $path: pick };
        }
      }
      if (Object.keys(payload).length === 0) {
        disclaimNode(tree, fix.nodeId);
      } else {
        const apply = (container: Record<string, unknown> | unknown[]): void => {
          const values = Array.isArray(container) ? container : Object.values(container);
          for (const candidate of values) {
            if (isRecord(candidate) && candidate.action === fix.action
              && (fix.replace === true || !hasPayload(candidate.payload))) {
              candidate.payload = structuredClone(payload);
            } else if (isRecord(candidate) || Array.isArray(candidate)) {
              apply(candidate as Record<string, unknown>);
            }
          }
        };
        apply(node.props);
      }
    } else {
      disclaimNode(tree, fix.nodeId);
    }
  });
  pruneUnreachable(tree);
  return {
    tree,
    components: structuredClone(compiled.components),
    ...(compiled.name === undefined ? {} : { name: compiled.name }),
  };
};

export interface StructuredRepairResult {
  document?: GeneratedAppDocument;
  /** Strict-call rounds actually spent (spliced or not). */
  rounds: number;
  issues: string[];
  /** How many fixes resolved to the no-valid-fix/Disclaimer arm. */
  noValidFixCount: number;
}

/** Structured repair. Compile errors with a closed fix space are fixed by
 *  ONE strict tool-use call per round (max `maxRounds`), spliced
 *  deterministically into the canonical tree, re-printed, re-compiled and
 *  re-validated. Anything outside the closed space (or a failed call)
 *  returns with `document` unset and the caller falls back to the free-form
 *  regeneration loop. */
export const structuredRepair = async (
  compiled: WireCompileResult,
  userRequest: string,
  context: PipelineContext,
  maxRounds = 2,
): Promise<StructuredRepairResult> => {
  const repairStart = Date.now();
  const finish = (result: StructuredRepairResult): StructuredRepairResult => {
    if (result.rounds > 0) {
      context.deps.onPipeline?.({
        stage: "repair",
        rounds: result.rounds,
        repaired: result.document !== undefined,
        noValidFix: result.noValidFixCount,
        ms: Date.now() - repairStart,
      });
    }
    return result;
  };
  const { deps } = context;
  let current = compiled;
  let issues: string[] = [];
  let noValidFixCount = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const fixes = deriveFixes(current, deps);
    if (fixes.length === 0) return finish({ rounds: round, issues, noValidFixCount });
    const schema = buildFixSchema(fixes);
    const wire = printWireV2(
      { tree: current.tree, components: current.components, ...(current.name === undefined ? {} : { name: current.name }) },
      { includeIds: true },
    );
    const chosen = await strictToolCall(
      deps,
      "apply_fixes",
      "Apply one fix per pending compile failure. Every fix is chosen from that failure's closed set of legal values.",
      schema,
      "You repair Vendo apps. For each pending failure, choose the fix that best serves the user's request. Choose the no-valid-fix arm only when no listed value can honestly satisfy the intent.",
      `USER_REQUEST: ${userRequest}\nCURRENT_APP (wire markup; id attributes locate the failing nodes):\n${wire}`,
    );
    deps.onTiming?.({ lane: "repair", phase: "complete", atMs: Date.now() - context.startedAt, thinking: false });
    if (chosen === undefined) return finish({ rounds: round + 1, issues, noValidFixCount });
    fixes.forEach((fix, index) => {
      const value = chosen[fixKey(index)];
      if (fix.kind === "action-disclaim") { noValidFixCount += 1; return; }
      if (fix.kind === "action-payload") {
        const picks = isRecord(value) ? value : {};
        if (!fix.fields.some((field) => typeof picks[field] === "string" && fix.options.includes(picks[field] as string))) noValidFixCount += 1;
        return;
      }
      if (typeof value !== "string" || !fix.options.includes(value)) noValidFixCount += 1;
    });
    const recompiled = recompile(spliceFixes(current, fixes, chosen), context);
    const validated = await context.validate(recompiled);
    if (validated.document !== undefined) {
      return finish({ document: validated.document, rounds: round + 1, issues, noValidFixCount });
    }
    issues = [...new Set([...issues, ...validated.issues])];
    current = recompiled;
  }
  return finish({ rounds: maxRounds, issues, noValidFixCount });
};
