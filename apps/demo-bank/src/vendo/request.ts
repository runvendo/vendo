/**
 * ENG-333 host workaround: Railway terminates TLS before Next.js, so the
 * Request reaching the door can carry a proxy-internal origin. The door builds
 * every discovery/audience URL from Request.url. Rewrite only that origin from
 * the operator-controlled public base while preserving path, query, headers,
 * method, signal, and body.
 *
 * This intentionally mirrors runvendo/umami PR #1. Remove it when ENG-333
 * teaches the door to honor the configured public base itself.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Gate for demo-only surfaces (e.g. the realtime voice mint) that must not
 * run in a public production deployment: local hosts always pass, and
 * VENDO_DEMO_PUBLIC=1 opts a hosted demo in explicitly. */
export function demoRequestAllowed(req: Request): boolean {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  const host = req.headers.get("host");
  let hostname = host ? (host.split(":")[0] ?? "") : "";
  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      hostname = "";
    }
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export function publicVendoRequest(request: Request): Request {
  const baseUrl = process.env.VENDO_BASE_URL;
  if (!baseUrl) return request;

  const incoming = new URL(request.url);
  const publicUrl = new URL(`${incoming.pathname}${incoming.search}`, baseUrl);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  };
  return new Request(publicUrl, init);
}
