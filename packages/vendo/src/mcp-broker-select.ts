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
  const host = normalizeHost(hostname);
  if (host === "" || isPrivateHost(host)) return undefined;
  return baseUrl;
}

/** Canonicalize the spellings URL leaves alone so the checks below see one
    form per host: percent-escapes decoded (URL decodes them for http(s), but
    the rule must not depend on that), EVERY trailing root-label dot off an
    FQDN ("localhost..", however many — one strip per dot is how "localhost.."
    slipped past a single-dot rule), brackets off IPv6 ("[::1]"), and an
    IPv4-mapped IPv6 address — which URL serializes as hex groups
    ("::ffff:7f00:1") — back to its dotted quad. A hostname that cannot be
    decoded, or that normalizes to empty (".."), returns "" — the caller
    treats that as never public. */
const normalizeHost = (hostname: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(hostname);
  } catch {
    return "";
  }
  const host = decoded.replace(/\.+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped === null) return host;
  const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

const isPrivateHost = (host: string): boolean =>
  host === "localhost" || host === "::1" || host.endsWith(".local") || isPrivateIpv4(host);

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
