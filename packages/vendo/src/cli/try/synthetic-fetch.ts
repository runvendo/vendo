import type { ExtractedTool } from "@vendoai/actions";
import type { FixturesFile } from "./profile.js";

/**
 * The try surface's host-API stand-in (unified try surface, Task 4): a
 * `typeof fetch` answering route-tool requests from the seeds pass's synthetic
 * fixtures instead of the host's not-running API. Task 5's `npx vendo try`
 * threads it into `createVendo({ fetch })`, so the actions runtime issues its
 * host requests exactly as always and this function answers them all — a pure
 * function of its inputs that NEVER performs real network I/O.
 *
 * Matching inverts how the actions runtime builds route/openapi requests
 * (registry.ts executeHost): the binding's `{param}` path template gets its
 * params substituted with `encodeURIComponent(...)` and joins the configured
 * base URL, so a request matches a tool when the method equals the binding's
 * and every path segment equals the template's — a `{param}` template segment
 * matching any one (decoded) segment. Overlapping templates resolve by
 * specificity: the template binding the fewest `{param}` segments wins, so
 * `GET /api/users/{id}` can never shadow `GET /api/users/me`. Bindings without
 * a method+path shape (trpc, graphql, server-action) never match here.
 * Documented gap: an array-valued path param (withPathArgs joins arrays into
 * MULTIPLE segments) never survives the segment-count check — such a request
 * answers the honest 404 below rather than a wrong fixture.
 *
 * The response contract — every match answers 200 application/json:
 * - GET matching a tool WITH fixture rows → the rows array; a path that binds
 *   a `{param}` is single-item shaped, so the first row alone.
 * - GET matching a tool WITHOUT fixture rows → `[]`.
 * - Non-GET (write-shaped) matching a tool → `{ ok: true, synthetic: true }`
 *   merged with the parsed JSON request body echoed back, so a demo write
 *   looks like it succeeded.
 * - No tool matches → 404 with a small JSON error naming the method + path —
 *   honest, never a silent success.
 */

interface SyntheticRoute {
  tool: ExtractedTool;
  method: string;
  /** The binding's path template, split into segments. */
  segments: string[];
  /** How many `{param}` segments the template binds; >0 = single-item shape. */
  paramCount: number;
}

const isParamSegment = (segment: string): boolean => segment.startsWith("{") && segment.endsWith("}");

function syntheticRoutes(tools: ExtractedTool[]): SyntheticRoute[] {
  const routes: SyntheticRoute[] = [];
  for (const tool of tools) {
    const binding = tool.binding;
    if (binding.kind !== "route" && binding.kind !== "openapi") continue;
    const segments = binding.path.split("/").filter((segment) => segment !== "");
    routes.push({
      tool,
      // Normalized like the incoming method below, so a lax lowercase binding
      // can't silently never-match.
      method: binding.method.toUpperCase(),
      segments,
      paramCount: segments.filter(isParamSegment).length,
    });
  }
  // Specificity precedence: fewer bound params match first (stable, so ties
  // keep tools.json order) — a static /me is never shadowed by /{id}.
  return routes.sort((a, b) => a.paramCount - b.paramCount);
}

/** executeHost encodes each substituted `{param}` with encodeURIComponent, so
 *  the inverse decodes each incoming segment (fail-soft on stray `%`). */
function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment !== "").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function matchesTemplate(template: string[], actual: string[]): boolean {
  return template.length === actual.length
    && template.every((segment, index) => isParamSegment(segment) || segment === actual[index]);
}

/** The JSON request body as an echoable object; anything else — absent,
 *  unparseable, non-object — degrades to `{}` (the bare success marker). */
async function echoableBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const text = typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.text()
        : undefined;
    if (text === undefined || text === "") return {};
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createSyntheticFetch(options: { tools: ExtractedTool[]; fixtures: FixturesFile }): typeof fetch {
  const routes = syntheticRoutes(options.tools);
  const rowsByTool = options.fixtures.fixtures;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const segments = pathSegments(url.pathname);
    const route = routes.find((candidate) => candidate.method === method && matchesTemplate(candidate.segments, segments));
    if (route === undefined) {
      return jsonResponse({ error: `no synthetic route for ${method} ${url.pathname}` }, 404);
    }
    if (method === "GET") {
      const rows = rowsByTool[route.tool.name] ?? [];
      return jsonResponse(route.paramCount > 0 && rows.length > 0 ? rows[0] : rows);
    }
    return jsonResponse({ ok: true, synthetic: true, ...await echoableBody(input, init) });
  };
}
