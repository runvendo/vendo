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
