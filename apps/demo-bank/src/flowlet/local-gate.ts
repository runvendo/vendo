/**
 * The demo's request gate, shared by every route that spends real credentials
 * (chat loop, voice ephemeral-token mint, voice⇄Composio bridge): local runs
 * only, unless an operator explicitly opts a deployment in with
 * FLOWLET_DEMO_PUBLIC=1. Mirrors chat-handler's original private gate — one
 * source of truth so sibling routes can't drift out of parity again.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function demoRequestAllowed(req: Request): boolean {
  if (process.env.FLOWLET_DEMO_PUBLIC === "1") return true;
  // Prefer the Host header (authoritative for the served origin); fall back to
  // the request URL's hostname when it is absent.
  const host = req.headers.get("host");
  let hostname = host ? host.split(":")[0] : "";
  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      hostname = "";
    }
  }
  return LOCAL_HOSTS.has((hostname ?? "").toLowerCase());
}

export function demoGateResponse(): Response {
  return Response.json(
    { error: "Flowlet demo is restricted to local runs. Set FLOWLET_DEMO_PUBLIC=1 to enable on a deployment." },
    { status: 403 },
  );
}
