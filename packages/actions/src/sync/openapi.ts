import { promises as fs } from "node:fs";
import YAML from "yaml";
import type { ExtractedTool, HttpMethod, SchemaSource } from "../formats.js";
import { extractedRisk, routeToolFullName } from "./common.js";

type JsonObject = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

/** Resolve cycle-guarded local JSON Pointer refs. External refs remain intact. */
function resolveRefs(document: JsonObject, node: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map((value) => resolveRefs(document, value, seen));
  if (node === null || typeof node !== "object") return node;
  const object = node as JsonObject;
  const ref = object.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.has(ref)) return { $ref: ref };
    const target = ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<unknown>((current, key) => jsonObject(current)[key], document);
    return resolveRefs(document, target, new Set([...seen, ref]));
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, resolveRefs(document, value, seen)]),
  );
}

function inputSchema(document: JsonObject, rawPathItem: JsonObject, rawOperation: JsonObject): JsonObject {
  const pathItem = resolveRefs(document, rawPathItem) as JsonObject;
  const operation = resolveRefs(document, rawOperation) as JsonObject;
  const properties: JsonObject = {};
  const required = new Set<string>();
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  for (const rawParameter of parameters) {
    const parameter = jsonObject(resolveRefs(document, rawParameter));
    const name = parameter.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (parameter.in !== undefined && parameter.in !== "path" && parameter.in !== "query") continue;
    const schema = jsonObject(resolveRefs(document, parameter.schema ?? { type: "string" }));
    properties[name] = {
      ...schema,
      ...(typeof parameter.description === "string" ? { description: parameter.description } : {}),
    };
    if (parameter.required === true) required.add(name);
  }

  const requestBody = jsonObject(resolveRefs(document, operation.requestBody));
  const content = jsonObject(requestBody.content);
  const jsonContent = jsonObject(content["application/json"]);
  if (jsonContent.schema !== undefined) {
    properties.body = resolveRefs(document, jsonContent.schema) as JsonObject;
    if (requestBody.required === true) required.add("body");
  }
  return {
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  };
}

/**
 * The operation's declared JSON response body, from the first 2xx response
 * that carries an `application/json` schema. Recorded as the tool's
 * `outputSchema` so the host's own contract — envelope included — is machine
 * readable instead of guessed (live 2026-07-27: a `{ data: [...] }` envelope
 * with no recorded output schema had the model binding an array prop to the
 * wrapper object). Undefined when the spec declares no response schema:
 * extraction never invents one.
 */
function outputSchema(document: JsonObject, operation: JsonObject): JsonObject | undefined {
  const responses = jsonObject(operation.responses);
  for (const status of Object.keys(responses).filter((code) => /^2\d\d$/.test(code)).sort()) {
    const response = jsonObject(resolveRefs(document, responses[status]));
    const schema = jsonObject(jsonObject(response.content)["application/json"]).schema;
    if (schema !== undefined) return resolveRefs(document, schema) as JsonObject;
  }
  return undefined;
}

function sanitizedOperationName(operationId: string): string {
  return `host_${operationId.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_")}`;
}

function absoluteBaseUrl(document: JsonObject): string | undefined {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const url = jsonObject(servers[0]).url;
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function descriptionFor(operation: JsonObject, method: HttpMethod, route: string): string {
  const parts = [operation.summary, operation.description]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length > 0 ? parts.join(". ") : `${method} ${route}`;
}

async function readDocument(specPath: string): Promise<JsonObject> {
  const raw = await fs.readFile(specPath, "utf8");
  const parsed = specPath.endsWith(".yaml") || specPath.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw);
  return jsonObject(parsed);
}

/**
 * The mount point a RELATIVE `servers[0].url` declares — `"/cadence"` for a host
 * served in place at `demos.vendo.run/cadence` — or "" for a host at the origin
 * root. `"/"`, an absent `servers`, and an absolute url all mean "" (an absolute
 * url carries its own path on `binding.baseUrl` instead), so every spec that
 * does not opt in is untouched.
 *
 * Read here and applied by the caller across ALL extractors, not folded into the
 * bindings below: see `runExtractors`.
 */
export async function openApiMountPath(specPath: string): Promise<string> {
  const servers = (await readDocument(specPath)).servers;
  const url = jsonObject((Array.isArray(servers) ? servers : [])[0]).url;
  if (typeof url !== "string" || !url.startsWith("/")) return "";
  return url.replace(/\/+$/u, "");
}

export async function extractOpenApi(specPath: string): Promise<ExtractedTool[]> {
  const document = await readDocument(specPath);
  const paths = jsonObject(document.paths);
  const baseUrl = absoluteBaseUrl(document);
  const tools: ExtractedTool[] = [];

  for (const [route, rawPathItem] of Object.entries(paths)) {
    const pathItem = jsonObject(rawPathItem);
    for (const lowerMethod of METHODS) {
      const rawOperation = pathItem[lowerMethod];
      if (rawOperation === null || typeof rawOperation !== "object" || Array.isArray(rawOperation)) continue;
      const operation = resolveRefs(document, rawOperation) as JsonObject;
      const method = lowerMethod.toUpperCase() as HttpMethod;
      const rawOperationId = typeof operation.operationId === "string" && operation.operationId.trim().length > 0
        ? operation.operationId.trim()
        : null;
      const name = rawOperationId ? sanitizedOperationName(rawOperationId) : routeToolFullName(method, route);
      const operationId = rawOperationId ?? name;
      const output = outputSchema(document, operation);
      tools.push({
        name,
        description: descriptionFor(operation, method, route),
        inputSchema: inputSchema(document, pathItem, operation),
        // A spec that declares no parameters HAS declared the argument list:
        // an empty one. That is what stops the AI judge touching this slot.
        inputSchemaSource: "declared" satisfies SchemaSource,
        ...(output === undefined
          ? { outputSchemaSource: "unknown" satisfies SchemaSource }
          : { outputSchema: output, outputSchemaSource: "declared" satisfies SchemaSource }),
        risk: extractedRisk(method),
        binding: {
          kind: "openapi",
          operationId,
          ...(baseUrl ? { baseUrl } : {}),
          method,
          path: route,
        },
      });
    }
  }
  return tools;
}
