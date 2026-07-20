import type { ExtractedTool } from "../formats.js";

/**
 * W3 (v3 spec §Context) — generated "use this when…" tool descriptions.
 * Hosts often leave descriptions empty; the model then has only the tool
 * NAME to pick from (OpenAI's metadata discipline: description quality is
 * selection quality). Sync fills every EMPTY description deterministically
 * from the binding — reviewable in `tools.json`, overridable forever via
 * `overrides.json.tools[name].description`.
 */

const VERB_BY_METHOD: Record<string, string> = {
  GET: "read or list",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

const PARAM_SEGMENT = /^[:[{]/;
const NOISE_SEGMENT = /^(api|v\d+|rest|internal)$/i;
/** A trailing route segment that names an ACTION, not a resource. */
const ACTION_SEGMENT = /^(remind|send|approve|reject|archive|cancel|close|complete|duplicate|export|import|invite|notify|pay|publish|refresh|restore|retry|share|submit|sync|transfer|void)$/i;

const routeDescription = (
  method: string,
  path: string,
): string | undefined => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const resources = segments.filter((segment) => !PARAM_SEGMENT.test(segment) && !NOISE_SEGMENT.test(segment));
  if (resources.length === 0) return undefined;
  const last = resources[resources.length - 1] as string;
  const hasParam = segments.some((segment) => PARAM_SEGMENT.test(segment));
  const suffix = `(${method} ${path})`;
  if (ACTION_SEGMENT.test(last)) {
    const resource = resources.length > 1 ? resources[resources.length - 2] : "the";
    return `Use this to ${last.toLowerCase()} for one ${resource} record ${suffix}.`;
  }
  const verb = VERB_BY_METHOD[method.toUpperCase()] ?? "call";
  if (hasParam && method.toUpperCase() !== "POST") {
    const one = method.toUpperCase() === "GET" ? "read" : verb;
    return `Use this to ${one} one ${last} record ${suffix}.`;
  }
  return `Use this to ${verb} ${last} ${suffix}.`;
};

const NAME_VERB: Record<string, string> = {
  read: "read",
  write: "act on",
  destructive: "delete or destructively change",
};

/** The deterministic description for one extracted tool (empty-description
 *  fill; never replaces host text). */
export const generatedToolDescription = (tool: ExtractedTool): string => {
  const binding = tool.binding as { kind: string; method?: string; path?: string };
  if (binding.kind === "route" && typeof binding.method === "string" && typeof binding.path === "string") {
    const described = routeDescription(binding.method, binding.path);
    if (described !== undefined) return described;
  }
  const tokens = tool.name
    .replace(/^host_/, "")
    .split(/[_.]/)
    .filter((token) => token.length > 0 && !/^(get|post|put|patch|delete)$/i.test(token));
  const verb = NAME_VERB[tool.risk] ?? "use";
  return `Use this to ${verb} ${tokens.join(" ") || tool.name}.`;
};

/** Fill EMPTY descriptions across an extraction; host-authored text and
 *  overrides always win (overrides merge later and replace whatever is here). */
export const withGeneratedDescriptions = (tools: ExtractedTool[]): ExtractedTool[] =>
  tools.map((tool) => tool.description.trim().length > 0
    ? tool
    : { ...tool, description: generatedToolDescription(tool) });
