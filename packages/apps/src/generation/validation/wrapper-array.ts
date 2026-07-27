/**
 * The wrapper-envelope rebind (live 2026-07-27, the Maple donut): a host prop
 * declared `type: "array"` bound to a tool field that is an OBJECT holding
 * exactly ONE array — the `{ data: [...] }` envelope a REST host returns.
 *
 * That binding is one hop short, not wrong: the array the prop needs is the
 * object's only array. Validation rejects it (validate.ts, "expected an
 * array, the bound field is object") and — because a kind mismatch is not a
 * compile binding error — the closed fix space is empty, so the whole app was
 * regenerated. Repair repoints the binding instead (stages/repair.ts).
 *
 * Ambiguity is never guessed: an object with zero or 2+ top-level array
 * fields keeps today's behavior (the issue stands and the normal ladder runs).
 */
import {
  isPathBinding,
  shapeAtPointer,
  type ShapeType,
  type WireCompileResult,
} from "@vendoai/core";
import type { GenerationDependencies } from "../engine.js";

/** One repointing: the same node/prop, one hop deeper into the envelope. */
export interface WrapperArrayRebind {
  nodeId: string;
  prop: string;
  from: string;
  to: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object shape's ONE top-level array field, or undefined when it holds
 *  none or several — the ambiguous cases this never guesses at. */
const soleArrayField = (shape: ShapeType): string | undefined => {
  if (shape.kind !== "object") return undefined;
  const arrays = Object.keys(shape.fields).filter((field) => shape.fields[field]?.kind === "array");
  return arrays.length === 1 ? arrays[0] : undefined;
};

const encodePointerToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

/** Every array-prop binding in the compiled tree that landed on a
 *  single-array wrapper object, with the nested path it should carry. Only
 *  RAW whole-prop bindings on host nodes qualify: a `$reshape` changes the
 *  delivered kind, so its mismatch is a different failure. */
export const wrapperArrayRebinds = (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
): WrapperArrayRebind[] => {
  if (deps.toolShapes === undefined) return [];
  const rebinds: WrapperArrayRebind[] = [];
  const queryTool = new Map((compiled.tree.queries ?? []).map((query) => [query.name, query.tool]));
  const hostSchemas = new Map(deps.catalog.map((component) => [component.name, component.propsJsonSchema]));
  for (const node of compiled.tree.nodes) {
    if (node.source !== "host" || node.props === undefined) continue;
    const schema = hostSchemas.get(node.component);
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
    if (properties === undefined) continue;
    for (const [prop, value] of Object.entries(node.props)) {
      if (!isPathBinding(value)) continue;
      if ("$reshape" in (value as unknown as Record<string, unknown>)) continue;
      const propSchema = properties[prop];
      if (!isRecord(propSchema) || propSchema.type !== "array") continue;
      const [, queryName = "", ...rest] = value.$path.split("/");
      const tool = queryTool.get(queryName);
      const toolShape = tool === undefined ? undefined : deps.toolShapes[tool];
      if (toolShape === undefined) continue;
      const bound = shapeAtPointer(toolShape, rest.length === 0 ? "" : `/${rest.join("/")}`);
      if (bound === undefined) continue;
      const field = soleArrayField(bound);
      if (field === undefined) continue;
      rebinds.push({
        nodeId: node.id,
        prop,
        from: value.$path,
        to: `${value.$path}/${encodePointerToken(field)}`,
      });
    }
  }
  return rebinds;
};
