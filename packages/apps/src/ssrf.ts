/**
 * ENG-259 — Vendo-side SSRF / private-address egress guard.
 *
 * A reusable, platform-neutral primitive: it classifies IP literals with pure
 * arithmetic and resolves hostnames through an injectable resolver, so the same
 * code runs in a unit test (fake resolver) and in production (node:dns). It is
 * consumed by the apps egress proxy (proxy.ts); actions' registry.ts resolveUrl
 * can adopt it once this primitive is relocated to core (a core-additive
 * follow-up — actions may only import core, never apps).
 *
 * Fail-closed: an unparseable address, an empty DNS answer, or an unavailable
 * resolver all deny egress. DNS resolution happens against the RESOLVED IPs, not
 * the hostname string, which is what makes it resistant to a rebind that points
 * an allowlisted name at a private address.
 */

/** Resolve a hostname to its IP addresses. Injected in tests; node:dns by default. */
export type IpResolver = (hostname: string) => Promise<string[]>;

/** Default resolver: node:dns/promises, imported lazily so edge/Bun bundles stay clean. */
export const nodeIpResolver: IpResolver = async (hostname) => {
  const dns = await import("node:dns/promises");
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

const parseIpv4 = (value: string): number[] | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) return null;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return octets.some((octet) => octet > 255) ? null : octets;
};

const ipv4Blocked = (octets: number[]): boolean => {
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
};

const parseIpv6 = (input: string): Uint8Array | null => {
  let text = input;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  // Embedded IPv4 tail, e.g. ::ffff:1.2.3.4 — fold into two 16-bit groups.
  const embedded = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (embedded !== null) {
    const v4 = parseIpv4(embedded[2] as string);
    if (v4 === null) return null;
    const high = ((v4[0] as number) << 8) | (v4[1] as number);
    const low = ((v4[2] as number) << 8) | (v4[3] as number);
    text = `${embedded[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] as string).split(":")) : null;

  let groups: string[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<string>(missing).fill("0"), ...tail];
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] as string;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
};

const ipv6Blocked = (bytes: Uint8Array): boolean => {
  const allZeroUpTo = (end: number): boolean => bytes.slice(0, end).every((byte) => byte === 0);
  if (allZeroUpTo(16)) return true; // :: unspecified
  if (allZeroUpTo(15) && bytes[15] === 1) return true; // ::1 loopback
  // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96 — classify the inner v4.
  if (allZeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4Blocked([bytes[12] as number, bytes[13] as number, bytes[14] as number, bytes[15] as number]);
  }
  if (allZeroUpTo(12) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 0)) {
    return ipv4Blocked([bytes[12] as number, bytes[13] as number, bytes[14] as number, bytes[15] as number]);
  }
  const first = bytes[0] as number;
  const second = bytes[1] as number;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
};

/** True when an IP literal is loopback, link-local, private, ULA, multicast, or otherwise non-public. Unparseable → blocked. */
export const isBlockedAddress = (address: string): boolean => {
  const v4 = parseIpv4(address);
  if (v4 !== null) return ipv4Blocked(v4);
  const v6 = parseIpv6(address);
  if (v6 !== null) return ipv6Blocked(v6);
  return true; // fail closed on anything we cannot classify
};

const isIpLiteral = (host: string): boolean =>
  parseIpv4(host) !== null || parseIpv6(host) !== null;

/** The outcome of vetting one URL for egress. */
export type EgressUrlCheck =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

/**
 * Vet a URL for outbound egress: http(s) only, no embedded credentials, and every
 * address it resolves to must be public. Call this on the initial URL AND on every
 * redirect Location before following it.
 */
export const checkEgressUrl = async (
  rawUrl: string,
  options: { resolve?: IpResolver } = {},
): Promise<EgressUrlCheck> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported-scheme:${url.protocol}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "userinfo-forbidden" };
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  let addresses: string[];
  if (isIpLiteral(host)) {
    addresses = [host];
  } else {
    const resolve = options.resolve ?? nodeIpResolver;
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, reason: "dns-unavailable" };
    }
    if (addresses.length === 0) return { ok: false, reason: "dns-empty" };
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) return { ok: false, reason: `blocked-address:${address}` };
  }
  return { ok: true, url, addresses };
};
