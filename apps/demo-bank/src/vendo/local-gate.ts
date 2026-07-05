/**
 * The demo's request gate, shared by every route that spends real credentials
 * (chat loop, voice ephemeral-token mint, voice⇄Composio bridge): local DEV
 * runs only, unless an operator explicitly opts a deployment in with
 * VENDO_DEMO_PUBLIC=1.
 *
 * The Host header is CLIENT-CONTROLLED and therefore never the sole barrier
 * (security review: `Host: localhost` is trivially spoofable against a
 * deployed server). The un-spoofable check is NODE_ENV: a production build
 * fails closed regardless of headers. The hostname check remains as
 * defense-in-depth for dev servers exposed on a LAN.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function demoRequestAllowed(req: Request): boolean {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return true;
  // Production deployments are closed, full stop — headers can't open them.
  if (process.env.NODE_ENV === "production") return false;
  // Dev-only belt: reject requests addressed to a non-local origin.
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
    { error: "Vendo demo is restricted to local runs. Set VENDO_DEMO_PUBLIC=1 to enable on a deployment." },
    { status: 403 },
  );
}
