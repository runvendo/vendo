import {
  compileWireV2,
  compileWirePatchV2,
  printWireV2,
  isPathBinding,
  isStateBinding,
  kitPropClasses,
  KIT_WIRE_COMPONENT_NAMES,
  shapeAtPointer,
  type NormalizedCatalog,
  type ShapeType,
  type TreeNode,
  type TreeV2,
  type WireCompileResult,
} from "@vendoai/core";
import type {
  GeneratedAppDocument,
  GenerationDependencies,
  HostToolInfo,
} from "./engine.js";

/** W4 pipeline (spec §How a generation runs) — engine-internal knobs.
 *  `structuredRepair` (adopt-now) replaces free-form repair regeneration with
 *  one strict tool-use call over the closed fix space; on by default.
 *  `regionParallel` (outline + parallel section writers) and `endPass`
 *  (no-think polish read-through) are opt-in flags while being measured. */
export interface PipelineConfig {
  structuredRepair?: boolean;
  regionParallel?: boolean;
  endPass?: boolean;
  /** v4 wave — the rewritten create contract (single-voice sections, principles
   *  stated once, worked exemplars; scar-tissue rules retired to validators +
   *  repair). Opt-in while the A/B against the current contract is measured. */
  promptRewrite?: boolean;
}

/** W4 pipeline — opt-in per-stage diagnostics: rounds, no-valid-fix
 *  take-rate, region-parallel fallback reasons, end-pass adoption, wall-clock
 *  per stage. Powers live measurement and production observability. */
export type PipelineEvent =
  | { stage: "repair"; rounds: number; repaired: boolean; noValidFix: number; ms: number }
  | { stage: "region-parallel"; fallback?: "no-outline" | "sections-failed" | "assembly-invalid"; sectionsPlanned?: number; sectionsLanded?: number; ms: number }
  | { stage: "end-pass"; applied: boolean; ms: number }
  | { stage: "data-verify"; applied: boolean; ms: number };

/** The engine's create validation, passed in as a callback so pipeline.ts
 *  never imports engine internals (engine → pipeline stays one-directional). */
export type CreateValidator = (
  compiled: WireCompileResult,
) => Promise<{ document?: GeneratedAppDocument; issues: string[] }>;

export interface PipelineContext {
  deps: GenerationDependencies;
  hostComponents: readonly string[];
  validate: CreateValidator;
  /** Milliseconds origin of the surrounding create() for onTiming events. */
  startedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Action-wiring honesty (verify-v2 #4 reminder, #6 intake). Owned here so the
// structured-repair fix space and the engine's validation share ONE detector;
// engine.ts imports these (one-directional).
// ---------------------------------------------------------------------------

/** Button labels that promise a state change. A Button carrying one of these
 *  is a submit/primary affordance: it must DO something (a mutating host tool
 *  bound to real context) or honestly say it can't — a no-op submit is the
 *  facade class. Read-only verbs (view/show/open) and dismiss verbs
 *  (cancel/clear/close) are deliberately excluded. */
export const SUBMIT_LABEL = /\b(submit|save|create|add|send|remind|reminder|transfer|pay|confirm|update|delete|remove|apply|schedule|book|post|approve|generate|register|enroll|invite|assign)\b/i;

export const isMutatingRisk = (risk: string | undefined): boolean => risk === "write" || risk === "destructive";

export const hasPayload = (payload: unknown): boolean =>
  isRecord(payload) ? Object.keys(payload).length > 0 : payload !== undefined && payload !== null;

const isActionBinding = (value: unknown): boolean =>
  isRecord(value) && typeof value.action === "string";

/** Every {action,payload?} binding reachable in a node's props, with the prop
 *  it sits under (actions can nest inside arrays/objects, not just top-level
 *  on* attributes). */
export const actionBindingsInProps = (
  props: Record<string, unknown>,
): Array<{ prop: string; action: string; payload: unknown }> => {
  const found: Array<{ prop: string; action: string; payload: unknown }> = [];
  const walk = (prop: string, value: unknown): void => {
    if (isActionBinding(value)) {
      const record = value as Record<string, unknown>;
      found.push({ prop, action: record.action as string, payload: record.payload });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(prop, item);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) walk(prop, child);
    }
  };
  for (const [prop, value] of Object.entries(props)) walk(prop, value);
  return found;
};

/** One structured action-honesty failure (the string rendering lives in
 *  engine.actionIssues; this shape feeds the repair fix space). W3 adds the
 *  law-2 grounding kinds: an action must name a REAL tool, and its payload
 *  fields must be the tool's REAL input parameters. */
export interface ActionFault {
  nodeId: string;
  kind: "dead-submit" | "missing-payload" | "read-only-submit" | "unknown-tool" | "ungrounded-payload";
  prop?: string;
  action?: string;
  label?: string;
  /** ungrounded-payload — the payload keys the tool's input schema does not declare. */
  unknownFields?: string[];
  /** ungrounded-payload — the tool's real input parameter names. */
  allowedFields?: string[];
  /** ungrounded-payload — REQUIRED input parameters absent from the payload. */
  missingFields?: string[];
}

export const actionFaults = (
  tree: TreeV2,
  tools: readonly HostToolInfo[] | undefined,
): ActionFault[] => {
  const byName = new Map((tools ?? []).map((tool) => [tool.name, tool]));
  const faults: ActionFault[] = [];
  for (const node of tree.nodes) {
    const props = node.props;
    const buttonLabel = node.component === "Button" && typeof props?.label === "string" ? props.label : "";
    // W3 law 2 — a Kit <Form> IS a submit affordance whatever its label says.
    const isForm = node.component === "Form";
    const label = isForm
      ? (typeof props?.submitLabel === "string" ? props.submitLabel : "Submit")
      : buttonLabel;
    const submitLike = isForm || (buttonLabel !== "" && SUBMIT_LABEL.test(buttonLabel));
    const bindings = props === undefined ? [] : actionBindingsInProps(props);
    if (submitLike && bindings.length === 0) {
      faults.push({ nodeId: node.id, kind: "dead-submit", label });
    }
    for (const { prop, action, payload } of bindings) {
      if (action.startsWith("fn:")) continue;
      const tool = byName.get(action);
      if (tool === undefined) {
        // W3 law 2 — grounding is checkable only when the registry is known.
        if (byName.size > 0) faults.push({ nodeId: node.id, kind: "unknown-tool", prop, action, label });
        continue;
      }
      if (isMutatingRisk(tool.risk) && !hasPayload(payload)) {
        faults.push({ nodeId: node.id, kind: "missing-payload", prop, action });
      }
      if (submitLike && tool.risk === "read") {
        faults.push({ nodeId: node.id, kind: "read-only-submit", prop, action, label });
      }
      // W3 law 2 — payload fields must be the tool's real input parameters,
      // and every REQUIRED parameter must be present (a nonempty partial
      // payload would otherwise invoke the tool without e.g. its invoiceId).
      if (hasPayload(payload) && isRecord(payload)) {
        const schema = tool.inputSchema;
        const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
        const open = isRecord(schema) && schema.additionalProperties === true;
        if (properties !== undefined && !open) {
          const allowed = Object.keys(properties);
          const unknown = Object.keys(payload).filter((field) => !allowed.includes(field));
          const required = isRecord(schema) && Array.isArray(schema.required)
            ? schema.required.filter((field): field is string => typeof field === "string")
            : [];
          const missing = required.filter((field) => !(field in payload));
          if (unknown.length > 0 || missing.length > 0) {
            faults.push({ nodeId: node.id, kind: "ungrounded-payload", prop, action, unknownFields: unknown, allowedFields: allowed, missingFields: missing });
          }
        }
      }
    }
  }
  return faults;
};

// ---------------------------------------------------------------------------
// Law 1 (W3, v3 spec §The design in five lines) — data-classed props must be
// bindings. One detector, shared by the engine's validation (message
// rendering) and the structured-repair fix space.
// ---------------------------------------------------------------------------

/** Legacy prewired data props (the Kit carries classes in its specs; the
 *  legacy set is classed here until the Wave-5 retirement). */
const LEGACY_DATA_PROPS: Readonly<Record<string, readonly string[]>> = {
  Table: ["rows"],
  Select: ["options"],
  Stat: ["value"],
};

const KIT_WIRE_NAMES: ReadonlySet<string> = new Set(KIT_WIRE_COMPONENT_NAMES);

/** A HOST catalog prop counts as data-classed when its declared JSON-schema
 *  type is a number or an array, its name says business data, and it is not
 *  enum-constrained (enums are config by construction). Strings stay free —
 *  they are labels/copy far more often than data. */
const HOST_DATA_PROP = /(cents|amount|balance|total|value|series|rows|items|data|points|slices|history)/i;

const hostDataProps = (schema: unknown): string[] => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([name, propSchema]) => {
    if (!isRecord(propSchema) || Array.isArray(propSchema.enum)) return [];
    const type = propSchema.type;
    if (type !== "number" && type !== "integer" && type !== "array") return [];
    return HOST_DATA_PROP.test(name) ? [name] : [];
  });
};

/** The data-classed prop names of one node: Kit prop classes for adopted Kit
 *  names, the legacy map for the old prewired set, schema-derived for host
 *  catalog components. */
export const dataClassedProps = (node: TreeNode, catalog: NormalizedCatalog): readonly string[] => {
  if (node.source === "host") {
    const entry = catalog.find((component) => component.name === node.component);
    return hostDataProps(entry?.propsJsonSchema);
  }
  if (node.source === "generated") return [];
  if (KIT_WIRE_NAMES.has(node.component)) {
    const classes = kitPropClasses(node.component);
    return classes === undefined ? [] : Object.entries(classes).flatMap(([prop, cls]) => cls === "data" ? [prop] : []);
  }
  return LEGACY_DATA_PROPS[node.component] ?? [];
};

export interface LiteralDataFault {
  nodeId: string;
  component: string;
  prop: string;
}

const isBindingValue = (value: unknown): boolean => isPathBinding(value) || isStateBinding(value);

/** Law 1 — every data-classed prop present on a node must be a `$path` /
 *  `$state` binding. A literal there is hand-typed business data. */
export const literalDataFaults = (tree: TreeV2, catalog: NormalizedCatalog): LiteralDataFault[] => {
  const faults: LiteralDataFault[] = [];
  for (const node of tree.nodes) {
    const props = node.props;
    if (props === undefined) continue;
    for (const prop of dataClassedProps(node, catalog)) {
      const value = props[prop];
      if (value === undefined || value === null) continue;
      if (isBindingValue(value)) continue;
      faults.push({ nodeId: node.id, component: node.component, prop });
    }
  }
  return faults;
};

// ---------------------------------------------------------------------------
// Structured repair — one strict tool-use call over the closed fix space.
// ---------------------------------------------------------------------------

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
  /** W3 law 2 — true when an EXISTING (ungrounded) payload is replaced whole
   *  rather than a missing one filled. */
  replace?: boolean;
}

/** W3 law 2 — an action naming a tool absent from the registry: pick the
 *  real tool, or no-valid-fix → honest disclaimer. */
interface ActionToolFix {
  kind: "action-tool";
  nodeId: string;
  prop: string;
  action: string;
  options: string[];
}

/** W3 law 1 — a literal on a data-classed prop: bind a real field path, or
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
  // W3 law 1 — literal business data on data-classed props: the legal fixes
  // are the bounded real field paths (or the disclaimer arm).
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
    // W3 law 2 — an invented action tool: choose from the real registry.
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
    // W3 law 2 — an ungrounded payload is rebuilt whole from the tool's REAL
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
 *  any model/transport failure — the caller falls back to the free-form loop. */
const strictToolCall = async (
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

const DISCLAIMER_TEXT = "This part of the request isn't available on this host.";

const disclaimNode = (tree: TreeV2, nodeId: string): void => {
  const node = tree.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  node.component = "Text";
  node.source = "prewired";
  node.props = { text: DISCLAIMER_TEXT };
  delete node.children;
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

const recompile = (
  base: { tree: TreeV2; components: Record<string, string>; name?: string },
  context: PipelineContext,
): WireCompileResult => compileWireV2(
  printWireV2(base, { includeIds: false }),
  {
    hostComponents: [...context.hostComponents],
    ...(context.deps.toolShapes === undefined ? {} : { toolShapes: context.deps.toolShapes }),
  },
);

export interface StructuredRepairResult {
  document?: GeneratedAppDocument;
  /** Strict-call rounds actually spent (spliced or not). */
  rounds: number;
  issues: string[];
  /** How many fixes resolved to the no-valid-fix/Disclaimer arm. */
  noValidFixCount: number;
}

/** v3 pipeline step 5 — structured repair. Compile errors with a closed fix
 *  space are fixed by ONE strict tool-use call per round (max `maxRounds`),
 *  spliced deterministically into the canonical tree, re-printed, re-compiled
 *  and re-validated. Anything outside the closed space (or a failed call)
 *  returns with `document` unset and the caller falls back to today's
 *  free-form regeneration loop. */
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

// ---------------------------------------------------------------------------
// End pass — one no-think read-through emitting 0–4 validated proofread
// patches; priority one is label-vs-binding truth (v4: the M6/M14/F5 class).
// ---------------------------------------------------------------------------

const END_PASS_CONTRACT = `You are the Vendo end-pass editor: one quick read-through of a finished app against the user's ask. Return ONLY one vendo-genui/v2 <Edit>...</Edit> patch document. No prose, no markdown, no JSON.
PROOFREAD ONLY, AT MOST 4 ops. Priority one — labels must tell the truth about their bindings: a stat, badge, title, or caption claiming "total", "all accounts", "this month", or a specific figure must match what its bound data actually is. When it doesn't, RELABEL to describe the real data (never invent numbers, never rebind) — e.g. a card bound to one checking account labeled "Total balance" becomes <Set id="..." label="Checking balance"/>. Prefer emitting a fix when a label overstates its binding; an unfixed lying label is worse than an extra op. Then: deduplicate repeated titles/stats, retitle so the app answers the ask, drop a redundant node. Never restructure, never add features, never touch queries or islands.
Ops (patch the CURRENT_APP wire against its id="..." anchors):
- <Set id="node-id" attr=.../> merges attributes into the node's props. Set/Unset may touch ONLY copy props (label, title, text, caption, description, subtitle, heading, placeholder, helper, emptyLabel, badgeLabel) with plain string values — touching any other attribute, a binding, or a non-string value drops your whole patch.
- <Unset id="node-id" propName/> removes the named props.
- <Remove id="node-id"/> removes a redundant node and its subtree.
- <SetName name="..."/> renames the app.
If nothing needs polish, emit exactly <Edit></Edit>.`;

/** v4 review hardening — the contract's "relabel, never rebind, never
 *  restructure" was prompt-only: any compiling <Set> (including one that
 *  overwrites a live value or binding with an invented figure) survived. This
 *  makes the contract structural. A surviving patch may only rename the app,
 *  remove nodes, and set/unset STRING copy props; anything else — new nodes,
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
  base: TreeV2,
  patched: TreeV2,
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

/** Same fence tolerance as engine.ts's extractWire, for <Edit> documents
 *  (shared by the edit dialect and the end pass). */
export const extractEdit = (text: string): string => {
  const start = text.indexOf("<Edit");
  if (start === -1) return text;
  const closeTag = "</Edit>";
  const close = text.lastIndexOf(closeTag);
  return close === -1 ? text.slice(start) : text.slice(start, close + closeTag.length);
};

/** v3 pipeline step 6, sharpened in v4 — the end pass. Runs only under the
 *  `endPass` flag (default flips when the v4 A/B earns it); a patch survives
 *  only if it compiles clean, applies at most 4 ops, and the patched app
 *  re-validates — otherwise the original document ships untouched.
 *  Structurally cannot break the app. */
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
      tree: structuredClone(document.tree) as unknown as TreeV2,
      components: { ...(document.components ?? {}) },
      name: document.name,
    };
    const wire = printWireV2(base, { includeIds: true });
    // The no-think switch: the paint model is the configured thinking-disabled
    // instance; the read-through never needs reasoning depth.
    const model = deps.paint?.model ?? deps.model;
    const { generateText } = await import("ai");
    const result = await generateText({
      model,
      system: END_PASS_CONTRACT,
      prompt: `USER_ASK: ${userRequest}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${wire}`,
      temperature: 0,
      maxRetries: 0,
    });
    deps.onTiming?.({ lane: "end-pass", phase: "complete", atMs: Date.now() - context.startedAt, thinking: false });
    const patched = compileWirePatchV2(extractEdit(result.text), base, {
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
// Data-sighted verification — the v4 gate's lesson (14/21 fails were headline
// lies the model wrote BLIND: queries resolve after generation, so labels are
// claims about values the writer never saw, and the blind end pass could not
// check them either). This pass runs at the runtime seam AFTER queries
// resolve: the model sees the app AND the actual values, and may emit the
// same copy-only, revalidated patch the end pass is limited to.
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

/** The data-sighted verification pass. Same survival gauntlet as the end
 *  pass — compile clean, ≤4 ops, copy-only structural guard, full
 *  revalidation — so it structurally cannot break the app; the only new
 *  input is the resolved data digest. The caller owns the flag decision. */
export const dataSightedVerify = async (
  document: GeneratedAppDocument,
  userRequest: string,
  resolvedData: Record<string, unknown>,
  context: PipelineContext,
): Promise<GeneratedAppDocument> => {
  const { deps } = context;
  const startedAtMs = Date.now();
  const finish = (verified: GeneratedAppDocument): GeneratedAppDocument => {
    deps.onPipeline?.({ stage: "data-verify", applied: verified !== document, ms: Date.now() - startedAtMs });
    return verified;
  };
  try {
    const base = {
      tree: structuredClone(document.tree) as unknown as TreeV2,
      components: { ...(document.components ?? {}) },
      name: document.name,
    };
    const wire = printWireV2(base, { includeIds: true });
    const model = deps.paint?.model ?? deps.model;
    const { generateText } = await import("ai");
    const result = await generateText({
      model,
      system: DATA_VERIFY_CONTRACT,
      prompt: `USER_ASK: ${userRequest}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${wire}\nACTUAL data the queries returned (trimmed sample):\n${dataDigest(resolvedData)}`,
      temperature: 0,
      maxRetries: 0,
    });
    const patched = compileWirePatchV2(extractEdit(result.text), base, {
      hostComponents: [...context.hostComponents],
      ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
    });
    if (!patched.complete || patched.issues.length > 0 || patched.bindingErrors.length > 0) return finish(document);
    if (patched.appliedOps === 0 || patched.appliedOps > 4 || patched.extensionOps.length > 0) return finish(document);
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
// Outline + region-parallel tier-2 — strict outline, N parallel section
// writers over the shared prefix, deterministic assembly, whole-app validate.
// ---------------------------------------------------------------------------

interface OutlineSection {
  id: string;
  brief: string;
  tools: string[];
}

interface Outline {
  appName: string;
  sharedFacts: string;
  sections: OutlineSection[];
}

const MAX_SECTIONS = 4;

const outlineSchema = (toolNames: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["appName", "sharedFacts", "sections"],
  properties: {
    appName: { type: "string", description: "The app's display name." },
    sharedFacts: {
      type: "string",
      description: "Shared data/state facts every section must agree on (which queries feed what, shared filters, units). Empty string when none.",
    },
    sections: {
      type: "array",
      description: `2 to ${MAX_SECTIONS} independent screen regions, top to bottom. Merge deeply coupled pieces (a picker filtering another view) into ONE section — a section is generated in isolation.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "brief", "tools", "coupledWithPrevious"],
        properties: {
          id: { type: "string", description: "Short lowercase identifier, e.g. s1_summary." },
          brief: { type: "string", description: "What this region shows and does." },
          tools: {
            type: "array",
            description: "The host tools feeding this section.",
            items: { type: "string", enum: toolNames },
          },
          coupledWithPrevious: {
            type: "boolean",
            description: "True when this region shares live state with the previous one and must be generated together with it.",
          },
        },
      },
    },
  },
});

const planOutline = async (
  userRequest: string,
  context: PipelineContext,
): Promise<Outline | undefined> => {
  const { deps } = context;
  const toolNames = (deps.tools ?? []).map((tool) => tool.name);
  if (toolNames.length === 0) return undefined;
  const input = await strictToolCall(
    deps,
    "plan_outline",
    "Plan the app as independent screen regions before parallel generation.",
    outlineSchema(toolNames),
    "You plan Vendo app generations. Split the requested app into independent regions that can be generated in parallel; keep coupled pieces in one region.",
    `USER_REQUEST: ${userRequest}\nHOST TOOLS:\n${(deps.tools ?? []).map(({ name, description, risk }) => `- ${name} [${risk}]: ${description}`).join("\n")}`,
  );
  deps.onTiming?.({ lane: "outline", phase: "complete", atMs: Date.now() - context.startedAt, thinking: false });
  if (input === undefined || typeof input.appName !== "string" || !Array.isArray(input.sections)) return undefined;
  const known = new Set(toolNames);
  const sections: OutlineSection[] = [];
  for (const raw of input.sections) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.brief !== "string") return undefined;
    const tools = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && known.has(tool)) : [];
    const id = raw.id.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_").replaceAll(/^_+|_+$/g, "") || `s${sections.length + 1}`;
    if (raw.coupledWithPrevious === true && sections.length > 0) {
      const previous = sections[sections.length - 1] as OutlineSection;
      previous.brief = `${previous.brief}\nAND, coupled in the same region: ${raw.brief}`;
      previous.tools = [...new Set([...previous.tools, ...tools])];
    } else {
      sections.push({ id, brief: raw.brief, tools });
    }
  }
  if (sections.length < 2 || sections.length > MAX_SECTIONS) return undefined;
  const ids = new Set(sections.map((section) => section.id));
  if (ids.size !== sections.length) return undefined;
  return {
    appName: input.appName,
    sharedFacts: typeof input.sharedFacts === "string" ? input.sharedFacts : "",
    sections,
  };
};

/** The section's inner markup: everything between the App open tag and its
 *  close (islands included — they are top-level siblings inside App). */
const innerAppMarkup = (text: string): string | undefined => {
  const start = text.indexOf("<App");
  if (start === -1) return undefined;
  const open = text.indexOf(">", start);
  if (open === -1) return undefined;
  const close = text.lastIndexOf("</App>");
  const inner = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
  return inner.trim() === "" ? undefined : inner;
};

export interface RegionParallelResult {
  document?: GeneratedAppDocument;
  /** Why the parallel path yielded no document (measurement + fallback). */
  fallback?: "no-outline" | "sections-failed" | "assembly-invalid";
  sectionsPlanned?: number;
  sectionsLanded?: number;
}

export interface RegionParallelHooks {
  /** The engine's streamWire, bound to deps/system: returns raw wire text. */
  generateSection: (prompt: string) => Promise<string | undefined>;
  /** Forwarded partial emission (already resident-suppressed by the engine). */
  emitPartial?: (assembledWire: string) => void;
  userRequest: string;
}

/** v3 pipeline steps 1+3 — outline then N parallel per-section writers whose
 *  outputs assemble (in outline order) into one wire document that goes
 *  through the normal whole-app validation. Any planning/assembly failure
 *  returns fallback info and the engine's single-stream lane takes over —
 *  never blocks. */
export const regionParallelCreate = async (
  context: PipelineContext,
  hooks: RegionParallelHooks,
): Promise<RegionParallelResult> => {
  const parallelStart = Date.now();
  const finish = (result: RegionParallelResult): RegionParallelResult => {
    context.deps.onPipeline?.({
      stage: "region-parallel",
      ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
      ...(result.sectionsPlanned === undefined ? {} : { sectionsPlanned: result.sectionsPlanned }),
      ...(result.sectionsLanded === undefined ? {} : { sectionsLanded: result.sectionsLanded }),
      ms: Date.now() - parallelStart,
    });
    return result;
  };
  const outline = await planOutline(hooks.userRequest, context);
  if (outline === undefined) return finish({ fallback: "no-outline" });
  const appName = outline.appName.replaceAll('"', "'");
  const sectionPrompt = (section: OutlineSection, index: number): string => [
    `TASK: CREATE_APP\nUSER_REQUEST: ${hooks.userRequest}`,
    `OUTLINE_SECTION ${section.id} (${index + 1} of ${outline.sections.length}): ${section.brief}`,
    `- Emit ONE complete <App name="${appName}"> containing ONLY this section's queries and markup — the other sections are generated separately and composed around yours in order.`,
    section.tools.length === 0
      ? "- This section uses NO host tools; render honest static/empty-state content only."
      : `- Use ONLY these host tools: ${section.tools.join(", ")}.`,
    `- Prefix every <Query id> with "${section.id}_" so query names never collide with other sections.`,
    `- Do NOT repeat content that belongs to other sections.`,
    outline.sharedFacts.trim() === "" ? "" : `SHARED FACTS (every section must agree): ${outline.sharedFacts}`,
  ].filter((line) => line !== "").join("\n");

  const landed: Array<string | undefined> = outline.sections.map(() => undefined);
  const assemble = (): string => `<App name="${appName}">${landed.filter((part): part is string => part !== undefined).join("\n")}</App>`;
  await Promise.all(outline.sections.map(async (section, index) => {
    const text = await hooks.generateSection(sectionPrompt(section, index));
    if (text === undefined) return;
    const inner = innerAppMarkup(text);
    if (inner === undefined) return;
    landed[index] = inner;
    // (streamWire already emits the lane:"section" complete timing event.)
    hooks.emitPartial?.(assemble());
  }));
  const landedCount = landed.filter((part) => part !== undefined).length;
  // EVERY planned section must land — assembling a subset would silently ship
  // an app missing a region the user asked for (Devin review, PR #417). The
  // single-stream fallback still produces the complete app, so falling back
  // here never blocks and never drops content.
  if (landedCount !== outline.sections.length) {
    return finish({ fallback: "sections-failed", sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
  }
  const compiled = compileWireV2(assemble(), {
    hostComponents: [...context.hostComponents],
    ...(context.deps.toolShapes === undefined ? {} : { toolShapes: context.deps.toolShapes }),
  });
  const validated = await context.validate(compiled);
  if (validated.document !== undefined) {
    return finish({ document: validated.document, sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
  }
  if (context.deps.pipeline?.structuredRepair !== false) {
    const repaired = await structuredRepair(compiled, hooks.userRequest, context);
    if (repaired.document !== undefined) {
      return finish({ document: repaired.document, sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
    }
  }
  return finish({ fallback: "assembly-invalid", sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
};
