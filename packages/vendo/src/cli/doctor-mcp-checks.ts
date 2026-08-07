import { join } from "node:path";
import type { DoctorErrorCode } from "./doctor-codes.js";
import type { DoctorRun } from "./doctor-report.js";
import { remoteUrls, sameUrl, validateRegistryServer } from "./mcp/registry.js";
import { readOptional } from "./shared.js";

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
