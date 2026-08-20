import { join } from "node:path";
import type { DoctorRun } from "./doctor-report.js";
import { validateRegistryServer } from "./mcp/registry.js";
import { readOptional } from "./shared.js";

/** Where a Vendo composition lives: the composition module init writes today
    (`lib/vendo.ts`, under `src/` when the app directory is), the two earlier
    shapes still in the field (the MCP path's split `vendo.ts` beside the route,
    the ordinary inline route) and the runtime-neutral / Express module, under
    both root layouts. The current shape leads and every legacy one stays, the
    same order `compositionOf` reads them in (doctor-wiring-checks.ts) — a list
    that knows only the old locations goes SILENT on a correctly wired host,
    which is exactly what this check exists to catch. A host that opened the
    door somewhere else entirely is not named here on purpose — E-MCP-009 is a
    hard FAIL, so it fires on evidence, never on a guess. */
const COMPOSITION_PATHS: readonly string[][] = [
  ["lib", "vendo.ts"],
  ["src", "lib", "vendo.ts"],
  ["app", "api", "vendo", "[...vendo]", "vendo.ts"],
  ["src", "app", "api", "vendo", "[...vendo]", "vendo.ts"],
  ["app", "api", "vendo", "[...vendo]", "route.ts"],
  ["src", "app", "api", "vendo", "[...vendo]", "route.ts"],
  ["vendo", "server.ts"],
  ["src", "vendo", "server.ts"],
  ["vendo", "server.mjs"],
  ["src", "vendo", "server.mjs"],
];

/**
 * The `mcp: { … }` object with every NESTED object and array removed, so a
 * top-level key can be matched without a nested one shadowing it. Null when
 * `mcp` is absent or is the boolean form.
 *
 * Balanced braces, not a character class: `[^}]*` cannot cross a closing brace,
 * so it stopped at the first nested option's `}` and never reached a `baseUrl`
 * declared after it. `serviceAuth`, `remoteAs` and `federation` all nest — and
 * the local service-key path scaffolds one — so the old scan hard-failed
 * E-MCP-009 on a correctly configured deployment purely because of the order
 * the author wrote their properties in.
 */
function mcpObjectTopLevel(code: string): string | null {
  const opened = /\bmcp\s*:\s*\{/.exec(code);
  if (opened === null) return null;
  let depth = 0;
  let top = "";
  // Start ON the opening brace so the first step takes depth to 1.
  for (let index = opened.index + opened[0].length - 1; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (depth === 1) top += char;
    if (depth === 0) return top;
  }
  return top;
}

/** Does this composition open the MCP door, and does it name its own public
    base URL while doing it? `mcp: { baseUrl }` is host config that beats the
    environment default, so a composition carrying one needs no variable. */
function mcpComposition(source: string): { wired: boolean; baseUrl: boolean } {
  // A line comment is `//` that is NOT the `//` in a URL scheme. Stripping every
  // `//` truncated the line at the first `https://` — which both hid a `baseUrl`
  // written after one and left the braces unbalanced for the walk below, failing
  // E-MCP-009 on a correct composition. Every value this checker reads is a URL.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return {
    wired: /\bcreateVendo\s*\(/.test(code) && /(^|[\s{,])mcp\s*:/.test(code),
    baseUrl: /\bbaseUrl\s*:/.test(mcpObjectTopLevel(code) ?? ""),
  };
}

/** Every composition on disk, graded. */
async function mcpCompositions(root: string): Promise<Array<{ wired: boolean; baseUrl: boolean }>> {
  const sources = await Promise.all(
    COMPOSITION_PATHS.map((segments) => readOptional(join(root, ...segments))),
  );
  return sources.filter((source) => source !== null).map(mcpComposition);
}

/**
 * E-MCP-009 — an MCP-wired host that never set `VENDO_BASE_URL`.
 *
 * A FAILURE, not a warning. The door's discovery documents, its issuer, its
 * resource identifiers and its RFC 8707 audience binding all derive from that
 * one value; without it the door advertises whatever origin the request
 * happened to carry. Nothing is red at install time — it surfaces hours later,
 * in someone else's terminal, as "Claude can't find my server". This is the
 * static half, so it runs with no dev server and no network.
 */
export async function checkMcpBaseUrl(run: DoctorRun): Promise<void> {
  const { root, env } = run;
  const compositions = await mcpCompositions(root);
  if (!compositions.some((composition) => composition.wired)) return;
  if (compositions.some((composition) => composition.wired && composition.baseUrl)) {
    run.pass("mcp/base-url", "the MCP door's public base URL is set in the composition (mcp.baseUrl)");
  } else if ((env.VENDO_BASE_URL ?? "") !== "") {
    run.pass("mcp/base-url", "VENDO_BASE_URL is set — the MCP door's discovery advertises the right origin");
  } else {
    run.fail("mcp/base-url", "E-MCP-009",
      "the MCP door is wired but VENDO_BASE_URL is not set — discovery, the issuer and the token audience all derive "
      + "from it, so the door advertises whatever origin a request happens to carry and outside agents are pointed at "
      + "the wrong server (it surfaces later as \"Claude can't find my server\"). Set VENDO_BASE_URL to this "
      + "deployment's public origin where you deploy, or pass mcp: { baseUrl } in the composition.");
  }
}

/**
 * E-MCP-010 — the dev sign-in key, found on a deployment.
 *
 * `vendo init` writes VENDO_SERVICE_KEY into `.env.local`, which is dev-only
 * and gitignored, so the pin that keeps sign-in on the developer's own machine
 * cannot ride to production through git. It can still get there by hand: a
 * copied env file, a platform variable pasted out of a dev shell. An explicit
 * `serviceAuth` is itself a local authorization-server choice, so it outranks
 * the Cloud key sitting beside it (compose-mcp.ts's `declaredBrokerage`) and
 * the deployment quietly serves its own OAuth instead of the broker its key
 * already pays for — nothing is broken, so nothing says so.
 *
 * A WARNING, never a failure: running your own door on a Cloud-keyed
 * deployment is a legitimate choice, and doctor does not know which one this
 * is. Both keys and an https origin, or it stays silent: an http origin is
 * somebody's dev machine, where the local door is the point.
 */
export async function checkMcpSignInKeys(run: DoctorRun): Promise<void> {
  const { env } = run;
  const set = (name: string): boolean => (env[name] ?? "").trim() !== "";
  if (!set("VENDO_SERVICE_KEY") || !set("VENDO_API_KEY")) return;
  if (!(env.VENDO_BASE_URL ?? "").trim().startsWith("https://")) return;
  if (!(await mcpCompositions(run.root)).some((composition) => composition.wired)) return;
  run.warn("mcp/sign-in-keys", "E-MCP-010",
    "dev sign-in key found alongside a Cloud key on an https deployment — delete VENDO_SERVICE_KEY to use the Cloud broker.");
}

/** 10-mcp §5 — the official registry artifacts a published host keeps on disk.
 *  Absent files say nothing: `server.json` arrives only once a host publishes,
 *  and the HTTP challenge file only when the registry verifies by URL rather
 *  than DNS. Present ones must parse.
 *
 *  `server.json` is graded only on the same MCP evidence E-MCP-009 fires on.
 *  The name is generic, and the fetched half reached this check only once a
 *  live door reported an MCP posture — so grading every root's `server.json`
 *  failed doctor on unrelated application config, over registry metadata the
 *  project never had. The challenge file needs no such gate: nothing but the
 *  registry writes `public/.well-known/mcp-registry-auth`. */
export async function checkMcpArtifacts(run: DoctorRun): Promise<void> {
  const wired = (await mcpCompositions(run.root)).some((composition) => composition.wired);
  const serverJson = wired ? await readOptional(join(run.root, "server.json")) : null;
  if (serverJson !== null) {
    try {
      const errors = validateRegistryServer(JSON.parse(serverJson) as unknown);
      if (errors.length === 0) run.pass("mcp/server-json", "server.json matches MCP registry discovery requirements");
      else run.fail("mcp/server-json", "E-MCP-004", `server.json is invalid: ${errors.join("; ")}`);
    } catch {
      run.fail("mcp/server-json", "E-MCP-006", "server.json is invalid JSON");
    }
  }
  const challenge = await readOptional(join(run.root, "public", ".well-known", "mcp-registry-auth"));
  if (challenge === null) return;
  if (challenge.trim().startsWith("v=MCPv1")) run.pass("mcp/registry-auth-local", "local MCP registry auth challenge parses");
  else run.fail("mcp/registry-auth-local", "E-MCP-007", "local MCP registry auth challenge must start with v=MCPv1");
}
