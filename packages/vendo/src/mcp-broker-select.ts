/** ADAPTER RULE, mcp seam (cloned from selectConnections in server.ts): which
    authorization surface fronts the MCP door is decided at the composition
    seam — never by a hidden key-conditional inside the door. Precedence, top
    to bottom:
      1. an explicit `mcp.remoteAs` always wins, verbatim — no ensure call;
      2. VENDO_API_KEY plus a PUBLIC base URL make the hosted broker the
         default: an idempotent ensure-tenant call at the composition boundary
         wires `remoteAs` + `federation` from the response;
      3. otherwise today's local door, byte-identical.
    The door itself never reads the environment; this module is PURE (the
    ensure call happens at the seam in server.ts, behind the ready latch). */

export interface McpSeamConfig {
  baseUrl?: string;
  remoteAs?: { issuer: string; jwksUri?: string; audience: string };
  federation?: { secret: string };
}

export type McpBrokerSelection =
  | { mode: "off" }
  | { mode: "explicit" }
  | { mode: "broker"; ensure: { baseUrl: string; mount: string } }
  | { mode: "local" };

/** The frozen localhost rule (plan 2026-08-03-mcp-broker-provisioning): the
    broker cannot forward visitors to a machine the internet cannot reach, so
    the broker default is SKIPPED — silently; doctor explains — when the base
    URL is unset, unparsable, or points at `localhost`, `127.0.0.1` (any
    loopback), `::1`, `*.local`, or an RFC1918 address. Returns the base URL
    when the broker can front it, undefined otherwise. */
export function publicBaseUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  // URL keeps IPv6 hostnames bracketed ("[::1]").
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return undefined;
  if (isPrivateIpv4(host)) return undefined;
  return baseUrl;
}

const isPrivateIpv4 = (host: string): boolean => {
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const numbers = octets.map(Number);
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = numbers as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
};

export function selectMcpBroker(
  mcp: McpSeamConfig | undefined,
  cloud: { apiKey: string } | undefined,
  baseUrl: string | undefined,
  mount: string,
): McpBrokerSelection {
  if (mcp === undefined) return { mode: "off" };
  if (mcp.remoteAs !== undefined) return { mode: "explicit" };
  const ensureBaseUrl = cloud === undefined ? undefined : publicBaseUrl(baseUrl);
  if (ensureBaseUrl === undefined) return { mode: "local" };
  return { mode: "broker", ensure: { baseUrl: ensureBaseUrl, mount } };
}
