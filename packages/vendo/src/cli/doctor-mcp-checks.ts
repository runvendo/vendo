import { join } from "node:path";
import type { DoctorErrorCode } from "./doctor-codes.js";
import type { DoctorRun } from "./doctor-report.js";
import { remoteUrls, sameUrl, validateRegistryServer } from "./mcp/registry.js";
import { readOptional } from "./shared.js";

/** Where a Vendo composition lives: the two shapes init writes (the MCP path's
    split `vendo.ts`, the ordinary inline route) and the runtime-neutral /
    Express module, under both root layouts. A host that opened the door
    somewhere else entirely is not named here on purpose — E-MCP-009 is a hard
    FAIL, so it fires on evidence, never on a guess. */
const COMPOSITION_PATHS: readonly string[][] = [
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
  const sources = await Promise.all(
    COMPOSITION_PATHS.map((segments) => readOptional(join(root, ...segments))),
  );
  const compositions = sources.filter((source) => source !== null).map(mcpComposition);
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

/** Fetch a discovery document, grade it, and hand it back so a follow-up check
 *  can read what it advertised. A non-JSON error page still names its status;
 *  only a fetch that never answered is "unreachable". */
type ResolveDocument = (
  id: string,
  code: DoctorErrorCode,
  url: string,
  valid: (body: Record<string, unknown>) => boolean,
  label: string,
) => Promise<Record<string, unknown> | null>;

function documentResolver(run: DoctorRun): ResolveDocument {
  return async (id, code, url, valid, label) => {
    let status: number | undefined;
    try {
      const response = await run.fetchImpl(url, { headers: { accept: "application/json" } });
      status = response.status;
      const body = await response.json() as Record<string, unknown>;
      if (response.ok && valid(body)) { run.pass(id, label); return body; }
      run.fail(id, code, `${label} (${status})`);
    } catch {
      // A non-JSON error page still names its status; only a fetch that
      // never answered is "unreachable".
      if (status === undefined) run.fail(id, code, `${label} is unreachable`);
      else run.fail(id, code, `${label} (${status})`);
    }
    return null;
  };
}

/** Remote-AS posture: the door deliberately 404s its own authorization-
 *  server metadata — an external AS fronts it, named in the protected-
 *  resource document (RFC 9728 §2). The contract still requires BOTH
 *  documents to resolve (10-mcp §5), and the runtime fetches the
 *  EXTERNAL issuer's metadata before it can verify a single token
 *  (remote-as.ts) — so doctor must resolve that document, not re-read
 *  the one it already validated. */
async function checkBrokerAuthorizationServer(
  run: DoctorRun,
  resolves: ResolveDocument,
  resource: Record<string, unknown> | null,
): Promise<void> {
  const servers = resource?.authorization_servers;
  const advertised = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] as string : undefined;
  const parses = (value: string): boolean => { try { new URL(value); return true; } catch { return false; } };
  if (advertised === undefined) {
    run.fail("mcp/authorization-server", "E-MCP-002", "MCP protected-resource metadata does not name the external authorization server fronting the door");
  } else if (!parses(advertised)) {
    run.fail("mcp/authorization-server", "E-MCP-002", `the advertised authorization server "${advertised}" is not a valid URL — the runtime cannot resolve its metadata`);
  } else {
    await resolves(
      "mcp/authorization-server",
      "E-MCP-002",
      `${advertised.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
      (body) => body.issuer === advertised,
      `MCP authorization-server metadata at ${advertised} resolves`,
    );
  }
}

/** 10-mcp §5 — the official registry artifact is optional until a host is
 *  published, but once present it must describe this live door exactly. */
async function checkServerJson(run: DoctorRun, liveDoorUrl: string): Promise<void> {
  const serverJson = await readOptional(join(run.root, "server.json"));
  if (serverJson === null) return;
  try {
    const server = JSON.parse(serverJson) as unknown;
    const errors = validateRegistryServer(server);
    if (errors.length === 0) run.pass("mcp/server-json", "server.json matches MCP registry discovery requirements");
    else run.fail("mcp/server-json", "E-MCP-004", `server.json is invalid: ${errors.join("; ")}`);

    if (remoteUrls(server).some((remote) => sameUrl(remote, liveDoorUrl))) {
      run.pass("mcp/server-json-remote", "server.json remote agrees with the live MCP door");
    } else {
      run.fail("mcp/server-json-remote", "E-MCP-005", `server.json remote does not match the live MCP door ${liveDoorUrl}`);
    }
  } catch {
    run.fail("mcp/server-json", "E-MCP-006", "server.json is invalid JSON");
  }
}

async function checkRegistryAuthChallenge(run: DoctorRun, origin: string): Promise<void> {
  const localChallenge = await readOptional(join(run.root, "public", ".well-known", "mcp-registry-auth"));
  if (localChallenge !== null) {
    if (localChallenge.trim().startsWith("v=MCPv1")) run.pass("mcp/registry-auth-local", "local MCP registry auth challenge parses");
    else run.fail("mcp/registry-auth-local", "E-MCP-007", "local MCP registry auth challenge must start with v=MCPv1");
  }
  try {
    const response = await run.fetchImpl(`${origin}/.well-known/mcp-registry-auth`, {
      headers: { accept: "text/plain" },
    });
    if (response.ok) {
      const challenge = await response.text();
      if (challenge.trim().startsWith("v=MCPv1")) run.pass("mcp/registry-auth-live", "MCP registry auth challenge parses");
      else run.fail("mcp/registry-auth-live", "E-MCP-008", "MCP registry auth challenge must start with v=MCPv1");
    }
  } catch {
    // The HTTP proof is optional; DNS verification may be in use instead.
  }
}

/** 10-mcp §5 — when the door is open, verify both discovery documents resolve
 *  and the server card parses. The metadata is path-inserted (RFC 9728 §3): a
 *  door mounted at /api/vendo/mcp serves /.well-known/...-resource/api/vendo/mcp. */
export async function checkMcpDiscovery(run: DoctorRun, mcpPosture: "local" | "broker"): Promise<void> {
  // Which mode is this door in? Broker mode is DECLARED, so the answer is a
  // composition fact worth printing rather than inferring from the checks.
  run.note(mcpPosture === "broker"
    ? "MCP door mode: broker — an external authorization server fronts it (VENDO_MCP_BROKER_URL, or mcp.remoteAs)"
    : "MCP door mode: local — the door serves its own OAuth surface (set VENDO_MCP_BROKER_URL to front it with a broker)");
  const origin = new URL(run.statusUrl).origin;
  const mountPath = `${new URL(run.statusUrl).pathname.replace(/\/$/, "")}/mcp`;
  const resolves = documentResolver(run);
  const resource = await resolves(
    "mcp/protected-resource",
    "E-MCP-001",
    `${origin}/.well-known/oauth-protected-resource${mountPath}`,
    (body) => typeof body.resource === "string",
    "MCP protected-resource metadata resolves",
  );
  if (mcpPosture === "broker") {
    await checkBrokerAuthorizationServer(run, resolves, resource);
  } else {
    await resolves(
      "mcp/authorization-server",
      "E-MCP-002",
      `${origin}/.well-known/oauth-authorization-server${mountPath}`,
      (body) => typeof body.issuer === "string",
      "MCP authorization-server metadata resolves",
    );
  }
  await resolves(
    "mcp/server-card",
    "E-MCP-003",
    `${origin}/.well-known/mcp/server-card.json`,
    (body) => typeof body.name === "string" && Array.isArray(body.transports),
    "MCP server card parses",
  );

  await checkServerJson(run, `${origin}${mountPath}`);
  await checkRegistryAuthChallenge(run, origin);
}
