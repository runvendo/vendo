import { promises as fs } from "node:fs";
import YAML from "yaml";
import { annotationsFor, type HttpMethod, type ManifestTool } from "./manifest.js";

type JsonObj = Record<string, unknown>;
// The frozen http binding has no HEAD; HEAD operations are not extracted.
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export async function convertOpenApi(specPath: string): Promise<ManifestTool[]> {
  const raw = await fs.readFile(specPath, "utf8");
  const doc = (specPath.endsWith(".yaml") || specPath.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw)) as JsonObj;
  const paths = (doc["paths"] ?? {}) as Record<string, JsonObj>;
  const tools: ManifestTool[] = [];

  for (const [route, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item[method] as JsonObj | undefined;
      if (!op) continue;
      const name = toolName(op, method, route);
      const description =
        [op["summary"], op["description"]].filter((s) => typeof s === "string" && s.length > 0).join(". ") ||
        `${method.toUpperCase()} ${route}`;
      tools.push({
        name,
        description,
        inputSchema: buildInputSchema(doc, item, op),
        annotations: annotationsFor(method, name, "openapi"),
        binding: { type: "http", method: method.toUpperCase() as HttpMethod, path: route },
      });
    }
  }
  return tools;
}

function toolName(op: JsonObj, method: string, route: string): string {
  const opId = op["operationId"];
  if (typeof opId === "string" && opId.length > 0) return snake(opId);
  const segs = route
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? `by_${s.slice(1, -1)}` : s));
  return snake([method, ...segs].join("_"));
}

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** Resolve local #/... $refs (cycle-guarded); leave external refs untouched. */
export function resolveRefs(doc: JsonObj, node: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(doc, n, seen));
  if (node === null || typeof node !== "object") return node;
  const obj = node as JsonObj;
  const ref = obj["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.has(ref)) return { $ref: ref }; // cycle — leave as-is
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((acc, k) => (acc as JsonObj | undefined)?.[k], doc);
    return resolveRefs(doc, target, new Set([...seen, ref]));
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(doc, v, seen)]));
}

/**
 * Input schema convention (documented in .flowlet/README.md, pending
 * contracts-freeze): path+query params become top-level properties; a JSON
 * requestBody becomes a `body` property.
 */
function buildInputSchema(doc: JsonObj, pathItem: JsonObj, op: JsonObj): JsonObj {
  const properties: JsonObj = {};
  const required: string[] = [];
  const params = [
    ...((pathItem["parameters"] as JsonObj[] | undefined) ?? []),
    ...((op["parameters"] as JsonObj[] | undefined) ?? []),
  ].map((p) => resolveRefs(doc, p) as JsonObj);
  for (const p of params) {
    const pname = p["name"];
    if (typeof pname !== "string") continue;
    const schema = (p["schema"] as JsonObj | undefined) ?? { type: "string" };
    properties[pname] = { ...schema, ...(typeof p["description"] === "string" ? { description: p["description"] } : {}) };
    if (p["required"] === true) required.push(pname);
  }
  const body = ((op["requestBody"] as JsonObj | undefined)?.["content"] as JsonObj | undefined)?.[
    "application/json"
  ] as JsonObj | undefined;
  if (body?.["schema"]) {
    properties["body"] = resolveRefs(doc, body["schema"]) as JsonObj;
    required.push("body");
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}
