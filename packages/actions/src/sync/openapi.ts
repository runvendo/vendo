import { promises as fs } from "node:fs";
import YAML from "yaml";
import type { ExtractedTool, HttpMethod } from "../formats.js";
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

export async function extractOpenApi(specPath: string): Promise<ExtractedTool[]> {
  const raw = await fs.readFile(specPath, "utf8");
  const parsed = specPath.endsWith(".yaml") || specPath.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw);
  const document = jsonObject(parsed);
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
      tools.push({
        name,
        description: descriptionFor(operation, method, route),
        inputSchema: inputSchema(document, pathItem, operation),
        risk: extractedRisk(method, name, "openapi"),
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
