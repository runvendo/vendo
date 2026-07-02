/**
 * Host-API tool contract (ENG-202): turn the company's OWN API surface into
 * agent tool definitions, and execute those calls on the user's existing
 * session. One concept regardless of transport — this module is the
 * OpenAPI/REST adapter; CLI/SDK/MCP adapters share the same definition shape.
 *
 * Host-agnostic and isomorphic on purpose:
 * - The server (agent runtime) consumes definitions to register no-execute,
 *   policy-governed tools.
 * - The browser (SDK) consumes the same definitions to execute approved calls
 *   via `executeHostToolCall` with the user's credentials (topology B: the
 *   call never transits Flowlet; only the tool result enters the loop).
 */

/** Standard MCP-style annotation hints, mirrored by the policy layer. */
export interface HostToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Where an operation parameter is carried on the wire. */
export interface HostToolParam {
  name: string;
  in: "path" | "query";
  required: boolean;
}

/** The HTTP call behind a host tool. */
export interface HostHttpCall {
  method: "get" | "post" | "put" | "patch" | "delete" | "head";
  /** OpenAPI-style path template, e.g. `/api/accounts/{id}`. */
  path: string;
  params: HostToolParam[];
  /** Whether the tool input carries a JSON request body under `body`. */
  hasBody: boolean;
}

/**
 * One host-API operation as an agent tool: name + description for the model,
 * a flat JSON-Schema input (params top-level, request body under `body`),
 * annotations for the policy layer, and the HTTP metadata the executor needs.
 */
export interface HostToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool input. */
  inputSchema: Record<string, unknown>;
  annotations: HostToolAnnotations;
  http: HostHttpCall;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

/**
 * Host-relative path guard, identical to the frozen manifest contract
 * (`httpBindingSchema` in `manifest/tool.ts`): a single leading `/`, no
 * `//authority`, no whitespace — a spec or manifest path can never point the
 * client executor at a foreign origin.
 */
const HOST_RELATIVE_PATH = /^\/(?!\/)\S*$/;

/** Loose structural view of the OpenAPI bits the adapter reads. */
interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ReadonlyArray<OpenApiParameter>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  "x-flowlet-dangerous"?: boolean;
}

export interface OpenApiSpec {
  paths?: Record<string, unknown>;
}

/** `get` + `/api/accounts/{id}` → `get_api_accounts_id`. */
function deriveName(method: string, path: string): string {
  const cleaned = `${method}_${path}`
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned;
}

function annotationsFor(method: string, op: OpenApiOperation): HostToolAnnotations {
  // Trusts HTTP semantics: a GET that mutates host state (it happens) MUST be
  // marked `x-flowlet-dangerous: true` in the spec, or fixed — the adapter
  // cannot detect it, and read-only tools are auto-allowed by policy.
  const readOnly = method === "get" || method === "head";
  const destructive = method === "delete" || op["x-flowlet-dangerous"] === true;
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    // GET/HEAD/PUT/DELETE are idempotent by HTTP semantics.
    idempotentHint: readOnly || method === "put" || method === "delete",
    // The host API is the company's own closed world.
    openWorldHint: false,
  };
}

/**
 * Convert an OpenAPI (3.x) spec into host tool definitions.
 *
 * Rules:
 * - One tool per path+method; named by `operationId`, else derived from
 *   method + path.
 * - GET/HEAD → read-only (auto-allowed by the annotation policy); other
 *   methods are mutating; DELETE and `x-flowlet-dangerous: true` are
 *   destructive. Unhinted mutations still gate via the policy's fail-safe.
 * - Input schema is flat: path/query params as top-level properties, the JSON
 *   request body under `body` (required iff the spec marks it required).
 *   Schemas are copied as-is — author specs with inline schemas (no $ref).
 */
export function openApiToHostTools(spec: OpenApiSpec): HostToolDefinition[] {
  const defs: HostToolDefinition[] = [];
  for (const [path, rawItem] of Object.entries(spec.paths ?? {})) {
    if (!HOST_RELATIVE_PATH.test(path)) {
      throw new Error(
        `host tool path "${path}" must be host-relative (single leading "/", no authority, no whitespace)`,
      );
    }
    const item = (rawItem ?? {}) as Record<string, unknown>;
    // Path-item-level parameters apply to every operation on the path;
    // an operation-level parameter with the same (name, in) overrides.
    const pathParams = (item["parameters"] ?? []) as ReadonlyArray<OpenApiParameter>;
    for (const method of HTTP_METHODS) {
      const op = item[method] as OpenApiOperation | undefined;
      if (op == null) continue;

      const name = op.operationId ?? deriveName(method, path);
      const params: HostToolParam[] = [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      const merged = [...pathParams];
      for (const opParam of op.parameters ?? []) {
        const index = merged.findIndex(
          (p) => p.name === opParam.name && p.in === opParam.in,
        );
        if (index >= 0) merged[index] = opParam;
        else merged.push(opParam);
      }

      for (const param of merged) {
        if (param.in !== "path" && param.in !== "query") continue;
        if (param.name === "body") {
          throw new Error(
            `host tool "${name}": parameter name "body" collides with the request-body slot`,
          );
        }
        params.push({
          name: param.name,
          in: param.in,
          required: param.required === true,
        });
        properties[param.name] = {
          ...(param.schema ?? {}),
          ...(param.description ? { description: param.description } : {}),
        };
        if (param.required === true) required.push(param.name);
      }

      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const hasBody = bodySchema != null;
      if (hasBody) {
        properties["body"] = bodySchema;
        if (op.requestBody?.required === true) required.push("body");
      }

      defs.push({
        name,
        description: op.summary ?? op.description ?? name,
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
        annotations: annotationsFor(method, op),
        http: { method, path, params, hasBody },
      });
    }
  }
  return defs;
}

/** Result of a host-API call: HTTP errors are data, not exceptions. */
export interface HostToolCallResult {
  status: number;
  ok: boolean;
  data: unknown;
}

export interface ExecuteHostToolCallOptions {
  /** Injectable for tests / non-window environments. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Origin prefix for the host API; defaults to same-origin relative paths. */
  baseUrl?: string;
}

/**
 * Execute one host tool call in the CURRENT environment's session — in the
 * browser this rides the user's own cookies (`credentials: "include"`), which
 * is the whole point: the agent acts as the user, on the host's existing
 * security layer. Non-2xx responses are returned as structured data so the
 * model can react; only transport failures throw.
 */
export async function executeHostToolCall(
  def: HostToolDefinition,
  input: Record<string, unknown>,
  options: ExecuteHostToolCallOptions = {},
): Promise<HostToolCallResult> {
  const { baseUrl = "", fetchImpl = fetch } = options;

  // Same guard as the adapter and the frozen manifest contract — enforced at
  // execution too, because definitions can arrive from outside the adapter.
  if (!HOST_RELATIVE_PATH.test(def.http.path)) {
    throw new Error(
      `host tool "${def.name}": path "${def.http.path}" is not host-relative`,
    );
  }

  // Fail before fetching if any schema-required input is absent (covers path
  // params, required query params, and a required request body — executing a
  // write with host-side defaults instead of the declared body is never OK).
  const requiredInputs = Array.isArray(def.inputSchema["required"])
    ? (def.inputSchema["required"] as string[])
    : [];
  const missing = requiredInputs.filter(
    (key) => input[key] === undefined || input[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `host tool "${def.name}": missing required input ${missing.map((k) => `"${k}"`).join(", ")}`,
    );
  }

  let path = def.http.path;
  const query = new URLSearchParams();
  for (const param of def.http.params) {
    const value = input[param.name];
    if (param.in === "path") {
      if (value === undefined || value === null) {
        throw new Error(`host tool "${def.name}": missing path parameter "${param.name}"`);
      }
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    } else if (value !== undefined && value !== null) {
      query.set(param.name, String(value));
    }
  }

  // Note: not URLSearchParams.size — it is missing in Safari < 17, and this
  // runs in the user's browser.
  const queryString = query.toString();
  const url = `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
  const body = def.http.hasBody && input["body"] !== undefined
    ? JSON.stringify(input["body"])
    : undefined;

  const response = await fetchImpl(url, {
    method: def.http.method.toUpperCase(),
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body,
  });

  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON — return the raw text.
  }
  return { status: response.status, ok: response.ok, data };
}
